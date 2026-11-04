import type { TaskDescriptor } from "./contracts";

export const TASK_SPLIT_SIZES = {
	feedback: 20,
	score: 20,
	final: 60,
} as const;

export interface TaskSplits {
	readonly feedback: readonly TaskDescriptor[];
	readonly score: readonly TaskDescriptor[];
	readonly final: readonly TaskDescriptor[];
}

/**
 * Create the fixed-size learning, candidate-scoring, and final-evaluation sets.
 * Stable hashing makes membership independent of input order. The final set is
 * returned separately and never participates in feedback or candidate scoring.
 */
export function splitTasks(tasks: readonly TaskDescriptor[], seed: string): TaskSplits {
	if (tasks.length !== 100) {
		throw new Error(`Expected exactly 100 tasks for a 20/20/60 split; received ${tasks.length}.`);
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
		feedback: ordered.slice(0, TASK_SPLIT_SIZES.feedback),
		score: ordered.slice(TASK_SPLIT_SIZES.feedback, TASK_SPLIT_SIZES.feedback + TASK_SPLIT_SIZES.score),
		final: ordered.slice(TASK_SPLIT_SIZES.feedback + TASK_SPLIT_SIZES.score),
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
