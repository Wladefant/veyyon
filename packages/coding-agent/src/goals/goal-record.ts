/**
 * How a goal is written to a session branch and read back from it.
 *
 * The runtime records a goal each time a tool call spends tokens on it, so a crash loses no
 * usage. A `mode_change` holding the whole goal on each of those records repeated the objective
 * once per tool call: one long goal session held 43,000 of them, 97MB of a 720MB transcript,
 * every byte parsed again on resume.
 *
 * A goal's objective is fixed for its id: `createGoal` and `replaceGoal` mint a new id for a new
 * objective. So a `mode_change` records the whole goal when its id, mode, status or budget
 * changes, and a `goal_progress` custom entry records the counters in between. A reader takes the
 * goal from the last `mode_change` on the branch and the counters from a `goal_progress` of that
 * goal written after it. A build that predates `goal_progress` ignores those entries and restores
 * the goal with the counters of its last `mode_change`.
 */
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { isRecord } from "@veyyon/utils/type-guards";
import type { Goal, GoalModeState } from "./state";

export const GOAL_PROGRESS_CUSTOM_TYPE = "goal_progress";

/** The modes a goal is recorded under; `none` records that the session has no goal. */
export type GoalRecordMode = "goal" | "goal_paused" | "none";

/** A goal's counters, and the id, mode, status and budget they were counted under. */
export interface GoalProgressData {
	mode: Exclude<GoalRecordMode, "none">;
	goalId: string;
	status: Goal["status"];
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	turnsCompleted: number;
	updatedAt: number;
}

type BranchReader = Pick<SessionManager, "getLeafEntry" | "getEntry">;
type BranchWriter = BranchReader & Pick<SessionManager, "appendModeChange" | "appendCustomEntry">;

/**
 * The goal a `mode_change` holds, or undefined when it holds none that parses. Every field but the
 * budget and the turn count is required; a goal written before turns were counted reads as zero.
 */
function parseGoal(value: unknown): Goal | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		turnsCompleted: typeof value.turnsCompleted === "number" ? value.turnsCompleted : 0,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function parseProgress(entry: SessionEntry): GoalProgressData | undefined {
	if (entry.type !== "custom" || entry.customType !== GOAL_PROGRESS_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (
		!isRecord(data) ||
		(data.mode !== "goal" && data.mode !== "goal_paused") ||
		typeof data.goalId !== "string" ||
		typeof data.status !== "string" ||
		typeof data.tokensUsed !== "number" ||
		typeof data.timeUsedSeconds !== "number" ||
		typeof data.turnsCompleted !== "number" ||
		typeof data.updatedAt !== "number"
	) {
		return undefined;
	}
	return data as unknown as GoalProgressData;
}

/**
 * The goal record nearest the leaf of the active branch: a `mode_change` or a `goal_progress`.
 * Follows parent links from the leaf, so it reads only the entries between the leaf and that
 * record; a parent chain that loops ends the walk.
 */
function nearestGoalRecord(session: BranchReader): SessionEntry | undefined {
	const visited = new Set<string>();
	let entry = session.getLeafEntry();
	while (entry && !visited.has(entry.id)) {
		if (entry.type === "mode_change" || (entry.type === "custom" && entry.customType === GOAL_PROGRESS_CUSTOM_TYPE)) {
			return entry;
		}
		visited.add(entry.id);
		entry = entry.parentId ? session.getEntry(entry.parentId) : undefined;
	}
	return undefined;
}

/** True when `record` counts the same goal as `goal`, under the same mode, status and budget. */
function continuesRecord(record: SessionEntry | undefined, mode: GoalProgressData["mode"], goal: Goal): boolean {
	if (!record) return false;
	if (record.type === "mode_change") {
		const recorded = isRecord(record.data) ? record.data.goal : undefined;
		return (
			record.mode === mode &&
			isRecord(recorded) &&
			recorded.id === goal.id &&
			recorded.status === goal.status &&
			recorded.tokenBudget === goal.tokenBudget &&
			typeof recorded.objective === "string"
		);
	}
	const progress = parseProgress(record);
	return (
		progress !== undefined &&
		progress.mode === mode &&
		progress.goalId === goal.id &&
		progress.status === goal.status &&
		progress.tokenBudget === goal.tokenBudget
	);
}

/**
 * Record a goal on the active branch: its counters when the nearest goal record is the same goal
 * in the same mode, status and budget, the whole goal otherwise.
 */
export function recordGoal(session: BranchWriter, mode: GoalRecordMode, state: GoalModeState | undefined): void {
	if (mode === "none") {
		session.appendModeChange("none");
		return;
	}
	if (!state) return;
	const { goal } = state;
	if (!continuesRecord(nearestGoalRecord(session), mode, goal)) {
		session.appendModeChange(mode, { goal });
		return;
	}
	const progress: GoalProgressData = {
		mode,
		goalId: goal.id,
		status: goal.status,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		turnsCompleted: goal.turnsCompleted,
		updatedAt: goal.updatedAt,
	};
	if (goal.tokenBudget !== undefined) progress.tokenBudget = goal.tokenBudget;
	session.appendCustomEntry(GOAL_PROGRESS_CUSTOM_TYPE, progress);
}

/**
 * The goal recorded on the active branch, from the `mode_change` data the session context
 * resolved: that record's goal, with the counters of a later `goal_progress` of the same goal.
 * Undefined when the record holds no goal that parses.
 */
export function readRecordedGoal(
	session: BranchReader,
	modeData: Record<string, unknown> | undefined,
): Goal | undefined {
	const goal = parseGoal(modeData?.goal);
	if (!goal) return undefined;
	const nearest = nearestGoalRecord(session);
	const progress = nearest ? parseProgress(nearest) : undefined;
	if (progress?.goalId !== goal.id) return goal;
	goal.tokensUsed = progress.tokensUsed;
	goal.timeUsedSeconds = progress.timeUsedSeconds;
	goal.turnsCompleted = progress.turnsCompleted;
	goal.updatedAt = progress.updatedAt;
	return goal;
}
