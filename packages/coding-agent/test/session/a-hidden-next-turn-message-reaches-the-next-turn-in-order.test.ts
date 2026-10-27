/**
 * WHY: hidden messages (an extension's `nextTurn` delivery, an advisor card parked mid-abort, a
 * `session_stop` continuation) wait in one queue for the next turn, and a message that asks for a
 * turn starts one on the queue. One collaborator, `NextTurnMessages`, holds the queue, and the
 * defects at that boundary share one shape: a message reaches the wrong turn, or none. A requested
 * turn that takes only its own message strands the ones parked before it; a turn that fails to
 * start loses the messages it took, or puts them back behind messages that arrived after them; a
 * removal that reorders what it keeps hands the model its context out of order.
 *
 * The class this closes is a queued message that leaves the queue without reaching a turn, or
 * reaches it out of order. The requested turn runs through the real `PostPromptTasks`.
 *
 * What it does not catch: whether `AgentSession` drains the queue into every prompt and clears it on
 * every new transcript, branch, handoff and switch (`agent-session-concurrent`,
 * `agent-session-advisor-suppression` and the session switch suites drive those through a real
 * session). Two turns requested in one prompt generation each start on the queue as it stands,
 * because `PostPromptTasks.schedule` starts a task at once; the suite does not pin whether they run
 * as one turn or two.
 */
import { describe, expect, it } from "bun:test";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { NextTurnMessages } from "@veyyon/coding-agent/session/runtime/next-turn-messages";
import { PostPromptTasks } from "@veyyon/coding-agent/session/runtime/post-prompt-tasks";

interface Harness {
	readonly queue: NextTurnMessages;
	readonly postPrompt: PostPromptTasks;
	/** Each turn started: its message's content, then the prepended contents. */
	readonly turns: { message: string; prepended: string[] }[];
	/** When set, the next turn start fails after recording itself. */
	failNext: boolean;
}

function harness(): Harness {
	const state = { turns: [] as Harness["turns"], failNext: false };
	const postPrompt = new PostPromptTasks({ promptGeneration: () => 0 });
	const queue = new NextTurnMessages({
		promptGeneration: () => 0,
		postPrompt,
		promptWith: async (message, prepended) => {
			state.turns.push({ message: String(message.content), prepended: prepended.map(m => String(m.content)) });
			if (state.failNext) {
				state.failNext = false;
				throw new Error("turn did not start");
			}
		},
	});
	return Object.assign(state, { queue, postPrompt });
}

function aside(content: string, customType = "aside"): CustomMessage {
	return { role: "custom", customType, content, display: false, attribution: "agent", timestamp: 0 };
}

const contents = (messages: CustomMessage[]): string[] => messages.map(m => String(m.content));

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
		expect(contents(h.queue.take())).toEqual(["one", "two"]);
		expect(h.queue.take()).toEqual([]);
	});

	it("puts the messages of a turn that failed to start back ahead of later ones", async () => {
		const h = harness();
		h.queue.queue(aside("parked"), false);
		h.failNext = true;
		h.queue.queue(aside("wake"), true);
		// Arrives while the failing turn is starting.
		h.queue.queue(aside("late"), false);
		await h.postPrompt.drained;

		expect(h.turns).toEqual([{ message: "wake", prepended: ["parked"] }]);
		expect(contents(h.queue.take())).toEqual(["parked", "wake", "late"]);
	});

	it("removes the messages a predicate matches and keeps the rest in order", () => {
		const h = harness();
		h.queue.queue(aside("one"), false);
		h.queue.queue(aside("card one", "advisor"), false);
		h.queue.queue(aside("two"), false);
		h.queue.queue(aside("card two", "advisor"), false);

		expect(contents(h.queue.remove(m => m.customType === "advisor"))).toEqual(["card one", "card two"]);
		expect(h.queue.remove(m => m.customType === "advisor")).toEqual([]);
		expect(contents(h.queue.take())).toEqual(["one", "two"]);
	});

	it("puts a snapshot's queue back over whatever was queued since, and clear empties it", () => {
		const h = harness();
		h.queue.queue(aside("kept"), false);
		const snapshot = h.queue.snapshot();
		h.queue.clear();
		expect(h.queue.count).toBe(0);
		h.queue.queue(aside("dropped"), false);
		h.queue.restore(snapshot);

		expect(contents(h.queue.take())).toEqual(["kept"]);
	});
});
