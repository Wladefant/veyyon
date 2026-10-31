/**
 * The turns a session starts on its own once a prompt returned (the `agent.continue()` a settle
 * schedules, the auto-continue prompt a compaction resumes with), the cancel an abort or dispose runs
 * on them, and the wait a prompt runs until every recovery behind it settled.
 *
 * This is a session collaborator. It schedules on the session's {@link PostPromptTasks}, which the
 * hidden next-turn queue shares, and reads the session only through {@link TurnContinuationsHost}.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { errorMessage, logger } from "@veyyon/utils";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import type { AgentContinueSkipReason, ScheduledAgentContinueOptions } from "../agent-session-types";
import type { PostPromptTasks } from "./post-prompt-tasks";

/** The agent loop a continuation resumes and a recovery wait watches. `Agent` satisfies it. */
export interface ContinuationAgent {
	continue(): Promise<void>;
	waitForIdle(): Promise<void>;
	readonly state: { readonly isStreaming: boolean };
}

/** What {@link TurnContinuations} needs from the session that owns it. */
export interface TurnContinuationsHost {
	readonly agent: ContinuationAgent;
	/** The session's prompt generation; an abort or a newer prompt moves it on. */
	promptGeneration(): number;
	/** Whether the session can start no turn: disposed, compacting, or generating a handoff. */
	unavailable(): boolean;
	/** Whether dispose has begun. */
	disposed(): boolean;
	/** Count a turn in flight; {@link endTurn} ends it. */
	beginTurn(): void;
	endTurn(): void;
	/** Return to the primary model a retry fell back from, once its cool-down ended. */
	restoreFallbackPrimary(): Promise<void>;
	/** The retry in progress, if one is. */
	retryGate(): Promise<void> | undefined;
	/** The resume a matched TTSR rule holds the turn on, if one does. */
	ttsrResume(): Promise<void> | undefined;
	/** Release the TTSR resume. */
	releaseTtsrResume(): void;
	/** The reminders a compaction summarized away, restated on the turn that resumes after it. */
	postCompactionNudges(): AgentMessage[];
	/** Run `message` as a prompt after `prependMessages`, without the recovery wait. */
	promptWith(message: AgentMessage, text: string, prependMessages: AgentMessage[] | undefined): Promise<void>;
}

function skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
	logger.debug("agent.continue skipped after scheduling", { reason });
	options?.onSkip?.(reason);
}

export class TurnContinuations {
	readonly #tasks: PostPromptTasks;
	readonly #host: TurnContinuationsHost;

	constructor(tasks: PostPromptTasks, host: TurnContinuationsHost) {
		this.#tasks = tasks;
		this.#host = host;
	}

	/**
	 * Schedule an `agent.continue()` after the current turn. It is skipped, and `options.onSkip` told
	 * why, when the session cannot start a turn, `options.shouldContinue` declines, or another run
	 * started first.
	 */
	scheduleContinue(options?: ScheduledAgentContinueOptions): void {
		const host = this.#host;
		this.#tasks.schedule(
			async signal => {
				// Defense in depth: do not start a fresh streaming turn while any
				// context maintenance or explicit handoff is already active.
				if (signal.aborted || host.unavailable()) {
					skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					skipAgentContinue("should-continue-false", options);
					return;
				}
				host.beginTurn();
				try {
					await host.restoreFallbackPrimary();
					if (signal.aborted || host.disposed()) {
						skipAgentContinue("post-restore-unavailable", options);
						return;
					}
					// Another start (a queued-message drain, a second continuation scheduled at the same
					// settle) can begin a run during the restore above. That run reads the state this
					// continuation was scheduled for and polls the same queues, so yield to it rather than
					// call continue() on a busy agent.
					if (host.agent.state.isStreaming) {
						skipAgentContinue("agent-busy", options);
						return;
					}
					await host.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: errorMessage(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.();
				} finally {
					host.endTurn();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => skipAgentContinue(reason, options),
			},
		);
	}

	/**
	 * Schedule the auto-continue prompt a compaction resumes with, for prompt `generation`. It carries
	 * the reminders the compaction summarized away, built when it runs, so an aborted continuation
	 * queues nothing; they ride on this request alone, never on the shared queue.
	 */
	scheduleAutoContinuePrompt(generation: number): void {
		const host = this.#host;
		this.#tasks.schedule(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				const text = turnControlPrompts["turn-control/auto-continue"].text;
				const nudges = host.postCompactionNudges();
				await host.promptWith(
					{ role: "developer", content: [{ type: "text", text }], attribution: "agent", timestamp: Date.now() },
					text,
					nudges.length > 0 ? nudges : undefined,
				);
			},
			{ generation },
		);
	}

	/** Skip scheduled work, release the TTSR resume, and wait for the work that already started. */
	cancel(): Promise<void> {
		const drain = this.#tasks.cancel();
		this.#host.releaseTtsrResume();
		return drain;
	}

	/**
	 * Wait for the retry, the TTSR resume and every scheduled continuation to settle. Loops, because a
	 * TTSR continuation can start a retry and a retry a continuation, and an `agent.continue()` may
	 * still stream after the TTSR resume resolved. Given the `generation` of the prompt it waits for,
	 * it returns once an abort or a newer prompt moved the session past it, rather than waiting on the
	 * queued steer or follow-up a post-abort drain starts as a fresh turn.
	 */
	async waitForRecovery(generation?: number): Promise<void> {
		const host = this.#host;
		while (true) {
			if (generation !== undefined && host.promptGeneration() !== generation) return;
			const retryGate = host.retryGate();
			if (retryGate) {
				await retryGate;
				continue;
			}
			const ttsrResume = host.ttsrResume();
			if (ttsrResume) {
				await ttsrResume;
				continue;
			}
			const drained = this.#tasks.drained;
			if (drained) {
				await drained;
				continue;
			}
			// The tracked tasks cover continuations scheduled from event handlers; this covers agent
			// activity started outside the scheduler.
			if (host.agent.state.isStreaming) {
				await host.agent.waitForIdle();
				continue;
			}
			return;
		}
	}
}
