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

	test("keeps hash-collision assignments stable for collation-ignorable task ids", () => {
		const collidingIds = [
			"a\u2060\uFE0F\u2060\u0000\u200B\u200B\u200B\u200Bb",
			"a\u2060\uFE0F\u200C\u2060\u200B\uFE0F\u200B\u200Bb",
		];
		const seed = "seed";
		const collisionHash = "bf0192a0";
		const below: string[] = [];
		const above: string[] = [];
		for (let candidate = 0; (below.length < 19 || above.length < 79) && candidate < 100_000; candidate += 1) {
			const id = `fixture-${candidate}`;
			let result = 2166136261;
			for (let index = 0; index < `${seed}\0${id}`.length; index += 1) {
				result ^= `${seed}\0${id}`.charCodeAt(index);
				result = Math.imul(result, 16777619);
			}
			const value = (result >>> 0).toString(16).padStart(8, "0");
			if (value < collisionHash && below.length < 19) below.push(id);
			if (value > collisionHash && above.length < 79) above.push(id);
		}
		expect(below).toHaveLength(19);
		expect(above).toHaveLength(79);
		const collisionTasks = [...below, ...collidingIds, ...above].map(id => ({ ...tasks[0]!, id }));
		const first = splitTasks(collisionTasks, seed);
		const reordered = splitTasks([...collisionTasks].reverse(), seed);
		expect(first.feedback.map(task => task.id)).toEqual(reordered.feedback.map(task => task.id));
		expect(first.score.map(task => task.id)).toEqual(reordered.score.map(task => task.id));
		expect(first.final.map(task => task.id)).toEqual(reordered.final.map(task => task.id));
		expect(first.feedback.map(task => task.id)).toContain(collidingIds[1]);
		expect(first.score.map(task => task.id)).toContain(collidingIds[0]);
	});

	test("refuses incomplete corpora and duplicate task ids", () => {
		expect(() => splitTasks(tasks.slice(0, 99), "corpus-v1")).toThrow("exactly 100");
		expect(() => splitTasks([...tasks.slice(0, 99), tasks[0]!], "corpus-v1")).toThrow("Duplicate task id");
	});

	test("requires an explicit stable seed", () => {
		expect(() => splitTasks(tasks, "")).toThrow("seed");
	});
});
