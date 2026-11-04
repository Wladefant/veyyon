/**
 * The handoff: a oneshot summary of the live conversation, written through the same request
 * pipeline as a live turn so it reads the provider prompt cache, then a new session file seeded
 * with that summary, the deterministic `<files>` block and the carried todo phases.
 *
 * This is a session collaborator. Its state is the abort controller of a handoff in progress and
 * the timestamp of the assistant message that settled while one was running, whose post-turn
 * maintenance the session skips. It reaches the session only through
 * {@link SessionHandoffSession} and {@link SessionHandoffHost}.
 */
import * as path from "node:path";
import type { Agent, AgentMessage, ThinkingLevel } from "@veyyon/agent-core";
import { resolveTelemetry } from "@veyyon/agent-core";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessages,
	generateHandoffFromContext,
	renderHandoffPrompt,
	upsertFileOperations,
} from "@veyyon/agent-core/compaction";
import { countTokens } from "@veyyon/agent-core/tokenizer";
import type { AssistantMessage, Message, Model, ServiceTier, SimpleStreamOptions } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, isAbortError, logger, Snowflake } from "@veyyon/utils";
import { missingCredentialsMessage } from "../../config/missing-credentials";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExtensionRunner, SessionBeforeSwitchResult } from "../../extensibility/extensions";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/agent/todo";
import type { HandoffResult, SessionHandoffOptions } from "../agent-session-types";
import { configuredCompactionEfforts } from "../agent-session-model-targets";
import type { CheckpointRuntime } from "./checkpoint-runtime";
import type { ProviderSessions } from "./provider-sessions";
import type { SessionSecrets } from "./session-secrets";
import type { TodoRuntime } from "./todo-runtime";

/** What {@link SessionHandoff} reads from the session's public surface. */
export interface SessionHandoffSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly thinkingLevel: ThinkingLevel | undefined;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): Promise<SimpleStreamOptions>;
	buildDisplaySessionContext(): SessionContext;
}

/** What {@link SessionHandoff} needs from the session beyond its public surface. */
export interface SessionHandoffHost {
	readonly checkpoint: CheckpointRuntime;
	readonly todo: TodoRuntime;
	readonly providerSessions: ProviderSessions;
	readonly memory: { rekey(): void };
	readonly secrets: SessionSecrets;
	readonly sideComplete: SideCompleteImpl;
	extensionRunner(): ExtensionRunner | undefined;
	modelRegistry(): ModelRegistry;
	/** The base system prompt, without any per-turn `before_agent_start` override. */
	baseSystemPrompt(): string[];
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	/** Drops the queued next-turn asides and the scheduled hidden next turn. */
	clearNextTurnMessages(): void;
	cancelOwnAsyncJobs(): void;
	/** Releases what the conversation being left holds: spawned agents, registry scope, eval kernels. */
	endConversation(): Promise<void>;
	resetMemoryContextForNewTranscript(): void;
	resetAllAdvisorRuntimes(): void;
}

/** The custom message a new session opens with: the handoff document and how to read it. */
function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

export class SessionHandoff {
	readonly #session: SessionHandoffSession;
	readonly #host: SessionHandoffHost;
	#abortController: AbortController | undefined = undefined;
	#skipMaintenanceAssistantTimestamp: number | undefined = undefined;

	constructor(session: SessionHandoffSession, host: SessionHandoffHost) {
		this.#session = session;
		this.#host = host;
	}

	/** Whether a handoff document is being generated. */
	get active(): boolean {
		return this.#abortController !== undefined;
	}

	/** Cancels the handoff in progress, if any. */
	abort(): void {
		this.#abortController?.abort();
	}

	/**
	 * Records an assistant message that settled while a handoff was running: the handoff
	 * replaces the transcript, so the post-turn maintenance for that message is skipped.
	 */
	noteAssistantSettled(message: AssistantMessage): void {
		if (this.#abortController) {
			this.#skipMaintenanceAssistantTimestamp = message.timestamp;
		}
	}

	/** Whether post-turn maintenance for the message at `timestamp` is skipped; consumes the mark. */
	takeMaintenanceSkip(timestamp: number): boolean {
		if (this.#skipMaintenanceAssistantTimestamp !== timestamp) return false;
		this.#skipMaintenanceAssistantTimestamp = undefined;
		return true;
	}

	/**
	 * Generates a handoff document with a oneshot LLM call, then starts a new session with it.
	 *
	 * @returns The document and its saved path, or `undefined` when generation produced nothing
	 *   or a `session_before_switch` handler cancelled the switch.
	 */
	async run(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		const session = this.#session;
		const host = this.#host;
		const entries = session.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipMaintenanceAssistantTimestamp = undefined;

		const handoffAbortController = new AbortController();
		this.#abortController = handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}

			const model = options?.summaryModel ?? session.model;
			if (!model) {
				throw new Error(
					"No model selected, so the handoff summary cannot be written. Fix: in an interactive veyyon session run /model to choose one; from a terminal pass `--model <provider>/<id>`. `veyyon models` lists what this profile can reach.",
				);
			}
			const modelRegistry = host.modelRegistry();
			const apiKey = await modelRegistry.getApiKey(model, session.sessionId);
			if (!apiKey) {
				throw new Error(missingCredentialsMessage(model.provider, model.id, "the handoff summary model"));
			}

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = session.sessionId;
			// The loop sends `promptCacheKey` (providerPromptCacheKey) and falls back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from session.sessionId (tan/agent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
			const agent = session.agent;
			const handoffPromptCacheKey = agent.promptCacheKey ?? agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(host.secrets.obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...agent.state.messages,
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffLlmMessages = await session.convertMessagesToLlm(handoffSnapshot, handoffSignal);
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the handoff seeds a fresh session and must not carry prompt-specific
			// hook state.
			const handoffContext = await agent.buildSideRequestContext(handoffLlmMessages, host.baseSystemPrompt());
			const handoffStreamOptions = await session.prepareSimpleStreamOptions(
				{
					apiKey: modelRegistry.resolver(model, cacheSessionId),
					sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
					promptCacheKey: handoffPromptCacheKey,
					preferWebsockets: false,
					serviceTier: host.effectiveServiceTier(model),
					hideThinkingSummary: agent.hideThinkingSummary,
					initiatorOverride: "agent",
					signal: handoffSignal,
				},
				model.provider,
			);
			const rawHandoffText = await generateHandoffFromContext(host.secrets.obfuscateContext(handoffContext), model, {
				streamOptions: handoffStreamOptions,
				completeImpl: host.sideComplete,
				telemetry: resolveTelemetry(agent.telemetry, session.sessionId),
				// Honor the /model thinking selection on the handoff path. Clamped
				// per-model inside generateHandoffFromContext via resolveCompactionEffort
				// so unsupported-effort models don't trip requireSupportedEffort.
				thinkingLevel: options?.summaryModel
					? (configuredCompactionEfforts(session.settings, host.modelRegistry().getAvailable()).get(
							`${model.provider}/${model.id}`,
						) ?? session.thinkingLevel)
					: session.thinkingLevel,
			});
			// Append the same deterministic `<files>` block the summary strategy gets.
			// It is machine-generated from the live messages, costs no LLM work, and is
			// byte-identical across models.
			const handoffFileOps = createFileOps();
			extractFileOpsFromMessages(agent.state.messages, handoffFileOps);
			const handoffFileLists = computeFileLists(handoffFileOps);
			const handoffText = upsertFileOperations(
				host.secrets.expandForDisplay(rawHandoffText),
				handoffFileLists.readFiles,
				handoffFileLists.modifiedFiles,
				handoffFileOps.read,
			);
			if (options?.compactSummary) {
				if (countTokens(handoffText) > 5_000) {
					throw new Error("COMPACT handoff exceeds the 5,000-token estimate; keeping the original transcript");
				}
				for (const heading of [
					"# COMPACT",
					"## Goal",
					"## State",
					"## Open steps",
					"## Repository",
					"## Tests",
					"## Files",
				]) {
					if (!handoffText.split("\n").some(line => line.trim() === heading)) {
						throw new Error(`COMPACT handoff is missing ${heading}; keeping the original transcript`);
					}
				}
			}
			const carriedTodoPhases = host.todo.phases();

			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (!handoffText) {
				return undefined;
			}

			const previousSessionFile = session.sessionFile;
			const extensionRunner = host.extensionRunner();
			if (extensionRunner?.hasHandlers("session_before_switch")) {
				const result = (await extensionRunner.emit({
					type: "session_before_switch",
					reason: "handoff",
				})) as SessionBeforeSwitchResult | undefined;

				if (result?.cancel) {
					options?.onSwitchCancelled?.();
					return undefined;
				}
			}
			const sessionManager = session.sessionManager;
			await sessionManager.flush();
			if (!options?.preserveAgentLineage) {
				host.cancelOwnAsyncJobs();
			}
			const childInit = options?.preserveAgentLineage
				? entries.findLast(entry => entry.type === "session_init")
				: undefined;
			await sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);
			if (childInit?.type === "session_init") {
				sessionManager.appendSessionInit({
					systemPrompt: childInit.systemPrompt,
					task: childInit.task,
					tools: childInit.tools,
					outputSchema: childInit.outputSchema,
					spawns: childInit.spawns,
					readSummarize: childInit.readSummarize,
					maxNestedSpawnDepth: childInit.maxNestedSpawnDepth,
				});
			}
			// A handoff continues the work in a NEW transcript. The pre-handoff
			// spawned agents wrote into the old one and their jobs were just cancelled;
			// leaving them registered would list them under the new conversation, and
			// no cell of the new transcript reaches the old one's eval kernels.
			await host.endConversation();

			host.checkpoint.clear();
			// agent.reset() clears the core steering/follow-up queues. Preserve any queued
			// steers/follow-ups (RPC/SDK steer()/followUp() issued during the handoff, or a
			// pre-loader TUI steer) so they survive into the post-handoff session instead of
			// being silently dropped. Capture is synchronous immediately before reset and
			// restore is synchronous immediately after — no await gap — so a steer arriving
			// later (during ensureOnDisk/Bun.write below) appends to the restored queue
			// rather than being clobbered.
			if (options?.preserveAgentLineage) {
				// The tool loop still owns the streaming state and its queues.
				agent.replaceMessages([]);
			} else {
				const preservedSteering = agent.peekSteeringQueue().slice();
				const preservedFollowUp = agent.peekFollowUpQueue().slice();
				agent.reset();
				agent.replaceQueues(preservedSteering, preservedFollowUp);
			}
			host.providerSessions.freshId = undefined;
			host.providerSessions.sync();
			host.memory.rekey();
			host.resetMemoryContextForNewTranscript();
			host.clearNextTurnMessages();
			host.todo.resetForNewContext();

			sessionManager.appendCustomMessageEntry(
				"handoff",
				createHandoffContext(handoffText),
				true,
				undefined,
				"agent",
			);
			if (carriedTodoPhases.length > 0) {
				// Todos survive a handoff through their own persisted snapshot entry, the
				// same one `/todo` writes, so a reload of the new transcript still finds them.
				sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: carriedTodoPhases });
			}
			await sessionManager.ensureOnDisk();
			let savedPath: string | undefined;
			if (options?.autoTriggered && session.settings.get("compaction.handoffSaveToDisk")) {
				savedPath = await this.#saveDocument(handoffText);
			}

			// Rebuild agent messages from session
			const sessionContext = session.buildDisplaySessionContext();
			agent.replaceMessages(sessionContext.messages);
			host.resetAllAdvisorRuntimes();
			host.todo.syncFromBranch();
			if (extensionRunner) {
				await extensionRunner.emit({
					type: "session_switch",
					reason: "handoff",
					previousSessionFile,
				});
			}

			return { document: handoffText, savedPath };
		} catch (error) {
			if (handoffSignal.aborted || isAbortError(error)) {
				throw new Error("Handoff cancelled");
			}
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#abortController = undefined;
		}
	}

	/** Writes the document into the session's artifacts directory; `undefined` when it cannot. */
	async #saveDocument(handoffText: string): Promise<string | undefined> {
		const artifactsDir = this.#session.sessionManager.getArtifactsDir();
		if (!artifactsDir) {
			logger.debug("Skipping handoff document save because session is not persisted");
			return undefined;
		}
		const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
		try {
			await Bun.write(handoffFilePath, `${handoffText}\n`);
			return handoffFilePath;
		} catch (error) {
			logger.warn("Failed to save handoff document to disk", {
				path: handoffFilePath,
				error: errorMessage(error),
			});
			return undefined;
		}
	}
}
