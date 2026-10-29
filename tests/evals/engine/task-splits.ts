import type { TaskDescriptor } from "./contracts";

export const TASK_SPLIT_SIZES = {
	feedback: 20,
	score: 20,
	final: 60,
} as const;

export const DECLARED_SKILL_COHORT_SIZES = {
	80: { feedback: 16, score: 16, final: 48 },
	100: TASK_SPLIT_SIZES,
} as const;

export type DeclaredSkillCohortSize = keyof typeof DECLARED_SKILL_COHORT_SIZES;


export interface TaskSplits {
	readonly feedback: readonly TaskDescriptor[];
	readonly score: readonly TaskDescriptor[];
	readonly final: readonly TaskDescriptor[];
}
/**
 * Create fixed-size learning, scoring, and final sets. An 80-task split is
 * available only when callers pass the explicitly declared manifest size.
 */
export function splitTasks(tasks: readonly TaskDescriptor[], seed: string, declaredCohortSize?: number): TaskSplits {
	const sizes = declaredCohortSize === undefined
		? TASK_SPLIT_SIZES
		: DECLARED_SKILL_COHORT_SIZES[declaredCohortSize as DeclaredSkillCohortSize];
	const expectedCount = declaredCohortSize ?? 100;
	if (!sizes || tasks.length !== expectedCount) {
		throw new Error(
			declaredCohortSize === undefined
				? `Expected exactly 100 tasks for a 20/20/60 split; received ${tasks.length}.`
				: `Expected a declared 80-task cohort for a 16/16/48 split; received ${tasks.length}.`,
		);
	}
	if (!seed) throw new Error("A non-empty split seed is required.");

	const byId = new Map<string, TaskDescriptor>();
	for (const task of tasks) {
		if (!task.id) throw new Error("Task ids must be non-empty.");
		if (byId.has(task.id)) throw new Error(`Duplicate task id in split input: ${task.id}`);
		byId.set(task.id, task);
	}

	const ordered = [...byId.values()].sort((left, right) => {
		const leftHash = hash(`${seed}\0${left.id}`);
		const rightHash = hash(`${seed}\0${right.id}`);
		return (
			(leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0) ||
			(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		);
	});
	return {
		feedback: ordered.slice(0, sizes.feedback),
		score: ordered.slice(sizes.feedback, sizes.feedback + sizes.score),
		final: ordered.slice(sizes.feedback + sizes.score),
	};
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string): string {
	let result = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16777619);
	}
	return (result >>> 0).toString(16).padStart(8, "0");
}
