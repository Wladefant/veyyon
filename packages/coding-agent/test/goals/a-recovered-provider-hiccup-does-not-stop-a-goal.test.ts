/**
 * WHY: an active goal stopped driving after a provider hiccup the session had already recovered
 * from. The footline still read `Goal`, the status line said "Recovered after 2 retries (1.5s
 * waiting) · provider hiccup", and then nothing happened until a human typed "keep going".
 *
 * Two mechanisms, both in the goal controller's session handler, both about a turn the transport
 * killed:
 *
 *   1. A RETRY LOOKED LIKE A NEW TURN. `#handleRetryableError` resumes the work with a fresh
 *      `agent_start`, and the handler reset the turn's tool-call evidence on every one. A
 *      continuation that called tools and then died came back as a retried attempt that only
 *      talked, and the goal counted the turn as one that did no work. The killed attempt's own
 *      `agent_end` never reaches the mode at all — it is held while the prompt is in flight and
 *      superseded by the recovery — so `auto_retry_start` is the only notice that the next
 *      `agent_start` is the same turn resuming.
 *   2. A KILLED TURN DECIDED THE GOAL'S FATE. When the retries were spent, the mode did see an
 *      `agent_end` whose last assistant message carried `stopReason: "error"`. A turn that never
 *      got to call anything fails a tool-call test by construction, so one exhausted hiccup
 *      stopped the goal.
 *
 * The class this closes: a turn the provider killed decides nothing about whether the goal keeps
 * driving. Tool-call evidence survives into the retry of the same turn, and the tolerance for
 * killed turns is BOUNDED and REPORTED so a provider that is genuinely gone cannot spin the goal
 * forever.
 *
 * What it does not catch: a fault that produces no `agent_end` at all (the process dies), a goal
 * paused through the abort path (`onTaskAborted`), or a stall whose cause is upstream of the mode
 * — a continuation the session refuses to run rather than one the mode declines to schedule.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import {
	createGoalSession,
	flushMicrotasks,
	type GoalSession,
	NOTE_TOOL,
	TRANSIENT_FAULT,
} from "../helpers/goal-session";

const toolCall = (id: string) => ({ content: [{ type: "toolCall" as const, id, name: NOTE_TOOL, arguments: {} }] });

describe("a goal keeps driving across a provider hiccup it recovered from", () => {
	let goal: GoalSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	const build = async (...args: Parameters<typeof createGoalSession>): Promise<GoalSession> => {
		goal = await createGoalSession(...args);
		await goal.session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();
		return goal;
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

	it("keeps the tool-call evidence a killed attempt already earned", async () => {
		// The reported shape. The continuation turn calls a tool, the transport dies, the session
		// retries, and the retried attempt only talks. The session's retry SUPERSEDES the killed
		// attempt's `agent_end`, so the only notice the mode gets that the turn was resumed is
		// `auto_retry_start` followed by a second `agent_start`. Two prose-only turns follow: with
		// the evidence kept they are the first and second idle turns and the goal keeps driving;
		// with it wiped they are the second and third, and the goal stands down.
		const g = await build([
			toolCall("tc-1"),
			{ throw: TRANSIENT_FAULT },
			{ content: ["talked only"] },
			{ content: ["turn two"] },
			{ content: ["turn three"] },
		]);

		await runContinuation(g, "the retried turn");
		// One settle reaches the mode, and it is the recovery, not the fault.
		expect(g.stopReasons).toEqual(["stop"]);
		await runContinuation(g, "the second turn");
		await runContinuation(g, "the third turn");

		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
		expect(g.warnings).toEqual([]);
	});

	/** Control: a retry that itself does the work needs no evidence carried across. */
	it("drives another continuation when the retried attempt is the one that calls a tool", async () => {
		const g = await build([
			{ throw: TRANSIENT_FAULT },
			toolCall("tc-1"),
			{ content: ["kept going"], stopReason: "stop" },
			toolCall("tc-2"),
			{ content: ["still going"], stopReason: "stop" },
		]);

		await runContinuation(g, "its first continuation turn");
		expect(g.stopReasons).toEqual(["stop"]);

		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
	});

	it("stops driving and says so once three consecutive turns die, instead of retrying forever", async () => {
		const g = await build([{ throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }], {
			"retry.maxRetries": 0,
		});

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await runContinuation(g, `continuation turn ${attempt}`);
		}

		expect(g.stopReasons).toEqual(["error", "error", "error"]);
		expect(g.mock.calls).toHaveLength(3);
		// The bound terminates: no fourth turn, and the operator is told why the goal went quiet.
		expect(await g.awaitContinuation()).toBeUndefined();
		expect(g.warnings).toEqual(["Goal mode stopped driving after 3 failed turns. Send a message to resume it."]);
	});

	it("counts only CONSECUTIVE deaths, so a turn that lands clears the tally", async () => {
		// Two deaths, a working turn, then two more deaths: five error-or-recovered turns and
		// the bound is still not reached, because the working turn reset it. A tally that never
		// resets would stand the goal down in the middle of a session that is making progress.
		const g = await build(
			[
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				toolCall("tc-1"),
				{ content: ["worked"], stopReason: "stop" },
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
			],
			{ "retry.maxRetries": 0 },
		);

		for (let turn = 1; turn <= 5; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}

		expect(g.stopReasons).toEqual(["error", "error", "stop", "error", "error"]);
		expect(g.warnings).toEqual([]);
	});

	it("resumes driving when the operator sends a message after the bound stopped it", async () => {
		const g = await build(
			[
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				{ throw: TRANSIENT_FAULT },
				toolCall("tc-1"),
				{ content: ["back to work"], stopReason: "stop" },
				{ throw: TRANSIENT_FAULT },
				toolCall("tc-2"),
				{ content: ["still working"], stopReason: "stop" },
			],
			{ "retry.maxRetries": 0 },
		);

		for (let turn = 1; turn <= 3; turn += 1) {
			await runContinuation(g, `continuation turn ${turn}`);
		}
		expect(await g.awaitContinuation()).toBeUndefined();
		expect(g.warnings).toHaveLength(1);

		// What the warning tells the operator to do, done: a visible user turn that resumes
		// execution clears the stand-down.
		await g.runUserTurn("keep going");

		// And the tally went with it: the operator's turn landed, so one death after the resume is
		// the FIRST death again, not the fourth, and the goal keeps driving instead of standing down
		// a second time.
		await runContinuation(g, "a continuation after the operator's turn");
		expect(g.stopReasons.at(-1)).toBe("error");
		expect((await g.awaitContinuation())?.customType).toBe("goal-continuation");
		expect(g.warnings).toHaveLength(1);
	});
});
