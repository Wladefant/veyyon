/**
 * WHY: a session that had never enabled goal mode showed
 * "Goal mode stopped driving after 3 failed turns. Send a message to resume it."
 *
 * The goal controller's session handler is subscribed for EVERY session, not only a goal-driven
 * one. Its `agent_end` branch incremented the failed-turn tally and raised the stand-down warning
 * with no check that a goal was running, so three consecutive provider-killed turns in an ordinary
 * session announced that a goal nobody had started had given up. The action was already guarded —
 * the continuation block returns "goal-mode-off" — which is why nothing else was visibly wrong:
 * only the message escaped.
 *
 * The second defect is the same counter from the other side. The tally was never cleared when a
 * goal STARTED, so a session that had already banked failures entered goal mode mid-count and
 * stood the goal down on its first error instead of its third.
 *
 * The class this closes: the failed-turn counter and its warning belong to an ACTIVE goal, and a
 * goal begins its life on a clean slate. A turn that fails while no goal is running is not a goal
 * failure and cannot be banked against a goal that starts later.
 *
 * What it does not catch: a warning raised from a path other than the failed-turn counter (the
 * busy-timeout stand-down is guarded separately, by the same continuation block), and a fault that
 * produces no `agent_end` at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createGoalSession, flushMicrotasks, type GoalSession, TRANSIENT_FAULT } from "../helpers/goal-session";

/**
 * One turn the provider kills for good: the initial call plus the single retry
 * `retry.maxRetries: 1` allows, so the turn settles with `stopReason: "error"`.
 */
const KILLED_TURN = [{ throw: TRANSIENT_FAULT }, { throw: TRANSIENT_FAULT }];

/** The stand-down message this suite exists to keep out of a goal-less session. */
const STAND_DOWN = /Goal mode stopped driving/;

describe("the goal stand-down warning belongs to a goal that is actually running", () => {
	let goal: GoalSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	/**
	 * No goal is created here: every test in this suite is about what the counter does BEFORE one
	 * exists, so the goal (when a test wants one) is created mid-session through the runtime.
	 */
	const build = async (goalEnabled: boolean): Promise<GoalSession> => {
		goal = await createGoalSession([...KILLED_TURN, ...KILLED_TURN, ...KILLED_TURN], {
			"goal.enabled": goalEnabled,
		});
		return goal;
	};

	const createGoal = async (g: GoalSession, objective: string): Promise<void> => {
		await g.session.goalRuntime.createGoal({ objective });
		await flushMicrotasks();
	};

	const standDowns = (g: GoalSession): string[] => g.warnings.filter(warning => STAND_DOWN.test(warning));

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		await goal?.dispose();
		goal = undefined;
	});

	// The reported shape: goal mode never enabled, three consecutive provider-killed turns.
	it("says nothing about a goal when three turns fail and no goal was ever started", async () => {
		const g = await build(false);

		await g.runUserTurn("first");
		await g.runUserTurn("second");
		await g.runUserTurn("third");

		// Without this the suite could pass by never failing a turn at all.
		expect(g.stopReasons).toEqual(["error", "error", "error"]);
		expect(standDowns(g)).toEqual([]);
	});

	// Control: the stand-down is a real feature and must still fire for a goal that IS driving,
	// including when every failed turn was one the operator opened.
	it("still stands a running goal down on its third consecutive failed turn", async () => {
		const g = await build(true);
		await createGoal(g, "Ship the release");

		await g.runUserTurn("first");
		await g.runUserTurn("second");
		await g.runUserTurn("third");

		expect(g.stopReasons).toEqual(["error", "error", "error"]);
		expect(standDowns(g)).toEqual(["Goal mode stopped driving after 3 failed turns. Send a message to resume it."]);
	});

	/**
	 * The fragility half. The guard above means a turn can only be banked while a goal is running,
	 * so the stale count that matters is one an EARLIER goal left behind: without the reset the next
	 * goal inherits its predecessor's failures and stands down on its first error instead of its
	 * third.
	 */
	it("gives a new goal its full tolerance when an earlier goal already banked failures", async () => {
		const g = await build(true);
		await createGoal(g, "Ship the release");

		await g.runUserTurn("first");
		await g.runUserTurn("second");

		// The first goal ends carrying two failed turns.
		await g.session.goalRuntime.dropGoal();
		await flushMicrotasks();

		// A second goal starts. Its tolerance is its own, not what its predecessor spent.
		await createGoal(g, "Ship the next release");

		await g.runUserTurn("third");

		expect(g.stopReasons).toEqual(["error", "error", "error"]);
		expect(standDowns(g)).toEqual([]);
	});
});
