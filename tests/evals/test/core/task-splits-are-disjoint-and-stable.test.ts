import { describe, expect, test } from "bun:test";
import type { TaskDescriptor } from "../../engine/contracts";
import { splitTasks } from "../../engine/task-splits";

const tasks: TaskDescriptor[] = Array.from({ length: 100 }, (_, index) => ({
	id: `task-${index}`,
	path: null,
	timeBudgetSec: 1,
	instructionPath: null,
	metadata: {},
}));

describe("splitTasks", () => {
	test("creates stable, disjoint feedback, score, and final sets", () => {
		const first = splitTasks(tasks, "corpus-v1");
		const reordered = splitTasks([...tasks].reverse(), "corpus-v1");
		expect(first.feedback).toHaveLength(20);
		expect(first.score).toHaveLength(20);
		expect(first.final).toHaveLength(60);
		expect(first.feedback.map(task => task.id)).toEqual(reordered.feedback.map(task => task.id));
		expect(first.score.map(task => task.id)).toEqual(reordered.score.map(task => task.id));
		expect(first.final.map(task => task.id)).toEqual(reordered.final.map(task => task.id));
		const ids = [...first.feedback, ...first.score, ...first.final].map(task => task.id);
		expect(new Set(ids).size).toBe(100);
	});

	test("refuses incomplete corpora and duplicate task ids", () => {
		expect(() => splitTasks(tasks.slice(0, 99), "corpus-v1")).toThrow("exactly 100");
		expect(() => splitTasks([...tasks.slice(0, 99), tasks[0]!], "corpus-v1")).toThrow("Duplicate task id");
	});

	test("requires an explicit stable seed", () => {
		expect(() => splitTasks(tasks, "")).toThrow("seed");
	});
});
