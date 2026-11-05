/**
 * What a run that ended goes through before extensions see its `agent_end`: the GitHub Copilot
 * credential drop on an auth failure, the `yield` short-circuit, empty-stop and unexpected-stop
 * recovery, the failed-turn retry, the compaction check, the stop-time continuation passes (rewind,
 * plan-mode decision, todo completion, verification, review) and the `session_stop` hooks.
 *
 * This is a session collaborator. Its state is the assistant message the latest `message_end`
 * settled, recorded before any await so the `agent_end` dispatched right after it reads that reply
 * and not the one before it. Every other effect belongs to a collaborator it reaches through
 * {@link StopSettlementHost}.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { isProviderRefusalMessage } from "@veyyon/agent-core/replay-policy";
import type { AssistantMessage } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import type { CompactionCheckResult } from "@veyyon/kernel/session/agent-session-compaction-policy";
import {
	isAwaitingUserAnswer,
	mayContinueAtSettle,
	type SettleContinuationState,
} from "@veyyon/kernel/session/settle-continuation";
import { logger } from "@veyyon/utils";
import type { GoalModeState } from "../../goals/state";
import type { FinalizeReminders } from "./finalize-reminders";
import type { MessagePersistence } from "./message-persistence";
import type { OwnedAsyncJobs } from "./owned-async-jobs";
import type { PlanModeRuntime } from "./plan-mode-runtime";
import type { RetryRuntime } from "./retry-runtime";
import type { SessionHandoff } from "./session-handoff";
import type { SessionStopHook } from "./session-stop-hook";
import type { StopRetries } from "./stop-retries";
import type { TodoRuntime } from "./todo-runtime";
import type { TurnContextCheck } from "./turn-context-check";
import type { YieldTracker } from "./yield-tracker";

type Route = (name: string, extra?: Record<string, unknown>) => void;

/** What {@link StopSettlement} needs from the session that holds it. */
export interface StopSettlementHost {
	readonly yields: Pick<YieldTracker, "clear" | "endedWithYield" | "findYieldMessage" | "terminationPending">;
	readonly persistence: Pick<MessagePersistence, "waitFor">;
	readonly handoff: Pick<SessionHandoff, "takeMaintenanceSkip">;
	readonly contextCheck: Pick<TurnContextCheck, "check">;
	readonly stopRetries: Pick<StopRetries, "onEmptyStop" | "onUnexpectedStop">;
	readonly retry: Pick<RetryRuntime, "recoverFailedTurn" | "resolve">;
	readonly finalize: Pick<
		FinalizeReminders,
		"codeReviewBeforeFinalize" | "rewindBeforeYield" | "verificationBeforeFinalize"
	>;
	readonly planMode: Pick<PlanModeRuntime, "enforceDecisionAtSettle">;
	readonly todo: Pick<TodoRuntime, "checkCompletionAtSettle">;
	readonly ownedJobs: Pick<OwnedAsyncJobs, "hasPendingWake">;
	readonly stopHook: Pick<SessionStopHook, "run">;
	/** Read at every settle: whether an active goal pre-empts the stop with a compaction check. */
	goalMode(): GoalModeState | undefined;
	/** Drops a provider's stored credentials, so the next request does not reuse a rejected token. */
	forgetCredentials(provider: string): Promise<void>;
	/** Drops a refused reply from the live context, so the next turn does not replay it. */
	dropFromActiveContext(message: AssistantMessage): void;
}

export class StopSettlement {
	readonly #host: StopSettlementHost;

	constructor(host: StopSettlementHost) {
		this.#host = host;
	}

	/**
	 * Post-run maintenance: retry, compaction and the stop-time passes. The caller emits the
	 * `agent_end` notification after it on every route.
	 *
	 * The settle acts on the last assistant message in agent state, which agent-core appends before
	 * it emits that message's `message_end`. A run that throws ends on a failure agent-core appends
	 * with no `message_end` at all, so the last reply a `message_end` delivered is not the reply the
	 * run ended on.
	 */
	async run(settledMessages: AgentMessage[]): Promise<void> {
		const host = this.#host;
		const msg = settledMessages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (!msg) {
			host.yields.clear();
			const goal = host.goalMode();
			logger.debug("agent_end maintenance routing", {
				reason: "no-assistant-message",
				goalModeEnabled: goal?.enabled === true,
				goalStatus: goal?.goal.status,
			});
			return;
		}
		// The identity of the settling message is read above, before its persistence slot drains; the
		// passes below append to the branch, so wait for the entry to exist or a continuation reminder
		// lands ahead of the reply it answers. Resolved already whenever the slot drained first.
		await host.persistence.waitFor(msg);

		const successfulYieldMessage = host.yields.findYieldMessage(settledMessages);
		const yieldOnThisMessage = host.yields.endedWithYield(msg);
		const route: Route = (name, extra) => this.#logRoute(msg, successfulYieldMessage !== undefined, name, extra);
		route("entered");

		await this.#forgetCopilotOnAuthFailure(msg);

		if (host.handoff.takeMaintenanceSkip(msg.timestamp)) {
			host.yields.clear();
			route("skip-post-turn-maintenance");
			return;
		}

		const goal = host.goalMode();
		const activeGoal = goal?.enabled === true && goal.goal.status === "active";
		// A successful `yield` in this run is terminal for execution purposes. Suppress empty-stop
		// retry, unexpected-stop retry, queued-message drain, and compaction-driven continuations for
		// the rest of this prompt cycle: the executor consumed the yield as the terminal result, so a
		// trailing empty/aborted assistant stop must NOT revive the agent loop. The
		// pending termination clears on the next `prompt()`.
		if (successfulYieldMessage || host.yields.terminationPending) {
			host.yields.clear();
			if (!successfulYieldMessage) {
				route("post-yield-trailing-stop-suppressed");
			} else if (!activeGoal) {
				route("successful-yield-no-active-goal");
			} else {
				route(
					yieldOnThisMessage
						? "successful-yield-active-goal-checkCompaction"
						: "post-yield-trailing-stop-active-goal-checkCompaction",
				);
				await host.contextCheck.check(successfulYieldMessage);
			}
			return;
		}
		host.yields.clear();
		await this.#settleStop(msg, settledMessages, activeGoal, route);
	}

	#logRoute(msg: AssistantMessage, successfulYield: boolean, route: string, extra?: Record<string, unknown>): void {
		const goal = this.#host.goalMode();
		logger.debug("agent_end maintenance routing", {
			route,
			stopReason: msg.stopReason,
			provider: msg.provider,
			model: msg.model,
			contentBlocks: msg.content.length,
			hasToolCalls: msg.content.some(content => content.type === "toolCall"),
			hasText: msg.content.some(content => content.type === "text"),
			goalModeEnabled: goal?.enabled === true,
			goalStatus: goal?.goal.status,
			successfulYield,
			...extra,
		});
	}

	/** Drop GitHub Copilot credentials on an auth failure so the next request does not reuse a stale token. */
	async #forgetCopilotOnAuthFailure(msg: AssistantMessage): Promise<void> {
		if (
			msg.stopReason === "error" &&
			msg.provider === "github-copilot" &&
			AIError.is(AIError.classifyMessage(msg), AIError.Flag.AuthFailed)
		) {
			await this.#host.forgetCredentials("github-copilot");
		}
	}

	/** Route a stop that no `yield` ended: empty-stop and failure recovery, compaction, then `session_stop`. */
	async #settleStop(
		msg: AssistantMessage,
		settledMessages: AgentMessage[],
		activeGoal: boolean,
		route: Route,
	): Promise<void> {
		const host = this.#host;
		// One reading of "this reply is waiting on the user", shared by every route below and read
		// before the first guard runs, so the retry guards that settle earliest see the same answer as
		// the passes that settle last.
		const settleState: SettleContinuationState = { awaitingUserAnswer: isAwaitingUserAnswer(msg) };
		// Empty-stop cleanup MUST run before any compaction continuation: an empty toolUse stop must
		// be stripped from active context + session history before another turn is scheduled,
		// otherwise the next Anthropic turn carries a tool_use block with no matching tool_result and
		// corrupts message history. The handler also schedules its own retry, so a real empty stop
		// never needs the active-goal threshold pre-empt below.
		if (await host.stopRetries.onEmptyStop(msg)) {
			route("empty-stop-handled");
			return;
		}

		let compactionResult: CompactionCheckResult | undefined;
		if (activeGoal) {
			route("active-goal-pre-empt-checkCompaction");
			compactionResult = await host.contextCheck.check(msg);
			if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) {
				route("active-goal-pre-empt-compaction-handled", {
					continuationScheduled: compactionResult.continuationScheduled,
					automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
				});
				host.retry.resolve();
				return;
			}
		}

		if (await host.stopRetries.onUnexpectedStop(msg, settleState)) {
			route("unexpected-stop-handled");
			return;
		}
		if (await host.retry.recoverFailedTurn(msg)) return;
		// Classifier refusals are persisted-skipped above; also prune the trailing stub from active
		// context so the next turn's prompt does not replay it. Fall through to the standard error
		// tail so `session_stop` hooks (block, continue, telemetry) still fire.
		if (isProviderRefusalMessage(msg)) {
			host.dropFromActiveContext(msg);
		}
		host.retry.resolve();

		if (!compactionResult) {
			route("bottom-checkCompaction");
			compactionResult = await host.contextCheck.check(msg);
		}
		if (await this.#continueAtSettle(msg, settleState, compactionResult)) return;
		await host.stopHook.run(settledMessages, msg);
	}

	/**
	 * The stop-time passes that may continue a settled turn instead of ending it. True when one
	 * scheduled a continuation, or the turn is not a final stop, so `session_stop` must not fire.
	 */
	async #continueAtSettle(
		msg: AssistantMessage,
		settleState: SettleContinuationState,
		compactionResult: CompactionCheckResult,
	): Promise<boolean> {
		const host = this.#host;
		// Stop-time todo reconciliation only fires at a text-only final stop. A run that ends still
		// mid-tool-use (deadline hit, context full, etc.) skips the reminder so a follow-up does not
		// pile onto an already in-flight turn. Mid-run sync is TodoRuntime.takeMidRunNudge (#3651).
		if (msg.content.some(content => content.type === "toolCall")) return true;
		// When compaction queued recovery or hit a deliberate dead-end, skip the rewind/todo/
		// session_stop passes: a reminder or hook continuation appended here would race the retry,
		// auto-continue prompt, queued-message drain, or the pause preventing a compaction loop.
		if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) return true;
		const stopped = msg.stopReason !== "error";
		if (stopped && mayContinueAtSettle("rewind-checkpoint", settleState) && host.finalize.rewindBeforeYield()) {
			return true;
		}
		if (
			stopped &&
			mayContinueAtSettle("plan-mode-decision", settleState) &&
			(await host.planMode.enforceDecisionAtSettle())
		) {
			return true;
		}
		// Called unconditionally at a stop: its first statement consumes the served tool-choice label,
		// and skipping that leaks a `user-force` label onto the next turn. The hold is a parameter.
		if (stopped && (await host.todo.checkCompletionAtSettle(settleState))) return true;
		// A pending async wake means this settle is a scheduling pause, not the terminal stop: the
		// async-result delivery continues the loop and the real stop settles later, so the
		// session_stop hook pass waits until the session is fully idle.
		if (host.ownedJobs.hasPendingWake()) return true;
		// Gated BEFORE the enforcer runs: it drains the ledger's one reminder as it reads it, so
		// deferring from inside would spend the reminder it meant to keep.
		if (mayContinueAtSettle("verification-evidence", settleState) && host.finalize.verificationBeforeFinalize()) {
			return true;
		}
		return mayContinueAtSettle("code-review", settleState) && host.finalize.codeReviewBeforeFinalize();
	}
}
