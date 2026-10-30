/**
 * Branching and tree navigation: a new session file branched from an earlier user message or from
 * the live leaf for `/btw`, and a move of the leaf within the same file with an optional summary
 * of the branch it leaves.
 *
 * This is a session collaborator. Its only state is the abort controller of a branch summary in
 * progress, and it reaches the session only through {@link SessionBranchSession} and
 * {@link SessionBranchHost}. A branch and a `/btw` branch both end in
 * {@link SessionBranch.#adoptBranchedTranscript}, so the runtime state a branched transcript resets
 * is listed once.
 */
import type { Agent } from "@veyyon/agent-core";
import { resolveTelemetry } from "@veyyon/agent-core";
import {
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, ServiceTier, SimpleStreamOptions } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { BranchSummaryEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { contentText } from "@veyyon/utils/content-text";
import { missingCredentialsMessage } from "../../config/missing-credentials";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type {
	ExtensionRunner,
	SessionBeforeBranchResult,
	SessionBeforeTreeResult,
	TreePreparation,
} from "../../extensibility/extensions";
import { sanitizeAssistantForReparentedHistory } from "../agent-session-message-shapes";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "../messages";
import type { AdvisorRoster } from "./advisor-roster";
import type { CheckpointRuntime } from "./checkpoint-runtime";
import type { ProviderSessions } from "./provider-sessions";
import type { SessionSecrets } from "./session-secrets";
import type { TodoRuntime } from "./todo-runtime";

/** What {@link SessionBranch} reads from the session's public surface. */
export interface SessionBranchSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly isBashRunning: boolean;
	readonly isEvalRunning: boolean;
	readonly isCompacting: boolean;
	readonly isGeneratingHandoff: boolean;
	readonly isRetrying: boolean;
	abort(options: { goalReason: "internal"; reason: string }): Promise<void>;
	buildDisplaySessionContext(): SessionContext;
	leaseSecretRuntime(): Promise<unknown>;
}

/** What {@link SessionBranch} needs from the session beyond its public surface. */
export interface SessionBranchHost {
	readonly checkpoint: CheckpointRuntime;
	readonly todo: TodoRuntime;
	readonly providerSessions: ProviderSessions;
	readonly memory: { rekey(): void };
	readonly advisorRoster: AdvisorRoster;
	readonly secrets: SessionSecrets;
	extensionRunner(): ExtensionRunner | undefined;
	modelRegistry(): ModelRegistry;
	payloadHook(): SimpleStreamOptions["onPayload"];
	readonly sideComplete: GenerateBranchSummaryOptions["completeImpl"];
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	/** Drops the queued next-turn asides and the scheduled hidden next turn. */
	clearNextTurnMessages(): void;
	cancelOwnAsyncJobs(): void;
	cancelPostPromptTasks(): Promise<void>;
	resetMemoryContextForNewTranscript(): void;
	restoreMCPSelectionsForSessionContext(sessionContext: SessionContext): Promise<void>;
}

/** What {@link SessionBranch.navigateTree} reports. */
export interface TreeNavigationResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
	/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
	sessionContext?: SessionContext;
}

/** The text of a persisted user message, or `""` when its content is malformed. */
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	// Persisted entry content arrives loosely typed here; keep the defensive
	// guard for malformed data, then delegate to the shared flattener.
	if (typeof content !== "string" && !Array.isArray(content)) return "";
	return contentText(content, { separator: "" });
}

export class SessionBranch {
	readonly #session: SessionBranchSession;
	readonly #host: SessionBranchHost;
	#summaryAbortController: AbortController | undefined;

	constructor(session: SessionBranchSession, host: SessionBranchHost) {
		this.#session = session;
		this.#host = host;
	}

	/** Cancel the branch summary {@link navigateTree} is generating, if any. */
	abortSummary(): void {
		this.#summaryAbortController?.abort();
	}

	/** Every user message in the session with its entry id, for the branch selector. */
	userMessages(): Array<{ entryId: string; text: string }> {
		const result: Array<{ entryId: string; text: string }> = [];
		for (const entry of this.#session.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;
			const text = extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}
		return result;
	}

	/**
	 * Create a branch from a user message entry. Emits `session_before_branch` (which can cancel or
	 * skip the conversation restore) and `session_branch`.
	 *
	 * @returns the selected message's text for editor pre-fill, and whether a hook cancelled
	 */
	async branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		const session = this.#session;
		const previousSessionFile = session.sessionFile;
		const selectedEntry = session.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = extractUserMessageText(selectedEntry.message.content);

		const before = await this.#emitBeforeBranch(entryId);
		if (before?.cancel) {
			return { selectedText, cancelled: true };
		}
		const skipConversationRestore = before?.skipConversationRestore ?? false;

		// Pending messages are bound to the old session state.
		this.#host.clearNextTurnMessages();

		await session.sessionManager.flush();
		this.#host.cancelOwnAsyncJobs();

		if (!selectedEntry.parentId) {
			await session.sessionManager.newSession({
				parentSession: previousSessionFile,
				// Branching at the root user message discards the transcript but keeps
				// the system prompt and toolset, which is the bulk of the cached
				// prefix. Carry the cache identity so the re-ask reads it.
				providerPromptCacheKey:
					session.sessionManager.getHeader()?.providerPromptCacheKey ?? session.sessionManager.getSessionId(),
			});
		} else {
			session.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#host.checkpoint.rehydrate(session.sessionManager.getBranch());
		// A branch retains a genuine prefix of the source transcript, so the source
		// cache identity stays valid: `createBranchedSession` seeds it onto the new
		// header and the adoption below reads it. No discard is recorded because
		// nothing is discarded — the retained prefix keeps reading the cache the
		// source populated instead of cold-missing every token of it.
		await this.#adoptBranchedTranscript(previousSessionFile, !skipConversationRestore);

		return { selectedText, cancelled: false };
	}

	/**
	 * Branch at the live leaf and append a `/btw` question with its answer to the new branch.
	 * Refuses while a shell or eval run, compaction, handoff or retry is in progress.
	 */
	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
		expectedLeafId?: string,
		expectedSessionId?: string,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const session = this.#session;
		const previousSessionFile = session.sessionFile;
		if (!session.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /btw: session is not persisted");
		}

		const authorized = () =>
			(!expectedSessionId || session.sessionManager.getSessionId() === expectedSessionId) &&
			(!expectedLeafId || session.sessionManager.getLeafId() === expectedLeafId);
		if (!authorized()) {
			throw new Error("Cannot branch /btw: session changed since /btw started");
		}

		const leafId = expectedLeafId ?? session.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot branch /btw: current session has no leaf");
		}
		this.#assertIdleForBtw();

		const before = await this.#emitBeforeBranch(leafId);
		if (before?.cancel) {
			return { cancelled: true, sessionFile: previousSessionFile };
		}

		await this.#host.cancelPostPromptTasks();
		// A hook or a post-prompt task can start work while the awaits above run.
		if (!authorized()) {
			throw new Error("Cannot branch /btw: session changed since /btw started");
		}
		this.#assertIdleForBtw();
		this.#host.clearNextTurnMessages();
		session.agent.replaceQueues([], []);
		if (session.isStreaming) {
			await session.abort({ goalReason: "internal", reason: "branching /btw" });
			session.agent.replaceQueues([], []);
		}
		await session.sessionManager.flush();
		this.#host.cancelOwnAsyncJobs();

		session.sessionManager.createBranchedSession(leafId);

		this.#host.checkpoint.rehydrate(session.sessionManager.getBranch());
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage(sanitizeAssistantForReparentedHistory(assistantMessage));
		// `/btw` branches at the live leaf, so the entire retained prefix is
		// byte-identical to what the source session just cached. The adoption below
		// takes the branch header's inherited cache identity instead of routing the
		// next turn under the freshly minted session id, which would cold-miss the
		// whole transcript.
		await this.#adoptBranchedTranscript(previousSessionFile, true);

		return { cancelled: false, sessionFile: session.sessionFile };
	}

	/**
	 * Navigate to a different node in the session tree. Unlike {@link branch}, which creates a new
	 * session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether to summarize the abandoned branch
	 * @param options.customInstructions Custom instructions for the summarizer
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<TreeNavigationResult> {
		const session = this.#session;
		const host = this.#host;
		const extensionRunner = host.extensionRunner();
		const oldLeafId = session.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !session.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = session.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			session.sessionManager,
			oldLeafId,
			targetId,
		);

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		this.#summaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		if (extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#summaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				this.#summaryAbortController = undefined;
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = session.model!;
			const modelRegistry = host.modelRegistry();
			const apiKey = await modelRegistry.getApiKey(model, session.sessionId);
			if (!apiKey) {
				throw new Error(missingCredentialsMessage(model.provider, model.id, "the branch summary model"));
			}
			await session.leaseSecretRuntime();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: modelRegistry.resolver(model, session.sessionId),
				signal: this.#summaryAbortController.signal,
				sessionId: session.sessionId,
				promptCacheKey: session.agent.promptCacheKey ?? session.sessionId,
				customInstructions: options.customInstructions,
				reserveTokens: session.settings.get("branchSummary.reserveTokens"),
				metadata: session.agent.metadataForProvider(model.provider),
				convertToLlm,
				resolveObfuscateProviderText: () => host.secrets.snapshotProviderTextRedactor(),
				onPayload: host.payloadHook(),
				telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId),
				// Same per-provider concurrency cap rationale as the compaction
				// path (chatgpt-codex review on #3751).
				completeImpl: host.sideComplete,
				serviceTier: host.effectiveServiceTier(model),
			});
			this.#summaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			// Hook supplied the summary directly: the signal was only needed for the
			// session_before_tree emit above, so release it now.
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
			this.#summaryAbortController = undefined;
		} else {
			// No summarization requested (or nothing to summarize): the controller was
			// only ever used for the session_before_tree signal above.
			this.#summaryAbortController = undefined;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = contentText(targetEntry.content, { separator: "" });
		} else {
			// Non-user message (or a user-invoked skill-prompt injection): land the
			// leaf on the selected node so it stays on the active branch. Skill
			// prompts are custom_message entries but must not be re-editable — their
			// content is a large expanded body, not a user turn (issue #5374).
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary). The summary is attached at the
		// navigation target position (newLeafId), not the old branch.
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = session.sessionManager.branchWithSummary(
				newLeafId,
				summaryText,
				summaryDetails,
				fromExtension,
			);
			summaryEntry = session.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			session.sessionManager.resetLeaf();
		} else {
			session.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = session.sessionManager.buildSessionContext({ activeProvider: session.model?.provider });
		// RENDER PATH, and async: this rebuilds the agent's display state after a
		// branch move, so a throw left the TUI with no transcript at all. Await the
		// refresh a stale revision needs, then degrade per string.
		await host.secrets.awaitRefreshForRender(host.secrets.messagesCarryLivePlaceholder(stateContext.messages));
		const displayContext = host.secrets.deobfuscateSessionContextForDisplay(stateContext);
		await host.restoreMCPSelectionsForSessionContext(displayContext);
		session.agent.replaceMessages(displayContext.messages);
		host.checkpoint.rehydrate(session.sessionManager.getBranch());
		host.advisorRoster.resetSessionState();
		host.todo.syncFromBranch();
		host.providerSessions.closeCodexForHistoryRewrite(session.model);

		this.#summaryAbortController = undefined;

		// Only handlers can mutate session entries, so skip the emit and the context
		// rebuild when no `session_tree` handler is registered.
		if (extensionRunner?.hasHandlers("session_tree")) {
			await extensionRunner.emit({
				type: "session_tree",
				newLeafId: session.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = session.sessionManager.buildSessionContext({ activeProvider: session.model?.provider });
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/** Emits `session_before_branch` when a handler is registered, and returns its result. */
	async #emitBeforeBranch(entryId: string): Promise<SessionBeforeBranchResult | undefined> {
		const extensionRunner = this.#host.extensionRunner();
		if (!extensionRunner?.hasHandlers("session_before_branch")) return undefined;
		return (await extensionRunner.emit({
			type: "session_before_branch",
			entryId,
		})) as SessionBeforeBranchResult | undefined;
	}

	#assertIdleForBtw(): void {
		const session = this.#session;
		if (
			session.isBashRunning ||
			session.isEvalRunning ||
			session.isCompacting ||
			session.isGeneratingHandoff ||
			session.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}
	}

	/**
	 * Reset the runtime state a branched transcript invalidates, adopt the branch header's
	 * inherited prompt-cache identity, emit `session_branch`, and load the branch into the agent
	 * unless `restoreConversation` is false.
	 */
	async #adoptBranchedTranscript(
		previousSessionFile: string | undefined,
		restoreConversation: boolean,
	): Promise<void> {
		const session = this.#session;
		const host = this.#host;
		host.todo.syncFromBranch();
		host.providerSessions.freshId = undefined;
		host.providerSessions.adoptInheritedCacheKey();
		host.providerSessions.sync();
		host.memory.rekey();
		host.resetMemoryContextForNewTranscript();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = session.buildDisplaySessionContext();
		await host.restoreMCPSelectionsForSessionContext(sessionContext);

		const extensionRunner = host.extensionRunner();
		if (extensionRunner) {
			await extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (restoreConversation) {
			session.agent.replaceMessages(sessionContext.messages);
			host.advisorRoster.resetSessionState();
			host.providerSessions.closeCodexForHistoryRewrite(session.model);
		}
	}
}
