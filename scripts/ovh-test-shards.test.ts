import { describe, expect, it } from "bun:test";
import { planShards, parseSelectedLines } from "./ovh-test-shards.mjs";

describe("OVH test shard planner", () => {
	it("uses deterministic LPT placement with least-loaded index tie breaks", () => {
		const durations = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 };
		const plan = planShards(["f", "e", "d", "c", "b", "a"], durations, 10);
		expect(plan.shardCount).toBe(4);
		expect(plan.shards.map(shard => shard.files)).toEqual([["a"], ["b"], ["c", "f"], ["d", "e"]]);
		expect(planShards(["a", "b", "c", "d", "e", "f"], durations, 10)).toEqual(plan);
	});

	it("handles empty selection with one empty shard", () => {
		expect(planShards([], {}, 480000)).toEqual({
			targetDurationMs: 480000,
			shardCount: 1,
			shards: [{ index: 0, durationMs: 0, files: [] }],
		});
	});

	it("assigns more than 200 files exactly once", () => {
		const files = Array.from({ length: 257 }, (_, index) => `tests/${String(index).padStart(3, "0")}.test.ts`);
		const durations = Object.fromEntries(files.map((file, index) => [file, index + 1]));
		const plan = planShards(files, durations, 480000);
		const assigned = plan.shards.flatMap(shard => shard.files);
		expect(assigned).toHaveLength(files.length);
		expect(new Set(assigned).size).toBe(files.length);
	});

	it("uses the fallback duration for unmeasured files", () => {
		expect(planShards(["unknown"], {}, 480000, 449).shards[0].durationMs).toBe(449);
	});

	it("rejects duplicate, unsafe, non-positive and non-finite inputs", () => {
		expect(() => planShards(["a", "a"], { a: 1 })).toThrow(/duplicate/);
		for (const file of ["../a", "/a", "a\\b", "a//b", ""]) expect(() => planShards([file], { [file]: 1 })).toThrow();
		for (const duration of [-1, NaN, Infinity, "3"])
			expect(() => planShards(["a"], { a: duration as number })).toThrow(/duration/);
		for (const target of [0, -1, NaN, Infinity]) expect(() => planShards([], {}, target)).toThrow(/target/);
	});

	it("rejects plans requiring more than 255 shards", () => {
		const files = Array.from({ length: 256 }, (_, index) => `f${index}`);
		const durations = Object.fromEntries(files.map(file => [file, 1]));
		expect(() => planShards(files, durations, 1)).toThrow(/255/);
	});

	it("parses LF and CRLF selected lists and rejects blank entries", () => {
		expect(parseSelectedLines("a\nb\n")).toEqual(["a", "b"]);
		expect(parseSelectedLines("a\r\nb\r\n")).toEqual(["a", "b"]);
		expect(() => parseSelectedLines("a\n\nb")).toThrow(/empty/);
	});
});
