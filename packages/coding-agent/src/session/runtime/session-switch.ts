/**
 * Session switching: loading another transcript into a live session, and putting the previous
 * transcript and runtime back when loading it fails part way.
 *
 * This is a session collaborator. It holds no state between switches and reaches the session only
 * through {@link SessionSwitchSession} and {@link SessionSwitchHost}. Every in-process switch (the
 * picker, `/resume`, an extension, RPC `switch_session`, a reload) runs through
 * {@link SessionSwitch.switchTo}, serialized behind the session's scope transitions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@veyyon/agent-core";
import type { Model, ServiceTierByFamily } from "@veyyon/ai";
import { createInterruptedTurnAbortMessage } from "@veyyon/kernel/session/exit-diagnostics";
import { getRestorableSessionModels, type SessionContext } from "@veyyon/kernel/session/session-context";
import { foreignSessionFileProfile } from "@veyyon/kernel/session/session-listing";
import type { SessionManager, SessionManagerStateSnapshot } from "@veyyon/kernel/session/session-manager";
import { errorMessage, getActiveProfileOrDefault, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExtensionRunner, SessionBeforeSwitchResult } from "../../extensibility/extensions";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../../thinking";
import { didSessionMessagesChange } from "../provider-replay-projection";
import { startingServiceTierByFamily } from "../startup-model";
import type { AdvisorRoster } from "./advisor-roster";
import type { CheckpointRuntime, CheckpointSnapshot } from "./checkpoint-runtime";
import type { NextTurnSnapshot } from "./next-turn-messages";
import type { ProviderSessions } from "./provider-sessions";
import type { ProviderWire } from "./provider-wire";
import type { SessionScope } from "./session-scope";
import type { ResolvedThinkingState, ThinkingRuntime } from "./thinking-runtime";
import type { TodoRuntime } from "./todo-runtime";
import type { ToolDiscovery } from "./tool-discovery";

/** Session fields a switch clears or replaces, and a failed switch puts back. */
export interface SwitchedSessionFields {
	readonly nextTurn: NextTurnSnapshot;
	readonly baseSystemPrompt: string[];
	readonly serviceTierByFamily: ServiceTierByFamily;
}

/** What {@link SessionSwitch} reads from the session's public surface. */
export interface SessionSwitchSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	abort(options: { goalReason: "internal" }): Promise<void>;
	buildDisplaySessionContext(): SessionContext;
}

/** What {@link SessionSwitch} needs from the session beyond its public surface. */
export interface SessionSwitchHost {
	readonly scope: SessionScope;
	readonly wire: ProviderWire;
	readonly providerSessions: ProviderSessions;
	readonly memory: { rekey(): void };
	readonly discovery: ToolDiscovery;
	readonly checkpoint: CheckpointRuntime;
	readonly thinking: ThinkingRuntime;
	readonly todo: TodoRuntime;
	readonly advisorRoster: AdvisorRoster;
	extensionRunner(): ExtensionRunner | undefined;
	modelRegistry(): ModelRegistry;
	/** Runs `run` with agent events detached, and reattaches them whether it settles or throws. */
	whileDisconnectedFromAgent<T>(run: () => Promise<T>): Promise<T>;
	/** Runs the mode reconciler installed for completed switches, if one is installed. */
	reconcileAfterSwitch(): Promise<void> | undefined;
	/** Copies of the fields in {@link SwitchedSessionFields}. */
	captureFields(): SwitchedSessionFields;
	restoreFields(fields: SwitchedSessionFields): void;
	/** Drops the queued next-turn asides and the scheduled hidden next turn. */
	clearNextTurnMessages(): void;
	setServiceTierByFamily(byFamily: ServiceTierByFamily): void;
	restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void>;
	setModelWithProviderSessionReset(model: Model): void;
	resetMemoryContextForNewTranscript(): void;
	/** Releases what the conversation being left holds: spawned agents, registry scope, eval kernels. */
	endConversation(): Promise<void>;
	resetAllAdvisorRuntimes(): void;
}

/** A transcript model reference, `provider/id` split at its first slash. */
interface TranscriptModelTarget {
	readonly provider: string;
	readonly id: string;
}

/** The first of `targets` that `available` lists, with its index; index -1 when none is. */
function firstListed(
	available: readonly Model[],
	targets: readonly TranscriptModelTarget[],
): { index: number; model: Model | undefined } {
	for (let index = 0; index < targets.length; index++) {
		const target = targets[index]!;
		const model = available.find(m => m.provider === target.provider && m.id === target.id);
		if (model) return { index, model };
	}
	return { index: -1, model: undefined };
}

/**
 * The runtime a session switch puts back when loading the target transcript fails. Message arrays
 * hold the original objects: the switch replaces them wholesale, and extension metadata that is
 * valid to persist is not always structured-cloneable.
 */
interface TranscriptRollback {
	readonly sessionState: SessionManagerStateSnapshot;
	/**
	 * Built only for a same-session reload, which compares it against the reloaded transcript to
	 * detect rollback edits. A different-session switch skips it: on a large session it materializes
	 * every legacy compaction frame and remote-compaction replacement history (issue #3846). The
	 * rollback rebuilds it from the restored state when it needs one.
	 */
	readonly sessionContext: SessionContext | undefined;
	readonly agentMessages: AgentMessage[];
	readonly steeringMessages: AgentMessage[];
	readonly followUpMessages: AgentMessage[];
	readonly fields: SwitchedSessionFields;
	readonly model: Model | undefined;
	readonly thinking: ResolvedThinkingState;
	readonly selectedMCPToolNames: Set<string>;
	readonly fallbackSelectedMCPToolNames: string[] | undefined;
	readonly tools: AgentState["tools"];
	readonly systemPrompt: AgentState["systemPrompt"];
	readonly freshProviderSessionId: string | undefined;
	readonly inheritedProviderPromptCacheKey: string | undefined;
	/**
	 * The value that reaches the wire. The switch rewrites it together with the inherited key, so
	 * restoring only the inherited key leaves a failed switch sending the target's `prompt_cache_key`.
	 */
	readonly agentPromptCacheKey: string | undefined;
	/** The success path rehydrates checkpoint state from the target branch. */
	readonly checkpoint: CheckpointSnapshot;
	readonly wirePathRoots: readonly string[];
	/** Set before the cwd-scoped runtime moves, so a rescope that fails partway is still undone. */
	scopeTransitionAttempted: boolean;
}

/** Fields every warning logged while rolling back a failed session switch includes. */
interface SessionSwitchLogFields {
	previousSessionFile: string | undefined;
	targetSessionFile: string;
}

export class SessionSwitch {
	readonly #session: SessionSwitchSession;
	readonly #host: SessionSwitchHost;

	constructor(session: SessionSwitchSession, host: SessionSwitchHost) {
		this.#session = session;
		this.#host = host;
	}

	/**
	 * Switch to the session file at `sessionPath`, after every scope transition started before this
	 * call. Aborts the current operation, loads messages, restores model and thinking. Listeners are
	 * preserved and continue receiving events.
	 * @returns true if the switch completed, false if a `session_before_switch` hook cancelled it
	 */
	switchTo(sessionPath: string): Promise<boolean> {
		return this.#host.scope.run(() => this.#switch(sessionPath));
	}

	async #switch(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.#session.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Another profile's transcript continues in that profile, never under this one's settings and
		// credentials.
		const owner = switchingToDifferentSession ? foreignSessionFileProfile(sessionPath) : undefined;
		if (owner !== undefined) {
			throw new Error(
				`Session ${sessionPath} belongs to profile "${owner}". Run \`veyyon --resume ${sessionPath}\` to continue it in that profile, or \`veyyon --profile ${getActiveProfileOrDefault()} --resume ${sessionPath}\` to fork it into this one.`,
			);
		}
		const extensionRunner = this.#host.extensionRunner();
		if (extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.#host.whileDisconnectedFromAgent(() =>
			this.#adoptSessionTranscript(sessionPath, previousSessionFile, switchingToDifferentSession),
		);
		try {
			await this.#host.reconcileAfterSwitch();
		} catch (error) {
			logger.warn("Failed to reconcile session mode after switch", {
				targetSessionFile: sessionPath,
				error: errorMessage(error),
			});
		}
		return true;
	}

	/**
	 * Loads `sessionPath` into this session: flushes the outgoing transcript, then adopts the
	 * target's cwd, messages, model, thinking selector and service tier. A failure restores the
	 * previous transcript and runtime and rethrows. Runs with agent events detached.
	 */
	async #adoptSessionTranscript(
		sessionPath: string,
		previousSessionFile: string | undefined,
		switchingToDifferentSession: boolean,
	): Promise<void> {
		await this.#session.abort({ goalReason: "internal" });

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.#session.sessionManager.flush();
		const rollback = this.#captureTranscriptRollback(previousSessionFile, switchingToDifferentSession);

		this.#session.agent.clearAllQueues();
		this.#host.clearNextTurnMessages();

		try {
			await this.#enterTargetTranscript(sessionPath, rollback);
			await this.#loadTargetTranscript(
				sessionPath,
				previousSessionFile,
				switchingToDifferentSession,
				rollback.sessionContext,
			);
		} catch (error) {
			await this.#rollBackTranscriptAdoption(error, rollback, {
				previousSessionFile,
				targetSessionFile: sessionPath,
			});
		}
	}

	#captureTranscriptRollback(
		previousSessionFile: string | undefined,
		switchingToDifferentSession: boolean,
	): TranscriptRollback {
		const { agent, sessionManager } = this.#session;
		const host = this.#host;
		return {
			sessionState: sessionManager.captureState(),
			sessionContext: switchingToDifferentSession ? undefined : this.#session.buildDisplaySessionContext(),
			agentMessages: [...agent.state.messages],
			steeringMessages: [...agent.peekSteeringQueue()],
			followUpMessages: [...agent.peekFollowUpQueue()],
			fields: host.captureFields(),
			model: this.#session.model,
			thinking: host.thinking.snapshot(),
			selectedMCPToolNames: host.discovery.snapshotSelectedMCP(),
			tools: [...agent.state.tools],
			systemPrompt: agent.state.systemPrompt,
			freshProviderSessionId: host.providerSessions.freshId,
			inheritedProviderPromptCacheKey: host.providerSessions.inheritedCacheKey,
			agentPromptCacheKey: agent.promptCacheKey,
			fallbackSelectedMCPToolNames: previousSessionFile
				? host.discovery.sessionDefaults(previousSessionFile)
				: undefined,
			checkpoint: host.checkpoint.snapshot(),
			wirePathRoots: host.wire.roots,
			scopeTransitionAttempted: false,
		};
	}

	/** Points the session manager at `sessionPath` and moves the cwd-scoped runtime to its directory. */
	async #enterTargetTranscript(sessionPath: string, rollback: TranscriptRollback): Promise<void> {
		const sessionManager = this.#session.sessionManager;
		await sessionManager.setSessionFile(sessionPath);
		await this.#adoptRecordedTranscriptCwd();
		const targetCwd = sessionManager.getCwd();
		if (path.resolve(targetCwd) === path.resolve(rollback.sessionState.cwd)) return;
		rollback.scopeTransitionAttempted = true;
		await this.#host.scope.rescope(targetCwd);
		this.#host.wire.rootAt(targetCwd);
	}

	/**
	 * `setSessionFile` normally adopts the header cwd itself. Reassert the recorded directory when it
	 * is reachable, so the switch owns the complete transcript and runtime transition rather than
	 * depending on how the manager was constructed. An unreachable recorded cwd (a moved or deleted
	 * worktree) keeps the current root; a failure to set a reachable one fails the switch.
	 */
	async #adoptRecordedTranscriptCwd(): Promise<void> {
		const sessionManager = this.#session.sessionManager;
		const recordedCwd = sessionManager.getHeader()?.cwd;
		if (!recordedCwd || path.resolve(recordedCwd) === path.resolve(sessionManager.getCwd())) return;
		let reachable = false;
		try {
			reachable = (await fs.promises.stat(recordedCwd)).isDirectory();
		} catch {
			// Unreachable: keep the current root.
		}
		if (reachable) await sessionManager.setCwd(recordedCwd, { validate: false });
	}

	/**
	 * Adopts the transcript the session manager now holds: provider session identity, messages, MCP
	 * selections, checkpoints, model, thinking selector and service tier.
	 */
	async #loadTargetTranscript(
		sessionPath: string,
		previousSessionFile: string | undefined,
		switchingToDifferentSession: boolean,
		previousSessionContext: SessionContext | undefined,
	): Promise<void> {
		const host = this.#host;
		if (switchingToDifferentSession) {
			host.providerSessions.freshId = undefined;
			host.providerSessions.clearInheritedCacheKey("session-switch");
			host.providerSessions.adoptInheritedCacheKey();
		}
		host.providerSessions.sync();
		host.memory.rekey();

		const sessionContext = this.#session.buildDisplaySessionContext();
		const didReloadConversationChange =
			previousSessionContext !== undefined &&
			didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
		await host.restoreMCPSelectionsForSessionContext(sessionContext, {
			fallbackSelectedMCPToolNames: host.discovery.sessionDefaults(sessionPath),
		});
		host.checkpoint.rehydrate(this.#session.sessionManager.getBranch());

		const extensionRunner = host.extensionRunner();
		if (extensionRunner) {
			await extensionRunner.emit({ type: "session_switch", reason: "resume", previousSessionFile });
		}

		this.#session.agent.replaceMessages(sessionContext.messages);
		host.advisorRoster.resetSessionState();
		host.todo.syncFromBranch();
		// The board just came back from the branch, so every latch describing
		// the pre-switch board (including a failed write against it) is about a
		// board this session no longer holds.
		host.todo.resetForNewContext();
		if (switchingToDifferentSession) {
			host.providerSessions.closeAll("session switch");
		} else if (didReloadConversationChange) {
			host.providerSessions.closeAll("session reload");
		}

		await this.#restoreTranscriptModel(sessionContext, switchingToDifferentSession);
		const closedTurnContext = this.#closeInterruptedTranscriptTurn();
		this.#restoreTranscriptThinkingAndTier(closedTurnContext ?? sessionContext);

		if (switchingToDifferentSession) {
			host.resetMemoryContextForNewTranscript();
			await host.endConversation();
		}
	}

	/** Selects the newest model the transcript recorded that is still available, if any. */
	async #restoreTranscriptModel(sessionContext: SessionContext, switchingToDifferentSession: boolean): Promise<void> {
		const match = await this.#findRestorableTranscriptModel(sessionContext);
		if (!match) return;
		const currentModel = this.#session.model;
		const shouldResetProviderState =
			switchingToDifferentSession ||
			(currentModel !== undefined &&
				(currentModel.provider !== match.provider ||
					currentModel.id !== match.id ||
					currentModel.api !== match.api));
		if (shouldResetProviderState) {
			this.#host.setModelWithProviderSessionReset(match);
		} else {
			this.#session.agent.setModel(match);
		}
	}

	/**
	 * The first transcript model the registry lists. The providers of preferred models it does not
	 * list are discovered first: a model only a provider's listing has is absent until the
	 * background refresh started at launch completes, and a switch inside that window would keep
	 * the current model.
	 */
	async #findRestorableTranscriptModel(sessionContext: SessionContext): Promise<Model | undefined> {
		const targets = getRestorableSessionModels(
			sessionContext.models,
			this.#session.sessionManager.getLastModelChangeRole(),
		).flatMap(value => {
			const slashIdx = value.indexOf("/");
			return slashIdx > 0 ? [{ provider: value.slice(0, slashIdx), id: value.slice(slashIdx + 1) }] : [];
		});
		if (targets.length === 0) return undefined;
		const registry = this.#host.modelRegistry();
		const listed = firstListed(registry.getAvailable(), targets);
		const preferred = targets.slice(0, listed.index < 0 ? targets.length : listed.index);
		if (preferred.length === 0) return listed.model;
		const providers = new Set(preferred.map(target => target.provider));
		await Promise.all(Array.from(providers, provider => registry.refreshProvider(provider, "online-if-uncached")));
		return firstListed(registry.getAvailable(), targets).model;
	}

	/**
	 * Appends a terminal assistant record when the transcript's last process exit left its turn open.
	 * Returns the rebuilt context when it appended one.
	 */
	#closeInterruptedTranscriptTurn(): SessionContext | undefined {
		const model = this.#session.model;
		if (!model) return undefined;
		const sessionManager = this.#session.sessionManager;
		const interruptedTurnAbort = createInterruptedTurnAbortMessage(sessionManager.getBranch(), {
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		if (!interruptedTurnAbort) return undefined;
		sessionManager.appendMessage(interruptedTurnAbort);
		const sessionContext = this.#session.buildDisplaySessionContext();
		this.#session.agent.replaceMessages(sessionContext.messages);
		return sessionContext;
	}

	/**
	 * Restores the thinking selector and service tier the transcript recorded, or the configured
	 * defaults when it recorded none. Each thinking change persists the configured selector (`auto`
	 * or a concrete level), so an `auto` session resumes in auto mode and reclassifies the next turn
	 * instead of freezing at the last resolved level. Entries written before the `configured` field
	 * existed fall back to their concrete level. With no thinking entry the global default applies,
	 * so a fresh session still classifies its first turn.
	 */
	#restoreTranscriptThinkingAndTier(sessionContext: SessionContext): void {
		const { sessionManager, settings } = this.#session;
		const branch = sessionManager.getBranch();
		const hasThinkingEntry = branch.some(entry => entry.type === "thinking_level_change");
		const defaultThinkingLevel = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
		const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
			hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
				? sessionContext.configuredThinkingLevel === AUTO_THINKING
					? AUTO_THINKING
					: (sessionContext.thinkingLevel as ThinkingLevel | undefined)
				: defaultThinkingLevel;
		this.#host.thinking.seed(restoredThinkingLevel);
		this.#host.setServiceTierByFamily(
			startingServiceTierByFamily(
				branch.some(entry => entry.type === "service_tier_change"),
				sessionContext,
				settings,
			),
		);
	}

	/**
	 * Puts back the transcript and runtime `rollback` captured, then rethrows `error`. A failure to
	 * restore the cwd-scoped runtime or the MCP selections joins `error` in an `AggregateError`.
	 */
	async #rollBackTranscriptAdoption(
		error: unknown,
		rollback: TranscriptRollback,
		logFields: SessionSwitchLogFields,
	): Promise<never> {
		const { agent, sessionManager } = this.#session;
		const host = this.#host;
		sessionManager.restoreState(rollback.sessionState);
		host.wire.restoreRoots(rollback.wirePathRoots);
		const restoreScopeError = rollback.scopeTransitionAttempted
			? await this.#restoreScopeAfterFailedSwitch(rollback.sessionState.cwd, logFields)
			: undefined;

		host.providerSessions.freshId = rollback.freshProviderSessionId;
		host.providerSessions.sync(rollback.sessionState.sessionId);
		host.memory.rekey();
		const restoreMcpError = await this.#restoreMCPAfterFailedSwitch(rollback, logFields);
		host.restoreFields(rollback.fields);
		agent.setSystemPrompt(rollback.systemPrompt);
		agent.replaceMessages(rollback.agentMessages);
		agent.replaceQueues(rollback.steeringMessages, rollback.followUpMessages);
		host.providerSessions.restoreCacheKeys(rollback.inheritedProviderPromptCacheKey, rollback.agentPromptCacheKey);
		host.checkpoint.restore(rollback.checkpoint);
		if (rollback.model) {
			agent.setModel(rollback.model);
		}
		host.thinking.restore(rollback.thinking);
		host.todo.syncFromBranch();
		host.resetAllAdvisorRuntimes();
		if (restoreScopeError || restoreMcpError) {
			throw new AggregateError(
				[error, restoreScopeError, restoreMcpError].filter(candidate => candidate !== undefined),
				"Failed to switch sessions and fully restore the previous runtime.",
			);
		}
		throw error;
	}

	/** Moves the cwd-scoped runtime back to `cwd`. Returns the failure rather than throwing it. */
	async #restoreScopeAfterFailedSwitch(cwd: string, logFields: SessionSwitchLogFields): Promise<unknown> {
		try {
			await this.#host.scope.restore(cwd);
			return undefined;
		} catch (scopeError) {
			logger.warn("Failed to restore cwd-scoped runtime after switch error", {
				...logFields,
				error: String(scopeError),
			});
			return scopeError;
		}
	}

	/**
	 * Restores the previous transcript's MCP selections. On failure, puts back the selections and
	 * tools captured before the switch and returns the failure rather than throwing it.
	 */
	async #restoreMCPAfterFailedSwitch(
		rollback: TranscriptRollback,
		logFields: SessionSwitchLogFields,
	): Promise<unknown> {
		try {
			const context = rollback.sessionContext ?? this.#session.buildDisplaySessionContext();
			await this.#host.restoreMCPSelectionsForSessionContext(context, {
				fallbackSelectedMCPToolNames: rollback.fallbackSelectedMCPToolNames,
			});
			return undefined;
		} catch (mcpError) {
			logger.warn("Failed to restore MCP selections after switch error", {
				...logFields,
				error: String(mcpError),
			});
			this.#host.discovery.restoreSelectedMCP(rollback.selectedMCPToolNames);
			this.#session.agent.setTools(rollback.tools);
			return mcpError;
		}
	}
}
