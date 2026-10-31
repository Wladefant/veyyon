/**
 * Memory context: what the memory backend tells the model, and when the session forgets what it told.
 *
 * This is a session collaborator. It holds the Hindsight backend's per-session state, the recalled
 * block last delivered and the block waiting for the next step boundary, and reaches the session
 * only through {@link MemoryContextHost}.
 *
 * - **Delivery** ({@link MemoryContext.collect}, {@link MemoryContext.publish},
 *   {@link MemoryContext.takePending}) carries recalled memory as a `memory-context` message at the
 *   context tail rather than in the system prompt, so a recall never invalidates the provider's
 *   cached prefix, and never sends an unchanged block twice.
 * - **A new transcript** ({@link MemoryContext.rekey}, {@link MemoryContext.resetForNewTranscript})
 *   points the backend state at the current session id, resets its conversation tracking, and
 *   re-derives the delivered block from the transcript the session is now on.
 * - **The session's end** ({@link MemoryContext.release}) flushes and drops both backends' state.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { errorMessage, logger } from "@veyyon/utils";
import type { HindsightSessionState } from "../../memory/hindsight/state";
import type { MnemopiSessionState } from "../../memory/mnemopi/state";
import { MEMORY_CONTEXT_MESSAGE_TYPE } from "../nudges";

/** The memory backend hooks this collaborator calls, each receiving the session `S` it serves. */
export interface SessionMemoryBackend<S> {
	readonly id: string;
	beforeAgentStartPrompt?(session: S, promptText: string): Promise<string | undefined>;
	buildVolatileContext?(session: S): Promise<string | undefined>;
}

/** What {@link MemoryContext} needs from the session that holds it. */
export interface MemoryContextHost<S> {
	/** The session the backend hooks receive. */
	readonly session: S;
	/** The backend `memory.backend` selects. */
	backend(): Promise<SessionMemoryBackend<S>>;
	/** `memory.backend` as of now. */
	backendId(): string;
	/** The agent's provider session id, when it has one. */
	sessionId(): string | undefined;
	/** The Mnemopi backend's state for this session, when that backend started one. */
	mnemopiState(): MnemopiSessionState | undefined;
	/** Clear the Mnemopi backend's state for this session and return the state cleared. */
	detachMnemopiState(): MnemopiSessionState | undefined;
	/** The live context, in the order the next request sends it. */
	messages(): readonly AgentMessage[];
}

/**
 * The content of the last `customType` block `messages` carry, or undefined when they carry none.
 *
 * A delivered-once block is deduplicated against the conversation rather than a flag per caller:
 * the messages hold exactly what the model reads next. A compaction that dropped the block drops it
 * from this answer too, so the block is sent again.
 */
export function lastDeliveredBlock(messages: readonly AgentMessage[], customType: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "custom" || message.customType !== customType) continue;
		return typeof message.content === "string" ? message.content : undefined;
	}
	return undefined;
}

export class MemoryContext<S> {
	readonly #host: MemoryContextHost<S>;
	#hindsight: HindsightSessionState | undefined;
	/** A recalled block waiting for the next step boundary to carry it in. */
	#pending: string | undefined;

	constructor(host: MemoryContextHost<S>) {
		this.#host = host;
	}

	/** The Hindsight backend's state for this session, when that backend started one. */
	get hindsight(): HindsightSessionState | undefined {
		return this.#hindsight;
	}

	/** Replace the Hindsight state and return the one replaced. */
	swapHindsight(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsight;
		this.#hindsight = state;
		return previous;
	}

	/** Point the active backend's state at the agent's current provider session id. */
	rekey(): void {
		const backendId = this.#host.backendId();
		if (backendId !== "hindsight" && backendId !== "mnemopi") return;
		const sessionId = this.#host.sessionId();
		if (!sessionId) return;
		if (backendId === "hindsight") this.#hindsight?.setSessionId(sessionId);
		else this.#host.mnemopiState()?.setSessionId(sessionId);
	}

	/**
	 * Forget what the previous conversation was told, on every path that starts a new one (`/new`,
	 * `/clear`, a session switch, a resume onto a different transcript).
	 *
	 * The backend's conversation tracking is reset so the next turn recalls afresh. A queued block is
	 * dropped, because the recall it came from belonged to the conversation being left; the first
	 * prompt of the new transcript collects the current context anyway, and it is compared against the
	 * transcript the session is now on, so `/new` delivers an identical recall again and a fork or a
	 * switch that already carries it does not.
	 *
	 * The system prompt is not rebuilt: both backends' developer instructions are static for the life
	 * of the session, so a rebuild could only produce the same bytes.
	 */
	resetForNewTranscript(): void {
		const backendId = this.#host.backendId();
		const state =
			backendId === "hindsight" ? this.#hindsight : backendId === "mnemopi" ? this.#host.mnemopiState() : undefined;
		if (state && !state.aliasOf) state.resetConversationTracking();
		this.#pending = undefined;
	}

	/**
	 * Release both backends' state for a session that is ending, giving Mnemopi's consolidation
	 * `mnemopiConsolidateTimeoutMs` to finish.
	 *
	 * The Hindsight retain queue is flushed while the session still holds its state, because
	 * `HindsightRetainQueue.#doFlush` checks that the session's state is the one it flushes: cleared
	 * first, the batch it already spliced fails that check and is dropped as `session vanished`.
	 */
	async release(mnemopiConsolidateTimeoutMs: number | undefined): Promise<void> {
		const hindsight = this.#hindsight;
		await hindsight?.flushRetainQueue();
		this.#hindsight = undefined;
		hindsight?.dispose();
		await this.#host.detachMnemopiState()?.dispose({ timeoutMs: mnemopiConsolidateTimeoutMs });
	}

	/**
	 * Collect the backend's context for a turn about to start, as a message rather than a
	 * system-prompt change.
	 *
	 * `beforeAgentStartPrompt` is the only hook that can affect the first answer of a session, and
	 * `buildVolatileContext` reports what the backend holds now. Returns null when there is nothing
	 * new to say. A hook that throws is logged and skipped: a failing recall does not fail the turn.
	 */
	async collect(promptText: string): Promise<AgentMessage | null> {
		const host = this.#host;
		const backend = await host.backend();
		const parts: string[] = [];
		if (backend.beforeAgentStartPrompt) {
			try {
				const injected = (await backend.beforeAgentStartPrompt(host.session, promptText))?.trim();
				if (injected) parts.push(injected);
			} catch (err) {
				logger.debug("Memory backend beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: errorMessage(err),
				});
			}
		}
		if (backend.buildVolatileContext) {
			try {
				// `beforeAgentStartPrompt` caches its recall on the backend state, so the same text
				// usually comes back from both hooks on the first turn.
				const volatileContext = (await backend.buildVolatileContext(host.session))?.trim();
				if (volatileContext && !parts.includes(volatileContext)) parts.push(volatileContext);
			} catch (err) {
				logger.debug("Memory backend buildVolatileContext failed", {
					backend: backend.id,
					error: errorMessage(err),
				});
			}
		}
		return this.#message(parts.join("\n\n"));
	}

	/**
	 * Queue the backend's current context for the next step boundary, and report whether anything new
	 * is queued.
	 *
	 * A recall (on `agent_start`) or a mental-model reload (on `agent_end`) calls this instead of
	 * rebuilding the system prompt, so the block reaches the model after everything already cached.
	 */
	async publish(reason: string): Promise<boolean> {
		const host = this.#host;
		const backend = await host.backend();
		if (!backend.buildVolatileContext) return false;
		let text: string | undefined;
		try {
			text = await backend.buildVolatileContext(host.session);
		} catch (err) {
			logger.debug("Memory backend buildVolatileContext failed", {
				backend: backend.id,
				reason,
				error: errorMessage(err),
			});
			return false;
		}
		const trimmed = text?.trim();
		if (!trimmed || trimmed === this.#delivered()) return false;
		this.#pending = trimmed;
		logger.debug("memory context queued for the context tail", { reason, chars: trimmed.length });
		return true;
	}

	/**
	 * Drain the queued block as a message, if one is waiting and the live context does not already
	 * carry it: a prompt that landed the same recall between the queueing and this boundary has
	 * delivered it.
	 */
	takePending(): AgentMessage | null {
		const pending = this.#pending;
		this.#pending = undefined;
		return pending === undefined ? null : this.#message(pending);
	}

	/**
	 * The block the live context carries. Read from the messages the next request sends, not from a
	 * record of what was sent, so a compaction or a rewind that drops the block, or a prompt abandoned
	 * after collecting it, leaves an unchanged recall to be delivered again.
	 */
	#delivered(): string | undefined {
		return lastDeliveredBlock(this.#host.messages(), MEMORY_CONTEXT_MESSAGE_TYPE);
	}

	/** A memory-context message for `text`, or null when it is empty or the live context carries it. */
	#message(text: string): AgentMessage | null {
		const trimmed = text.trim();
		if (!trimmed || trimmed === this.#delivered()) return null;
		this.#pending = undefined;
		return {
			role: "custom",
			customType: MEMORY_CONTEXT_MESSAGE_TYPE,
			content: trimmed,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}
