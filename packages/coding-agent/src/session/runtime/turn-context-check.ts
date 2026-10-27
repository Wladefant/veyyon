/**
 * The context checks at a turn's boundaries: before a prompt starts its loop, between the provider
 * calls of a tool loop, and after a turn settles. Each decides whether the context has to be
 * recovered or maintained, and runs the recovery: a switch to a larger-context model when one is
 * available, otherwise a compaction.
 *
 * This is a session collaborator. It holds no state of its own and reaches the session through
 * {@link TurnContextCheckSession} and {@link TurnContextCheckHost}. The compaction pass a case starts is
 * `CompactionRuntime`'s.
 */
import { type Agent, type AgentMessage, type AgentTurnEndContext, toolResultNeverRan } from "@veyyon/agent-core";
import {
	type CompactionSettings,
	calculateContextTokens,
	compactionContextTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { modelsAreEqual } from "@veyyon/catalog/models";
import {
	COMPACTION_CHECK_CONTINUATION,
	COMPACTION_CHECK_NONE,
	type CompactionCheckResult,
} from "@veyyon/kernel/session/agent-session-compaction-policy";
import { getLatestCompactionEntry } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { GoalModeState } from "../../goals/state";
import { isSameAssistantMessage } from "../agent-session-message-shapes";
import { contextPromotionTarget } from "../agent-session-model-targets";
import type { ScheduledAgentContinueOptions } from "../agent-session-types";
import { isEmptyErrorTurn } from "../messages";
import type { AutoCompactionReason } from "./compaction-recovery";
import type { PruneOutcome } from "./history-rewrites";

/** What {@link TurnContextCheck} reads from the session's public surface. */
export interface TurnContextCheckSession {
	readonly agent: Agent;
	readonly sessionManager: Pick<SessionManager, "getBranch" | "appendMessage">;
	readonly settings: Pick<Settings, "get" | "getGroup">;
	readonly model: Model | undefined;
	readonly modelRegistry: Pick<ModelRegistry, "find" | "getAvailable" | "getApiKey">;
	readonly sessionId: string;
	readonly isCompacting: boolean;
	readonly isGeneratingHandoff: boolean;
	getContextBreakdown(options: {
		contextWindow: number;
		pendingMessages: AgentMessage[];
	}): { usedTokens: number } | undefined;
	setModelTemporary(model: Model, thinkingLevel: undefined, options: { ephemeral: true }): Promise<void>;
}

/** What {@link TurnContextCheck} needs from the session beyond its public surface. */
export interface TurnContextCheckHost {
	/** The prompt cycle now running; a scheduled retry must still match it to run. */
	promptGeneration(): number;
	/** Goal mode, read for the threshold decision's debug record. */
	goalMode(): GoalModeState | undefined;
	/** Whether `message` sits before the latest compaction on the branch. */
	predatesLatestCompaction(message: AssistantMessage): boolean;
	/** Settle the in-flight `message_end` persistence of `message`. */
	waitForPersisted(message: AssistantMessage): Promise<void>;
	/** Drop an assistant turn from the live context and the persisted branch. */
	discardAssistantTurn(message: AssistantMessage): void;
	/** Drop an assistant turn, and the never-ran tool results after it, from the live context only. */
	removeAssistantFromActiveContext(message: AssistantMessage): void;
	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void;
	/** Run an automatic compaction pass. */
	runAutoCompaction(
		reason: AutoCompactionReason,
		willRetry: boolean,
		options: {
			autoContinue: boolean;
			suppressContinuation?: boolean;
			triggerContextTokens?: number;
			phase: "pre_turn" | "mid_turn";
		},
	): Promise<CompactionCheckResult>;
	/** Warn once per context window about a capped, retired or unparseable compaction threshold. */
	noticeCompactionThresholdClamp(contextWindow: number, compactionSettings: CompactionSettings): void;
	/** Prune `read` results a newer read of the same file made stale, and results flagged useless. */
	pruneStale(): Promise<PruneOutcome | undefined>;
	/** Blank the oldest tool results outside the protect-recent window, and results flagged useless. */
	pruneOverflow(): Promise<PruneOutcome | undefined>;
	/** Tokens the stored conversation holds, estimated locally. */
	estimateStoredContextTokens(): number;
	/** Whether the session has begun disposing. */
	isDisposed(): boolean;
	/** Persist the just-finished turn before a mid-run compaction rewrites history; false when it cannot be. */
	persistTurnForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean>;
}

/**
 * Put a failed assistant turn back into ACTIVE context only.
 *
 * The dead-end paths (no promotion target and compaction unavailable) pull the
 * failed turn out of context eagerly so a retry cannot replay it, and then
 * never schedule one. Only the branch is left alone there, so re-appending to
 * the session would duplicate an entry that was never dropped; the active
 * context is the half that has to be put back, because it is what the user
 * reads.
 */
function restoreFailedAssistantTurnToActiveContext(agent: Agent, assistantMessage: AssistantMessage): void {
	const lastMessage = agent.state.messages.at(-1);
	if (lastMessage?.role === "assistant" && isSameAssistantMessage(lastMessage, assistantMessage)) return;
	agent.appendMessage(assistantMessage);
}

/**
 * Drop a failed assistant turn from active context.
 *
 * The turn is identified at the TAIL, and a turn that failed with tool calls
 * in it does not sit there alone: the agent loop pairs every retained call
 * with a never-ran placeholder result to keep the API's tool_use/tool_result
 * pairing intact, so the assistant message is second-to-last, or further
 * back on a wide batch. Matching only the final message therefore missed
 * the turns a retry has to clear, and left the dead turn (plus its
 * placeholders) in the context the retry replayed. Those placeholders are
 * dropped WITH it, and only those: a result that is not a never-ran
 * placeholder belongs to a call that ran, which is a turn no caller here is
 * allowed to discard.
 */
export function removeAssistantMessageFromActiveContext(
	agent: Agent,
	assistantMessage: AssistantMessage,
	reason = "assistant-context-cleanup",
): void {
	const messages = agent.state.messages;
	let end = messages.length;
	while (end > 0) {
		const candidate = messages[end - 1];
		if (candidate?.role !== "toolResult" || !toolResultNeverRan(candidate.details)) break;
		end -= 1;
	}
	const lastMessage = messages[end - 1];
	const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
	if (lastAssistant !== undefined && isSameAssistantMessage(lastAssistant, assistantMessage)) {
		agent.replaceMessages(messages.slice(0, end - 1));
		return;
	}
	// A miss means the failed turn is still in active context (or was never
	// there); log enough to explain why the identity check failed.
	logger.debug("agent active context assistant removal missed", {
		reason,
		lastRole: lastMessage?.role,
		trailingPlaceholders: messages.length - end,
		candidateTimestamp: assistantMessage.timestamp,
		lastTimestamp: lastAssistant?.timestamp,
		candidateStopReason: assistantMessage.stopReason,
		lastStopReason: lastAssistant?.stopReason,
	});
}

export class TurnContextCheck {
	readonly #session: TurnContextCheckSession;
	readonly #host: TurnContextCheckHost;

	constructor(session: TurnContextCheckSession, host: TurnContextCheckHost) {
		this.#session = session;
		this.#host = host;
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Four cases (in order):
	 * 1. Input overflow + promotion: promote to larger model, retry without maintenance.
	 * 2. Input overflow + no promotion target: run context maintenance, auto-retry on same model.
	 * 3. Output incomplete (stopReason === "length", e.g. `response.incomplete`): the
	 *    model burned its output budget without producing an actionable deliverable
	 *    (reasoning-only or truncated). Drop the dead turn, try promotion, otherwise
	 *    run compaction and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction or recovery scheduled a retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	async check(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const model = this.#session.model;
		const contextWindow = model?.contextWindow ?? 0;
		const generation = this.#host.promptGeneration();
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		//
		// Decided by position on the branch, not by timestamp. The scheduled
		// auto-continue re-enters this check with the kept assistant
		// (the session's #promptWithMessage -> check) and its stale, pre-rewrite
		// `usage`; a compaction entry appended in the same millisecond as that
		// assistant's `timestamp` made a `<` comparison read it as new, the stale
		// count re-tripped the threshold on a history with nothing left to
		// summarize, and the "freed too little context" warning fired on a
		// compaction that had just worked.
		const predatesCompaction = this.#host.predatesLatestCompaction(assistantMessage);
		if (sameModel && !predatesCompaction) {
			if (AIError.isContextOverflow(assistantMessage, contextWindow)) {
				return await this.#recoverOverflowedTurn(assistantMessage, generation, autoContinue);
			}
			if (assistantMessage.stopReason === "length") {
				return await this.#recoverIncompleteTurn(assistantMessage, generation, autoContinue);
			}
		} else if (
			!sameModel &&
			autoContinue &&
			!predatesCompaction &&
			(await this.#retryOverflowOnPromotedModel(assistantMessage, contextWindow, generation))
		) {
			return COMPACTION_CHECK_CONTINUATION;
		}
		return await this.#maintainContextAfterTurn(
			assistantMessage,
			contextWindow,
			sameModel === true,
			predatesCompaction,
			autoContinue,
		);
	}

	/**
	 * Before a prompt starts its loop: when the pending prompt carries the context past the compaction
	 * threshold, switch to a larger-context model, otherwise compact. Promotion goes first, because a
	 * switch keeps the history whole; the post-turn check orders the two the same way.
	 */
	async beforePrompt(messages: AgentMessage[]): Promise<void> {
		const model = this.#session.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.#session.settings.getGroup("compaction");
		// The local-estimate floor is applied in getContextBreakdown, so this is the exact number the
		// footline gauge shows.
		const contextTokens =
			this.#session.getContextBreakdown({ contextWindow, pendingMessages: messages })?.usedTokens ?? 0;
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		if (await this.promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.#host.runAutoCompaction("threshold", false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			phase: "pre_turn",
		});
	}

	/**
	 * Between the provider calls of a tool loop: compact a run that will continue before its next
	 * provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn are already paired in
	 * `activeMessages`, the live array the agent loop reads before its next model call. Before
	 * compacting, the just-finished turn is persisted if async message hooks have not reached the
	 * normal append path yet. The compacted history replaces `activeMessages` in place.
	 */
	async betweenProviderCalls(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		const session = this.#session;
		if (
			signal?.aborted ||
			this.#host.isDisposed() ||
			session.isCompacting ||
			session.isGeneratingHandoff ||
			!context?.willContinue
		)
			return;

		const model = session.model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = session.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.midTurnEnabled === false) {
			return;
		}

		const lastAssistant = activeMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		if (!(await this.#host.persistTurnForMidRunCompaction(context))) return;

		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#host.estimateStoredContextTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Promotion before compaction, as in the pre-prompt and post-turn checks. Without it a long
		// tool loop that crosses the threshold compacts the history, and can reach the no-progress
		// dead end on a single oversized turn, on a model a larger window should have replaced.
		if (await this.promoteContextModel()) {
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		await this.#host.runAutoCompaction("threshold", false, {
			autoContinue: false,
			suppressContinuation: true,
			triggerContextTokens: contextTokens,
			phase: "mid_turn",
		});

		if (signal?.aborted) return;
		const compactedMessages = session.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		const goal = this.#host.goalMode();
		logger.debug("Mid-run compaction ran between provider calls", {
			contextTokens,
			contextWindow,
			strategy: compactionSettings.strategy,
			goalActive: goal?.enabled === true && goal.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
		});
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a target with a
	 * strictly larger window and a usable key exists. True when the model was switched, so the caller
	 * retries without compacting.
	 */
	async promoteContextModel(): Promise<boolean> {
		if (!this.#session.settings.getGroup("contextPromotion").enabled) return false;
		const currentModel = this.#session.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.promotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.#session.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: errorMessage(error),
			});
			return false;
		}
	}

	/** The larger-context sibling of `currentModel` that has a usable key, or undefined. */
	async promotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const registry = this.#session.modelRegistry;
		const availableModels = registry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = contextPromotionTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await registry.getApiKey(candidate, this.#session.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	/**
	 * Case 1: the current model rejected the prompt as too long. Promote to a larger model and
	 * retry, otherwise compact and retry. With neither available the failed turn goes back into
	 * context: it is the only record that tells the user the context is too long.
	 */
	async #recoverOverflowedTurn(
		assistantMessage: AssistantMessage,
		generation: number,
		autoContinue: boolean,
	): Promise<CompactionCheckResult> {
		// Clear the failed turn from active context so the retry (or the next
		// user prompt) does not replay it. The persisted branch entry stays
		// for now: when no recovery path runs, the user-facing transcript
		// MUST keep the only assistant message explaining why the turn
		// stopped. The branch entry is dropped further down, but only on the
		// paths that actually schedule a retry/compaction.
		this.#host.removeAssistantFromActiveContext(assistantMessage);

		// Try context promotion first - switch to a larger model and retry without compacting
		if (await this.#tryContextPromotion(assistantMessage)) {
			await this.#dropPersistedAssistantTurn(assistantMessage);
			// Retry on the promoted (larger) model without compacting
			this.#host.scheduleAgentContinue({ delayMs: 100, generation });
			return COMPACTION_CHECK_CONTINUATION;
		}

		if (this.#session.settings.getGroup("compaction").enabled) {
			return await this.#runRecoveryCompactionWithRollback("overflow", assistantMessage, { autoContinue });
		}
		// Without this the prompt resolves with no assistant message, no error
		// event and no branch entry, so an operator who has compaction off sees a
		// question that produced nothing, while every other provider failure
		// leaves its error in the transcript.
		restoreFailedAssistantTurnToActiveContext(this.#session.agent, assistantMessage);
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Case 2: a context promotion landed while the failing call was already in flight (or on a run
	 * whose loop predates the switch), so the overflow error arrives stamped with the pre-promotion
	 * model while the session's model is already the promoted target. That state is not stale: drop the
	 * dead turn and retry on the promoted model. Applies only when the current model IS the failed
	 * model's promotion target with a strictly larger window, so stale errors from models the user
	 * switched away from keep surfacing untouched. Returns whether it scheduled the retry.
	 */
	async #retryOverflowOnPromotedModel(
		assistantMessage: AssistantMessage,
		contextWindow: number,
		generation: number,
	): Promise<boolean> {
		const currentModel = this.#session.model;
		if (
			assistantMessage.stopReason !== "error" ||
			!currentModel ||
			contextWindow <= 0 ||
			!this.#session.settings.getGroup("contextPromotion").enabled
		) {
			return false;
		}
		const failedModel = this.#session.modelRegistry.find(assistantMessage.provider, assistantMessage.model);
		if (!failedModel) return false;
		const failedWindow = failedModel.contextWindow ?? 0;
		const promotionTarget = contextPromotionTarget(failedModel, this.#session.modelRegistry.getAvailable());
		if (
			failedWindow <= 0 ||
			contextWindow <= failedWindow ||
			!promotionTarget ||
			!modelsAreEqual(promotionTarget, currentModel) ||
			!AIError.isContextOverflow(assistantMessage, failedWindow)
		) {
			return false;
		}
		this.#host.removeAssistantFromActiveContext(assistantMessage);
		await this.#dropPersistedAssistantTurn(assistantMessage);
		logger.debug("Overflow on pre-promotion model; retrying on promoted model", {
			failed: `${assistantMessage.provider}/${assistantMessage.model}`,
			current: `${currentModel.provider}/${currentModel.id}`,
		});
		this.#host.scheduleAgentContinue({ delayMs: 100, generation });
		return true;
	}

	/**
	 * Case 3: output-side incomplete. `response.incomplete` from OpenAI Responses (and Codex) maps
	 * to stopReason === "length": the model burned its `max_output_tokens` budget on reasoning or
	 * text and emitted no actionable deliverable. Same recovery class as an overflow: promotion if
	 * available, otherwise in-place compaction.
	 */
	async #recoverIncompleteTurn(
		assistantMessage: AssistantMessage,
		generation: number,
		autoContinue: boolean,
	): Promise<CompactionCheckResult> {
		// Same active-context vs persisted-history split as the overflow path:
		// clear the dead turn from agent state so it cannot be replayed, but keep
		// it on the branch unless promotion or compaction actually runs.
		this.#host.removeAssistantFromActiveContext(assistantMessage);

		if (await this.#tryContextPromotion(assistantMessage)) {
			await this.#dropPersistedAssistantTurn(assistantMessage);
			logger.debug("Context promotion triggered by response.incomplete (length stop)", {
				from: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			this.#host.scheduleAgentContinue({ delayMs: 100, generation });
			return COMPACTION_CHECK_CONTINUATION;
		}

		const compactionSettings = this.#session.settings.getGroup("compaction");
		if (compactionSettings.enabled) {
			logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
				strategy: compactionSettings.strategy,
			});
			return await this.#runRecoveryCompactionWithRollback("incomplete", assistantMessage, {
				autoContinue,
				triggerContextTokens: calculateContextTokens(assistantMessage.usage),
			});
		}
		// Same dead end as the overflow path: the truncated turn is the only
		// record of why the turn stopped, and the cleanup above took it out.
		restoreFailedAssistantTurnToActiveContext(this.#session.agent, assistantMessage);
		logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
			model: `${assistantMessage.provider}/${assistantMessage.model}`,
		});
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Case 4: the turn succeeded but the context is getting large. Prunes stale and overflowing
	 * tool results every turn, then promotes or compacts once the context crosses the threshold.
	 */
	async #maintainContextAfterTurn(
		assistantMessage: AssistantMessage,
		contextWindow: number,
		sameModel: boolean,
		predatesCompaction: boolean,
		autoContinue: boolean,
	): Promise<CompactionCheckResult> {
		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#host.pruneStale();

		const compactionSettings = this.#session.settings.getGroup("compaction");
		if (!compactionSettings.enabled) return COMPACTION_CHECK_NONE;

		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#host.pruneOverflow();
		const maintenanceTokensFreed = (supersedeResult?.tokensSaved ?? 0) + (pruneResult?.tokensSaved ?? 0);
		// An assistant that predates the latest compaction carries stale, pre-rewrite
		// `usage`: the scheduled auto-continue re-enters this check with the kept
		// assistant (the session's #promptWithMessage → check), and its old high prompt
		// count would re-trip the threshold on a freshly compacted history. Drop the
		// stale provider number for those messages and let the live stored estimate
		// (the floor applied below) drive the decision instead.
		const assistantUsageContextTokens = predatesCompaction ? 0 : calculateContextTokens(assistantMessage.usage);
		const storedContextTokens = this.#host.estimateStoredContextTokens();
		// Pruning frees bytes for the NEXT prompt; it does not change the size of
		// the prompt the LLM just billed for. Earlier revisions subtracted the
		// per-turn supersede/prune `tokensSaved` from the threshold input, which
		// let a long-running `/goal` session sit above `compaction.threshold`
		// indefinitely whenever per-turn pruning saved enough to drop the
		// post-prune estimate below the user-configured trigger: the visible
		// context (anchored to the same provider billing) still showed >threshold,
		// but `shouldCompact` no-op'd (#3174). Anchor the initial trigger on the
		// last turn's billed context tokens, floored by the post-prune
		// stored-conversation estimate so a payload-compression hook still cannot
		// deflate the trigger.
		const contextTokens = compactionContextTokens(assistantUsageContextTokens, storedContextTokens);
		const postMaintenanceContextTokens = compactionContextTokens(
			Math.max(0, assistantUsageContextTokens - maintenanceTokensFreed),
			storedContextTokens,
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		this.#host.noticeCompactionThresholdClamp(contextWindow, compactionSettings);
		const shouldThresholdCompact = shouldCompact(contextTokens, contextWindow, compactionSettings);
		logger.debug("Auto-compaction threshold decision", {
			phase: "post-agent-end",
			goalModeEnabled: this.#host.goalMode()?.enabled === true,
			goalStatus: this.#host.goalMode()?.goal.status,
			stopReason: assistantMessage.stopReason,
			sameModel,
			contextWindow,
			strategy: compactionSettings.strategy,
			thresholdTokens,
			assistantUsageContextTokens,
			storedContextTokens,
			resolvedContextTokens: contextTokens,
			postMaintenanceContextTokens,
			maintenanceTokensFreed,
			shouldCompact: shouldThresholdCompact,
			contextPromotionEnabled: this.#session.settings.get("contextPromotion.enabled") === true,
		});
		if (!shouldThresholdCompact) return COMPACTION_CHECK_NONE;
		// Try promotion first — if a larger model is available, switch instead of compacting
		if (!(await this.#tryContextPromotion(assistantMessage))) {
			return await this.#host.runAutoCompaction("threshold", false, {
				autoContinue,
				triggerContextTokens: postMaintenanceContextTokens,
				phase: "pre_turn",
			});
		}
		logger.debug("Auto-compaction threshold satisfied but context promotion took over", {
			contextTokens,
			contextWindow,
			model: `${assistantMessage.provider}/${assistantMessage.model}`,
		});
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void> {
		await this.#host.waitForPersisted(assistantMessage);
		this.#host.discardAssistantTurn(assistantMessage);
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * `CompactionRuntime.runAutoCompaction` for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#session.sessionManager.getBranch());
		await this.#dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#host.runAutoCompaction(reason, true, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#session.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	/**
	 * Restore a failed assistant turn after a recovery attempt that dropped the
	 * persisted entry and then committed nothing.
	 */
	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#session.sessionManager.appendMessage(assistantMessage);
		restoreFailedAssistantTurnToActiveContext(this.#session.agent, assistantMessage);
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.#session.model;
		if (!currentModel) return false;
		// The overflow/length error may have come from a model the user already
		// switched away from; only promote when the failing turn was this model.
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.promoteContextModel();
	}
}
