/**
 * The session's IRC inbox and idle drain. Every wake delegates to AgentSession,
 * which owns phase claims, durable delivery, and settlement.
 */
import type { Agent } from "@veyyon/agent-core";
import { errorMessage, logger } from "@veyyon/utils";
import type { CustomMessage } from "../messages";
import { IrcInbox } from "./irc-inbox";

/** The agent state and event surface the inbox drain needs. */
export type IrcDeliveryAgent = Pick<Agent, "hasQueuedMessages" | "emitExternalEvent">;

/** What {@link IrcDelivery} needs from the session that holds it. */
export interface IrcDeliveryHost {
	readonly agent: IrcDeliveryAgent;
	isDisposed(): boolean;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	/** Append a record to the model's context and the session file without starting a turn. */
	appendToContext(record: CustomMessage): void;
	/** Whether a queued steer or follow-up will resume the session on its own. */
	canAutoContinueForFollowUp(): boolean;
	/** Route every wake through the session's native phase and settlement owner. */
	wake(records: CustomMessage[]): Promise<void>;
}

export class IrcDelivery {
	/**
	 * Records that arrived while a turn streamed. Parent messages enter the steering queue instead;
	 * peer messages wait here as interrupts and drain as asides at the next step boundary.
	 */
	readonly inbox = new IrcInbox();
	readonly #host: IrcDeliveryHost;

	constructor(host: IrcDeliveryHost) {
		this.#host = host;
	}

	/**
	 * Records that arrive after the loop's final aside poll, or while an abort skipped that poll, wait
	 * in the inbox with no loop left to drain them, and the queued-message drain does not count them.
	 * Once idle, wake a turn so the agent answers the peer. Skipped when a queued steer or follow-up
	 * will itself drive a resume turn whose aside poll consumes these, so the session is not woken
	 * twice. In plan mode the records are folded into context without a turn.
	 */
	resumeStranded(): void {
		const host = this.#host;
		if (host.isDisposed() || host.isStreaming()) return;
		if (this.inbox.isEmpty) return;
		if (host.canAutoContinueForFollowUp() && host.agent.hasQueuedMessages()) return;
		const records = this.inbox.takeAll();
		if (host.planModeEnabled()) {
			for (const record of records) {
				host.appendToContext(record);
			}
			return;
		}
		this.#wake(records);
	}

	/**
	 * Persist the records that missed their step-boundary injection, so the model still reads them.
	 * Called at the start of the next prompt and when the session begins disposing.
	 */
	flushPending(): void {
		const records = this.inbox.takeAll();
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches to every session
			// listener, which handles terminal rendering and session-file persistence.
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	/** Idle and stranded inputs share the session's phase claim, persistence and queue ownership. */
	#wake(records: CustomMessage[]): void {
		void this.#host.wake(records).catch(error => {
			logger.warn("IRC wake turn failed", { error: errorMessage(error) });
		});
	}
}
