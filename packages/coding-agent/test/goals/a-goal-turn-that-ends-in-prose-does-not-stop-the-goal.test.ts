/**
 * WHY: a goal stopped mid-work. The model answered the `/goal` objective with "I'll do it." and no
 * tool call, the turn ended, and nothing else happened: the status line still read `Goal`, and no
 * continuation ever opened. The same stop followed any continuation turn that ended in prose, such
 * as a status report that the goal "remains active and incomplete".
 *
 * Goal mode read a settled turn without a tool call as the model having nothing left to do, and
 * latched the next continuation off. A visible user turn (the `/goal` objective is one) latched it
 * off the same way. Only the goal tool finishes a goal, so a turn that ends in prose is a turn that
 * did not finish, and the continuation it leaves behind is still owed.
 *
 * The class this closes: no settled turn, whoever opened it, stops a goal in silence. The
 * continuation after a turn without a tool call states that the turn did no work, so a model that
 * answered with a status report is steered back to it. A run of turns that only talk is BOUNDED
 * and REPORTED, so a model that never calls a tool cannot spin the goal forever, and a message
 * from the operator restarts it.
 *
 * What it does not catch: a goal paused through the abort path, a turn that never settles, and a
 * continuation the session declines to run after goal mode submitted it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Message } from "@veyyon/ai";
import type { MockHandler, MockResponse } from "@veyyon/ai/providers/mock";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createGoalSession, flushMicrotasks, type GoalSession, NOTE_TOOL } from "../helpers/goal-session";

const prose = (text: string): MockResponse => ({ content: [text], stopReason: "stop" });
const toolCall = (id: string): MockResponse => ({
	content: [{ type: "toolCall", id, name: NOTE_TOOL, arguments: {} }],
});

const IDLE_STAND_DOWN = "Goal mode stopped driving after 3 turns without a tool call. Send a message to resume it.";

/** The continuation prompt's opening line, so a continuation is told apart from the other user-role context. */
const CONTINUATION = "Continue work on the active goal.";

function textOf(message: Message): string {
	if (message.role !== "user" && message.role !== "developer") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Answer with `response`, recording the continuation prompt the request carried. Read when the
 * request is made: the context a provider receives is not a snapshot the test can read later.
 */
function recording(sent: Array<string | undefined>, response: MockResponse): MockHandler {
	return context => {
		sent.push(context.messages.map(textOf).findLast(text => text.includes(CONTINUATION)));
		return response;
	};
}

describe("a goal turn that ends in prose leaves the goal driving", () => {
	let goal: GoalSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	const build = async (responses: MockHandler[], goalEnabled = true): Promise<GoalSession> => {
		goal = await createGoalSession(responses, { "goal.enabled": goalEnabled });
		return goal;
	};

	const createGoal = async (g: GoalSession): Promise<void> => {
		await g.session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();
	};

	/** Open the continuation goal mode owes and run it; fail when goal mode opened none. */
	const runContinuation = async (g: GoalSession, label: string): Promise<void> => {
		const input = await g.awaitContinuation();
		expect(input?.customType).toBe("goal-continuation");
		if (!input) throw new Error(`Expected goal mode to open ${label}`);
		await g.runSubmission(input);
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		await goal?.dispose();
		goal = undefined;
	});

	it("opens a continuation after the objective turn only says what it will do", async () => {
		// The reported shape, through the command a user types: `/goal <objective>` submits the
		// objective as a visible user turn, and the model answers it in prose.
		const g = await build([prose("I'll do it."), toolCall("tc-1"), prose("first step done")]);
		const submitted: SubmittedUserInput[] = [];
		void g.mode.getUserInput().then(input => submitted.push(input));
		await flushMicrotasks();
		await g.mode.handleGoalModeCommand("Ship the release");
		await flushMicrotasks();
		const objective = submitted.at(0);
		if (!objective) throw new Error("Expected /goal to submit the objective as a user turn");
		expect(objective.customType).toBeUndefined();
		await g.runSubmission(objective);

		await runContinuation(g, "a continuation after the objective turn");
		expect(g.stopReasons).toEqual(["stop", "stop"]);
		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
		expect(g.warnings).toEqual([]);
	});

	it("opens the next continuation after a continuation turn that ends in prose", async () => {
		const g = await build([prose("Step 3 finished; more of the goal remains."), toolCall("tc-1"), prose("ok")]);
		await createGoal(g);

		await runContinuation(g, "its first continuation turn");
		await runContinuation(g, "a continuation after the prose turn");
		expect(g.warnings).toEqual([]);
	});

	it("stops driving and says so after three consecutive turns without a tool call", async () => {
		const g = await build([prose("one"), prose("two"), prose("three")]);
		await createGoal(g);

		for (let turn = 1; turn <= 3; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}

		expect(g.mock.calls).toHaveLength(3);
		// The bound terminates: no fourth turn, and the operator is told why the goal went quiet.
		expect(await g.awaitContinuation()).toBeUndefined();
		expect(g.warnings).toEqual([IDLE_STAND_DOWN]);
	});

	it("tells the model its last turns did no work, and stops saying so once a turn does", async () => {
		// The provider's view of each continuation: the first follows goal creation, the second and
		// third follow prose-only turns, the fourth follows a turn that called a tool.
		const sent: Array<string | undefined> = [];
		const script = [prose("one"), prose("two"), toolCall("tc-1"), prose("worked"), prose("after")];
		const g = await build(script.map(response => recording(sent, response)));
		await createGoal(g);

		for (let turn = 1; turn <= 4; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}

		// Requests 0, 1, 2 and 4 open continuation turns; request 3 returns the tool's result.
		expect(sent).toHaveLength(5);
		const [first, second, third, , fourth] = sent.map(text => {
			if (text === undefined) throw new Error("A request reached the provider with no continuation prompt");
			return text;
		});
		expect(first).not.toContain("without a tool call");
		expect(second).toContain("Your previous turn ended without a tool call");
		expect(third).toContain("Your last 2 turns ended without a tool call");
		expect(fourth).not.toContain("without a tool call");
	});

	it("counts only CONSECUTIVE idle turns, so a turn that calls a tool clears the tally", async () => {
		// Two prose turns, a working turn, then two more prose turns: four idle turns in five and
		// the bound is still not reached. A tally that never resets would stand a working goal down.
		const g = await build([
			prose("one"),
			prose("two"),
			toolCall("tc-1"),
			prose("worked"),
			prose("four"),
			prose("five"),
		]);
		await createGoal(g);

		for (let turn = 1; turn <= 5; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}

		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
		expect(g.warnings).toEqual([]);
	});

	it("drives again when the operator sends a message after the bound stopped it", async () => {
		const g = await build([prose("one"), prose("two"), prose("three"), prose("on it")]);
		await createGoal(g);
		for (let turn = 1; turn <= 3; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}
		expect(await g.awaitContinuation()).toBeUndefined();

		// The message is fresh instruction: the stand-down clears and the idle tally starts over,
		// so the operator's own prose-only reply is the first idle turn, not the fourth.
		await g.runUserTurn("keep going");

		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
		expect(g.warnings).toEqual([IDLE_STAND_DOWN]);
	});

	it("says nothing about a goal when turns without a tool call run in a session with no goal", async () => {
		// Hidden turns, so no visible user message starts the tally over between them: the only
		// thing keeping the stand-down out of this session is that no goal is running.
		const g = await build([prose("one"), prose("two"), prose("three")], false);

		for (const text of ["first", "second", "third"]) {
			await g.runSubmission({ text, customType: "extension-tick", display: false, cancelled: false, started: true });
		}

		expect(g.stopReasons).toEqual(["stop", "stop", "stop"]);
		expect(g.warnings).toEqual([]);
	});
});
