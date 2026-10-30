/**
 * WHY: a goal stopped mid-work. The model answered the `/goal` objective with "I'll do it." and no
 * tool call, the turn ended, and nothing else happened: the status line still read `Goal`, and no
 * continuation ever opened. The same stop followed any continuation turn that ended in prose.
 *
 * Goal mode read a settled turn without a tool call as the model having nothing left to do, and
 * latched the next continuation off. A visible user turn (the `/goal` objective is one) latched it
 * off the same way. Only the goal tool finishes a goal, so a turn that ends in prose is a turn that
 * did not finish, and the continuation it leaves behind is still owed.
 *
 * The class this closes: no settled turn, whoever opened it, stops a goal in silence. A run of
 * turns that only talk is BOUNDED and REPORTED instead, so a model that never calls a tool cannot
 * spin the goal forever, and a message from the operator restarts it.
 *
 * What it does not catch: a goal paused through the abort path, a turn that never settles, and a
 * continuation the session declines to run after goal mode submitted it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { MockResponse } from "@veyyon/ai/providers/mock";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createGoalSession, flushMicrotasks, type GoalSession, NOTE_TOOL } from "../helpers/goal-session";

const prose = (text: string): MockResponse => ({ content: [text], stopReason: "stop" });
const toolCall = (id: string): MockResponse => ({
	content: [{ type: "toolCall", id, name: NOTE_TOOL, arguments: {} }],
});

const IDLE_STAND_DOWN = "Goal mode stopped driving after 3 turns without a tool call. Send a message to resume it.";

describe("a goal turn that ends in prose leaves the goal driving", () => {
	let goal: GoalSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	const build = async (responses: MockResponse[], goalEnabled = true): Promise<GoalSession> => {
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
