/**
 * WHY: hidden messages (an extension's `nextTurn` delivery, an advisor card parked mid-abort, a
 * `session_stop` continuation) wait in one queue for the next turn, and a message that asks for a
 * turn starts one on the queue. One collaborator, `NextTurnMessages`, holds the queue, and the
 * defects at that boundary share one shape: a message reaches the wrong turn, or none. A requested
 * turn that takes only its own message strands the ones parked before it; a turn that fails or never
 * starts loses the messages it took, or puts them back behind messages that arrived after them; a
 * turn the agent took puts them back anyway and sends them twice; a removal that reorders what it
 * keeps hands the model its context out of order, and one that misses what a prompt holds lets an
 * interrupt's own handling of the queue skip it.
 *
 * The class this closes is a queued message that leaves the queue without reaching a turn, reaches
 * two, or reaches one out of order. The requested turn runs through the real `PostPromptTasks`.
 *
 * What it does not catch: whether `AgentSession` leases the queue into every prompt, settles the
 * lease when the agent takes the input and clears the queue on every new transcript, branch, handoff
 * and switch (`a-message-queued-for-the-next-turn-survives-a-prompt-that-never-starts`,
 * `agent-session-concurrent`, `agent-session-advisor-suppression` and the session switch suites drive
 * those through a real session). Two turns requested in one prompt generation each start on the
 * queue as it stands, because `PostPromptTasks.schedule` starts a task at once; the suite does not
 * pin whether they run as one turn or two.
 */
import { describe, expect, it } from "bun:test";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { NextTurnMessages } from "@veyyon/coding-agent/session/runtime/next-turn-messages";
import { PostPromptTasks } from "@veyyon/coding-agent/session/runtime/post-prompt-tasks";

/** How a requested turn's start ends: the agent takes it, it throws before or after, or it never starts. */
type StartOutcome = "accept" | "fail" | "accept-then-fail" | "never-start";

interface Harness {
	readonly queue: NextTurnMessages;
	readonly postPrompt: PostPromptTasks;
	/** Each turn started: its message's content, then the prepended contents. */
	readonly turns: { message: string; prepended: string[] }[];
	/** How the next turn start ends; reset to `accept` once used. */
	next: StartOutcome;
}

function harness(): Harness {
	const state: { turns: Harness["turns"]; next: StartOutcome } = { turns: [], next: "accept" };
	const postPrompt = new PostPromptTasks({ promptGeneration: () => 0 });
	const queue = new NextTurnMessages({
		promptGeneration: () => 0,
		postPrompt,
		promptWith: async (message, prepended) => {
			state.turns.push({ message: String(message.content), prepended: contents(prepended.messages) });
			const outcome = state.next;
			state.next = "accept";
			if (outcome === "accept" || outcome === "accept-then-fail") prepended.settle();
			if (outcome === "fail" || outcome === "accept-then-fail") throw new Error("turn failed");
		},
	});
	return Object.assign(state, { queue, postPrompt });
}

function aside(content: string, customType = "aside"): CustomMessage {
	return { role: "custom", customType, content, display: false, attribution: "agent", timestamp: 0 };
}

const contents = (messages: readonly CustomMessage[]): string[] => messages.map(m => String(m.content));

/** Everything queued, in order, leased and settled the way a prompt the agent took does. */
function drain(queue: NextTurnMessages): string[] {
	const lease = queue.lease();
	lease.settle();
	return contents(lease.messages);
}

describe("NextTurnMessages", () => {
	it("starts a requested turn on the requesting message with every message parked before it", async () => {
		const h = harness();
		h.queue.queue(aside("parked one"), false);
		h.queue.queue(aside("parked two"), false);
		h.queue.queue(aside("wake"), true);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([{ message: "wake", prepended: ["parked one", "parked two"] }]);
		expect(h.queue.count).toBe(0);
	});

	it("starts no turn for messages queued without one, and a prompt takes them in order", async () => {
		const h = harness();
		h.queue.queue(aside("one"), false);
		h.queue.queue(aside("two"), false);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([]);
		expect(h.queue.count).toBe(2);
		expect(drain(h.queue)).toEqual(["one", "two"]);
		expect(drain(h.queue)).toEqual([]);
	});

	it("puts the messages of a turn that failed to start back ahead of later ones", async () => {
		const h = harness();
		h.queue.queue(aside("parked"), false);
		h.next = "fail";
		h.queue.queue(aside("wake"), true);
		// Arrives while the failing turn is starting.
		h.queue.queue(aside("late"), false);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([{ message: "wake", prepended: ["parked"] }]);
		expect(drain(h.queue)).toEqual(["parked", "wake", "late"]);
	});

	it("puts back the messages parked before a requested turn that never starts, and drops its own", async () => {
		const h = harness();
		h.queue.queue(aside("parked"), false);
		h.next = "never-start";
		h.queue.queue(aside("wake"), true);
		h.queue.queue(aside("late"), false);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([{ message: "wake", prepended: ["parked"] }]);
		expect(drain(h.queue)).toEqual(["parked", "late"]);
	});

	it("puts nothing back once the agent took the turn, even when the turn then fails", async () => {
		const h = harness();
		h.queue.queue(aside("parked"), false);
		h.next = "accept-then-fail";
		h.queue.queue(aside("wake"), true);
		h.queue.queue(aside("late"), false);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([{ message: "wake", prepended: ["parked"] }]);
		expect(drain(h.queue)).toEqual(["late"]);
	});

	it("puts a released lease back ahead of later messages, once, and a settled one never", () => {
		const h = harness();
		h.queue.queue(aside("one"), false);
		h.queue.queue(aside("two"), false);
		const released = h.queue.lease();
		expect(h.queue.count).toBe(0);
		h.queue.queue(aside("late"), false);
		released.release();
		released.release();
		released.settle();

		expect(contents(released.messages)).toEqual(["one", "two"]);
		const settled = h.queue.lease();
		settled.settle();
		settled.release();

		expect(contents(settled.messages)).toEqual(["one", "two", "late"]);
		expect(h.queue.count).toBe(0);
	});

	it("removes the messages a predicate matches and keeps the rest in order", () => {
		const h = harness();
		h.queue.queue(aside("one"), false);
		h.queue.queue(aside("card one", "advisor"), false);
		h.queue.queue(aside("two"), false);
		h.queue.queue(aside("card two", "advisor"), false);

		expect(contents(h.queue.remove(m => m.customType === "advisor"))).toEqual(["card one", "card two"]);
		expect(h.queue.remove(m => m.customType === "advisor")).toEqual([]);
		expect(drain(h.queue)).toEqual(["one", "two"]);
	});

	it("removes what a prompt holds, leased first, and a release puts back only the rest", () => {
		const h = harness();
		h.queue.queue(aside("leased"), false);
		h.queue.queue(aside("leased card", "advisor"), false);
		const lease = h.queue.lease();
		h.queue.queue(aside("queued card", "advisor"), false);
		h.queue.queue(aside("queued"), false);

		expect(contents(h.queue.remove(m => m.customType === "advisor"))).toEqual(["leased card", "queued card"]);
		lease.release();

		expect(drain(h.queue)).toEqual(["leased", "queued"]);
	});

	it("drops what a prompt holds on a clear, so its release puts nothing back", () => {
		const h = harness();
		h.queue.queue(aside("old session"), false);
		const lease = h.queue.lease();
		h.queue.clear();
		h.queue.queue(aside("new session"), false);
		lease.release();

		expect(drain(h.queue)).toEqual(["new session"]);
	});

	it("puts a snapshot's queue back over whatever was queued since, and clear empties it", () => {
		const h = harness();
		h.queue.queue(aside("kept"), false);
		const snapshot = h.queue.snapshot();
		h.queue.clear();
		expect(h.queue.count).toBe(0);
		h.queue.queue(aside("dropped"), false);
		h.queue.restore(snapshot);

		expect(drain(h.queue)).toEqual(["kept"]);
	});
});
