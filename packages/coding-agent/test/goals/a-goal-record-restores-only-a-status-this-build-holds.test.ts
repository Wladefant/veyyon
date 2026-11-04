/**
 * WHY: a goal record's status was read as any string and cast to `GoalStatus`. A record holding a
 * status no build writes (a hand-edited file, another fork's spelling, a status a later build adds)
 * restored a goal the runtime held as neither running nor finished while its card drew the badge
 * of a running one, and a usage record holding such a status overwrote the counters of the goal it
 * restored.
 *
 * The class this closes: a goal record field read back with a type the reader assumed rather than
 * checked. The sweep runs over `GOAL_STATUSES`, so a status added to the tuple is restored by this
 * suite without an edit, and the rejected spellings sit beside each status.
 *
 * What it does not catch: a field added to `Goal` that the reader copies without checking, which
 * the type checker does not flag when the reader spreads the record.
 */
import { describe, expect, it } from "bun:test";
import { GOAL_PROGRESS_CUSTOM_TYPE, readRecordedGoal } from "@veyyon/coding-agent/goals/goal-record";
import { GOAL_STATUSES } from "@veyyon/coding-agent/goals/state";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

function goalWithStatus(status: unknown) {
	return {
		id: "goal-1",
		objective: "Ship the release.",
		status,
		tokensUsed: 10,
		timeUsedSeconds: 1,
		turnsCompleted: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}

function progressWithStatus(status: unknown) {
	return {
		mode: "goal",
		goalId: "goal-1",
		status,
		tokensUsed: 99,
		timeUsedSeconds: 9,
		turnsCompleted: 3,
		updatedAt: 2,
	};
}

/** The goal a branch holding `records` restores, the way a resume reads it. */
function restore(records: (session: SessionManager) => void) {
	const session = SessionManager.inMemory();
	records(session);
	return readRecordedGoal(session, session.buildSessionContext().modeData);
}

const UNKNOWN_STATUSES: unknown[] = ["budget_limited", "Active", "", "running", 1, null];

describe("a goal record restores only a status this build holds", () => {
	for (const status of GOAL_STATUSES) {
		it(`restores a goal recorded as ${status}, with the counters of a later usage record`, () => {
			const goal = restore(session => {
				session.appendModeChange("goal", { goal: goalWithStatus(status) });
				session.appendCustomEntry(GOAL_PROGRESS_CUSTOM_TYPE, progressWithStatus(status));
			});
			expect(goal).toMatchObject({ status, tokensUsed: 99, turnsCompleted: 3 });
		});
	}

	for (const status of UNKNOWN_STATUSES) {
		it(`restores no goal from a record whose status is ${JSON.stringify(status)}`, () => {
			expect(restore(session => session.appendModeChange("goal", { goal: goalWithStatus(status) }))).toBeUndefined();
		});

		it(`keeps the goal's own counters past a usage record whose status is ${JSON.stringify(status)}`, () => {
			const goal = restore(session => {
				session.appendModeChange("goal", { goal: goalWithStatus("active") });
				session.appendCustomEntry(GOAL_PROGRESS_CUSTOM_TYPE, progressWithStatus(status));
			});
			expect(goal).toMatchObject({ status: "active", tokensUsed: 10, turnsCompleted: 1 });
		});
	}
});
