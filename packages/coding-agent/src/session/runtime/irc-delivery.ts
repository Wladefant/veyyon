/**
 * IRC messages arriving at a session: the `irc:incoming` record each becomes, where that record
 * goes, the auto-reply sent for a session that cannot answer in time, and the records that strand
 * in the inbox after a turn's last step boundary.
 *
 * This is a session collaborator. It holds the {@link IrcInbox} and reaches the session only through
 * {@link IrcDeliveryHost}. A delivery never blocks on the recipient's turn: a wake turn and an
 * auto-reply are both fire-and-forget.
 */
import type { Agent } from "@veyyon/agent-core";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import { sideChannelPrompts } from "../../prompts/side-channel/rows";
import { steeringPrompts } from "../../prompts/steering/rows";
import { AgentRegistry } from "../../registry/agent-registry";
import { IrcBus, type IrcMessage } from "../../task/irc-bus";
import type { EphemeralTurnArgs, EphemeralTurnResult } from "../agent-session-ephemeral-turn";
import type { CustomMessage } from "../messages";
import { IrcInbox } from "./irc-inbox";

/** The agent queues and turn entry points a delivery drives. `Agent` satisfies this. */
export type IrcDeliveryAgent = Pick<
	Agent,
	| "steer"
	| "prompt"
	| "hasQueuedMessages"
	| "peekSteeringQueue"
	| "peekFollowUpQueue"
	| "replaceQueues"
	| "emitExternalEvent"
>;

/** What {@link IrcDelivery} needs from the session that holds it. */
export interface IrcDeliveryHost {
	readonly agent: IrcDeliveryAgent;
	isDisposed(): boolean;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	/** `async.enabled`, read at each delivery. */
	asyncEnabled(): boolean;
	/** Emit the `irc_message` session event the UI draws a card from. */
	emitIrcMessage(record: CustomMessage): void;
	/** Append a record to the model's context and the session file without starting a turn. */
	appendToContext(record: CustomMessage): void;
	/** Whether a queued steer or follow-up will resume the session on its own. */
	canAutoContinueForFollowUp(): boolean;
	/** Start tracking a wake turn: reset the per-prompt state and count the turn in flight. */
	beginWakeTurn(): void;
	/** Stop tracking a wake turn; the session drains what stranded once none is left in flight. */
	endWakeTurn(): void;
	runEphemeralTurn(args: EphemeralTurnArgs): Promise<EphemeralTurnResult>;
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
	 * Deliver `msg` into the session and emit its `irc_message` event:
	 *
	 * - mid-turn → steered when the sender is the recipient's parent, otherwise queued in the inbox
	 *   and folded in at the next step boundary → "injected";
	 * - idle in plan mode → appended into context without waking an autonomous turn (convergence
	 *   stays user-driven) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes → "woken".
	 *
	 * When the sender expects a reply (`send await:true`) and the session cannot produce a real reply
	 * turn in time — mid-turn with async execution disabled (the next step boundary may wait on the
	 * sender's own batch), or idle in plan mode (wake turns are suppressed) — an ephemeral
	 * side-channel auto-reply is generated from the current context and sent back over the bus on
	 * this agent's behalf.
	 */
	deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): "injected" | "woken" {
		const host = this.#host;
		if (host.isDisposed()) {
			throw new Error("Recipient session is disposed.");
		}
		const streaming = host.isStreaming();
		const planModeIdle = !streaming && host.planModeEnabled();
		const autoReply = (opts?.expectsReply ?? false) && ((streaming && !host.asyncEnabled()) || planModeIdle);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(sideChannelPrompts["side-channel/irc-incoming"].text, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: streaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		host.emitIrcMessage(record);
		if (host.isStreaming()) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				host.agent.steer({
					role: "user",
					content: prompt.render(steeringPrompts["steering/parent-irc"].text, {
						from: msg.from,
						message: msg.body,
					}),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.inbox.queueInterrupt(record);
			}
			if (autoReply) void this.#autoReply(msg);
			return "injected";
		}
		if (host.planModeEnabled()) {
			host.appendToContext(record);
			if (autoReply) void this.#autoReply(msg);
			return "injected";
		}
		this.#wake([record]);
		return "woken";
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

	/**
	 * Fire-and-forget wake turn, shared by idle delivery and the stranded-record resume, tracked in
	 * flight so its settle re-drains anything that stranded during it. A user interrupt may have left
	 * a follow-up queued behind an invalid tail on purpose; the wake turn's loop would otherwise drain
	 * it, so a blocked follow-up queue is parked across the wake and restored after. It stays queued
	 * after the wake because the session suppresses follow-up auto-resume while a user interrupt is in
	 * effect, even though the wake left a provider-valid tail.
	 */
	#wake(records: CustomMessage[]): void {
		const host = this.#host;
		const agent = host.agent;
		// Park only a blocked follow-up; one that may resume rides the wake turn without reordering.
		const parkedFollowUps =
			agent.peekSteeringQueue().length === 0 &&
			agent.peekFollowUpQueue().length > 0 &&
			!host.canAutoContinueForFollowUp()
				? agent.peekFollowUpQueue().slice()
				: [];
		if (parkedFollowUps.length > 0) {
			agent.replaceQueues(agent.peekSteeringQueue().slice(), []);
		}
		host.beginWakeTurn();
		void agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: errorMessage(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					agent.replaceQueues(
						agent.peekSteeringQueue().slice(),
						parkedFollowUps.concat(agent.peekFollowUpQueue()),
					);
				}
				host.endWakeTurn();
			});
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's behalf: a no-tools
	 * side-channel turn over the current history (the `/btw` pipeline), queued in the inbox as an
	 * `irc:autoreply` aside so the model reads what was said for it, and sent back to the sender as a
	 * bus message (`replyTo: msg.id`) so their parked `wait` or `await:true` resolves. A failure is
	 * logged and the sender reaches its wait timeout.
	 */
	async #autoReply(msg: IrcMessage): Promise<void> {
		const host = this.#host;
		try {
			const { replyText } = await host.runEphemeralTurn({
				promptText: prompt.render(sideChannelPrompts["side-channel/irc-autoreply"].text, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || host.isDisposed()) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			host.emitIrcMessage(record);
			// Asides drain at the next step boundary; one left over is flushed at the start of the
			// next prompt (flushPending).
			this.inbox.queueAside(record);
			// `from` is the id the sender addressed (msg.to), so their from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: errorMessage(error) });
		}
	}
}
