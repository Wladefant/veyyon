/**
 * WHY: `IrcDelivery.deliver` picks where an arriving IRC message goes from what it reads the
 * moment the message lands: whether a turn is streaming, whether plan mode is on, whether async
 * execution is on, who sent it, and whether the sender is blocked on an answer. Each wrong pick has
 * its own cost. A peer's message steered into a running turn reads as the parent's instruction; a
 * parent's message left in the inbox waits for a step boundary the turn may never reach; an idle
 * message appended without a turn outside plan mode is never answered; a message delivered by two
 * routes is read twice. The auto-reply has a second failure: the `irc:incoming` record tells the
 * model whether a reply already went out, so a decision that disagrees with that record sends two
 * answers (the record says nobody replied, and the model replies again) or none (the record says a
 * reply went out, and the sender's `send await:true` waits out its timeout).
 *
 * The class this closes is a route or an auto-reply decision that is wrong for any combination of
 * those five inputs. The suite sweeps their full product against one oracle and requires exactly
 * one route per message. It observes the auto-reply where the sender reads it, a parked
 * `IrcBus.wait`, which is what `send await:true` blocks on.
 *
 * What it does not catch: whether `AgentSession` builds the host so these reads reflect the live
 * session, which the session suites `agent-session-plan-mode-convergence` and
 * `agent-session-advisor-suppression` drive through a real `AgentSession`, and how a wake turn
 * parks and restores a blocked follow-up, which `agent-session-advisor-suppression` covers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent, AgentMessage, AgentPromptOptions } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { EphemeralTurnArgs, EphemeralTurnResult } from "@veyyon/coding-agent/session/agent-session-ephemeral-turn";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import {
	IrcDelivery,
	type IrcDeliveryAgent,
	type IrcDeliveryHost,
} from "@veyyon/coding-agent/session/runtime/irc-delivery";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";

const PARENT = "Lead";
const PEER = "Sibling";
const RECIPIENT = "Worker";
const BODY = "Is the tokenizer change in yet?";
const AUTO_REPLY = "The tokenizer change is in; the parser is next.";

interface Arrival {
	streaming: boolean;
	planMode: boolean;
	asyncEnabled: boolean;
	sender: typeof PARENT | typeof PEER;
	expectsReply: boolean;
}

type Route = "steered" | "inbox" | "context" | "woken";

/** Where the message must go: a running turn takes it by sender, an idle one by plan mode. */
function expectedRoute(arrival: Arrival): Route {
	if (arrival.streaming) return arrival.sender === PARENT ? "steered" : "inbox";
	return arrival.planMode ? "context" : "woken";
}

/**
 * Whether the recipient answers for itself: only for a sender blocked on a reply, and only when no
 * real reply turn can come in time — mid-turn with async execution off, or idle in plan mode.
 */
function expectedAutoReply(arrival: Arrival): boolean {
	if (!arrival.expectsReply) return false;
	return arrival.streaming ? !arrival.asyncEnabled : arrival.planMode;
}

const ARRIVALS: Arrival[] = [];
for (const streaming of [false, true]) {
	for (const planMode of [false, true]) {
		for (const asyncEnabled of [false, true]) {
			for (const sender of [PARENT, PEER] as const) {
				for (const expectsReply of [false, true]) {
					ARRIVALS.push({ streaming, planMode, asyncEnabled, sender, expectsReply });
				}
			}
		}
	}
}

function label(arrival: Arrival): string {
	return [
		arrival.streaming ? "mid-turn" : "idle",
		arrival.planMode ? "plan mode" : "no plan mode",
		arrival.asyncEnabled ? "async on" : "async off",
		arrival.sender === PARENT ? "from the parent" : "from a peer",
		arrival.expectsReply ? "reply awaited" : "no reply awaited",
	].join(", ");
}

/** The agent queues and turn entry points a delivery drives, recording what reached each. */
class RecordingAgent implements IrcDeliveryAgent {
	readonly steered: AgentMessage[] = [];
	readonly prompted: AgentMessage[][] = [];
	readonly external: AgentEvent[] = [];
	#steering: AgentMessage[] = [];
	#followUp: AgentMessage[] = [];

	steer(message: AgentMessage): void {
		this.steered.push(message);
		this.#steering.push(message);
	}
	prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
		if (typeof input === "string") throw new Error("an IRC wake prompts with records, never text");
		this.prompted.push(Array.isArray(input) ? input : [input]);
	}
	hasQueuedMessages(): boolean {
		return this.#steering.length > 0 || this.#followUp.length > 0;
	}
	peekSteeringQueue(): readonly AgentMessage[] {
		return this.#steering;
	}
	peekFollowUpQueue(): readonly AgentMessage[] {
		return this.#followUp;
	}
	replaceQueues(steering: AgentMessage[], followUp: AgentMessage[]): void {
		this.#steering = steering;
		this.#followUp = followUp;
	}
	emitExternalEvent(event: AgentEvent): void {
		this.external.push(event);
	}
}

/** A session in the state `arrival` describes, whose side-channel turn answers with {@link AUTO_REPLY}. */
class ArrivalHost implements IrcDeliveryHost {
	readonly agent = new RecordingAgent();
	readonly cards: CustomMessage[] = [];
	readonly context: CustomMessage[] = [];
	readonly #arrival: Arrival;

	constructor(arrival: Arrival) {
		this.#arrival = arrival;
	}

	isDisposed(): boolean {
		return false;
	}
	isStreaming(): boolean {
		return this.#arrival.streaming;
	}
	planModeEnabled(): boolean {
		return this.#arrival.planMode;
	}
	asyncEnabled(): boolean {
		return this.#arrival.asyncEnabled;
	}
	emitIrcMessage(record: CustomMessage): void {
		this.cards.push(record);
	}
	appendToContext(record: CustomMessage): void {
		this.context.push(record);
	}
	canAutoContinueForFollowUp(): boolean {
		return true;
	}
	beginWakeTurn(): void {}
	endWakeTurn(): void {}
	async runEphemeralTurn(_args: EphemeralTurnArgs): Promise<EphemeralTurnResult> {
		return {
			replyText: AUTO_REPLY,
			assistantMessage: {
				role: "assistant",
				content: [{ type: "text", text: AUTO_REPLY }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		};
	}
}

function textOf(record: CustomMessage): string {
	if (typeof record.content === "string") return record.content;
	return record.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("an IRC message goes where the recipient's state at arrival sends it", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = AgentRegistry.global();
		registry.register({ id: PARENT, displayName: PARENT, kind: "main", session: null });
		registry.register({ id: PEER, displayName: PEER, kind: "sub", parentId: PARENT, session: null });
		registry.register({ id: RECIPIENT, displayName: RECIPIENT, kind: "sub", parentId: PARENT, session: null });
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	for (const arrival of ARRIVALS) {
		it(label(arrival), async () => {
			const host = new ArrivalHost(arrival);
			const delivery = new IrcDelivery(host);
			const bus = IrcBus.global();
			const message: IrcMessage = { id: "msg-1", from: arrival.sender, to: RECIPIENT, body: BODY, ts: 1 };
			// What `send await:true` parks on: the recipient's answer, filtered to the recipient.
			const replyWait = bus.wait(arrival.sender, { from: RECIPIENT }, 0);

			const outcome = delivery.deliver(message, { expectsReply: arrival.expectsReply });
			// The side-channel turn and the bus hand-off settle on microtasks; one macrotask drains them.
			await delay(0);

			const route = expectedRoute(arrival);
			expect(outcome).toBe(route === "woken" ? "woken" : "injected");

			const waiting = delivery.inbox.takeAll();
			const routes: Route[] = [];
			if (host.agent.steered.length > 0) routes.push("steered");
			if (waiting.some(record => record.customType === "irc:incoming")) routes.push("inbox");
			if (host.context.some(record => record.customType === "irc:incoming")) routes.push("context");
			if (host.agent.prompted.length > 0) routes.push("woken");
			expect(routes).toEqual([route]);

			if (route === "steered") {
				expect(host.agent.steered).toEqual([
					expect.objectContaining({ role: "user", steering: true, content: expect.stringContaining(BODY) }),
				]);
			}
			if (route === "woken") {
				expect(host.agent.prompted).toEqual([[expect.objectContaining({ customType: "irc:incoming" })]]);
			}

			// One card for the message, from its sender, whatever the route.
			const incomingCards = host.cards.filter(record => record.customType === "irc:incoming");
			expect(incomingCards).toHaveLength(1);
			const incoming = incomingCards[0]!;
			expect(incoming.details).toMatchObject({ id: "msg-1", from: arrival.sender, message: BODY });

			const autoReplied = expectedAutoReply(arrival);
			// The record the model reads states whether a reply already went out.
			expect(textOf(incoming).includes("Nobody replies on your behalf")).toBe(!autoReplied);

			const replies = bus
				.log()
				.filter(entry => entry.message.from === RECIPIENT && entry.message.to === arrival.sender);
			const autoReplyCards = host.cards.filter(record => record.customType === "irc:autoreply");
			const autoReplyAsides = waiting.filter(record => record.customType === "irc:autoreply");
			if (autoReplied) {
				expect(await replyWait).toMatchObject({
					from: RECIPIENT,
					to: arrival.sender,
					body: AUTO_REPLY,
					replyTo: "msg-1",
				});
				expect(replies).toHaveLength(1);
				expect(autoReplyCards).toHaveLength(1);
				// The model reads what was said for it at its next step boundary.
				expect(autoReplyAsides).toHaveLength(1);
				expect(autoReplyAsides[0]!.details).toMatchObject({
					to: arrival.sender,
					body: AUTO_REPLY,
					replyTo: "msg-1",
				});
			} else {
				expect(replies).toEqual([]);
				expect(autoReplyCards).toEqual([]);
				expect(autoReplyAsides).toEqual([]);
				bus.forgetAgents([arrival.sender]);
				expect(await replyWait).toBeNull();
			}
		});
	}
});
