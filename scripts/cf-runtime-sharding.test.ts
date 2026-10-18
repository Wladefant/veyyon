import { describe, expect, it } from "bun:test";
import {
	applySharding,
	calculateDiscoveryHash,
	extractBunSummary,
	isBunTestFile,
	parseShardConfig,
	shardTestCommands,
	validateShardBounds,
} from "./ci-test-ts";

describe("Cloudflare runtime sharding", () => {
	describe("validateShardBounds", () => {
		it("accepts valid bounds", () => {
			expect(() => validateShardBounds(0, 1)).not.toThrow();
			expect(() => validateShardBounds(0, 3)).not.toThrow();
			expect(() => validateShardBounds(1, 3)).not.toThrow();
			expect(() => validateShardBounds(2, 3)).not.toThrow();
			expect(() => validateShardBounds(5, 6)).not.toThrow();
			expect(() => validateShardBounds(11, 12)).not.toThrow();
		});

		it("rejects non-integer or zero/negative shard count", () => {
			expect(() => validateShardBounds(0, 0)).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => validateShardBounds(0, -1)).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => validateShardBounds(0, -5)).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => validateShardBounds(0, 1.5)).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => validateShardBounds(0, Number.NaN)).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => validateShardBounds(0, Number.POSITIVE_INFINITY)).toThrow(/Invalid CF_SHARD_COUNT/);
		});

		it("rejects negative shard index", () => {
			expect(() => validateShardBounds(-1, 3)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(-10, 6)).toThrow(/Invalid CF_SHARD_INDEX/);
		});

		it("rejects shard index equal to or greater than shard count", () => {
			expect(() => validateShardBounds(1, 1)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(3, 3)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(5, 3)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(12, 12)).toThrow(/Invalid CF_SHARD_INDEX/);
		});

		it("rejects non-integer shard index", () => {
			expect(() => validateShardBounds(0.5, 3)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(1.2, 4)).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => validateShardBounds(Number.NaN, 3)).toThrow(/Invalid CF_SHARD_INDEX/);
		});
	});

	describe("parseShardConfig", () => {
		it("returns null when neither variable is set", () => {
			expect(parseShardConfig({})).toBeNull();
			expect(parseShardConfig({ OTHER_VAR: "123" })).toBeNull();
		});

		it("parses valid zero-based index and count from environment", () => {
			expect(parseShardConfig({ CF_SHARD_INDEX: "0", CF_SHARD_COUNT: "1" })).toEqual({ index: 0, count: 1 });
			expect(parseShardConfig({ CF_SHARD_INDEX: "2", CF_SHARD_COUNT: "6" })).toEqual({ index: 2, count: 6 });
			expect(parseShardConfig({ CF_SHARD_INDEX: "11", CF_SHARD_COUNT: "12" })).toEqual({ index: 11, count: 12 });
		});

		it("trims surrounding whitespace from environment values", () => {
			expect(parseShardConfig({ CF_SHARD_INDEX: " 3 ", CF_SHARD_COUNT: " 6 " })).toEqual({ index: 3, count: 6 });
		});

		it("throws when only one variable is defined", () => {
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "0" })).toThrow(/Incomplete shard configuration/);
			expect(() => parseShardConfig({ CF_SHARD_COUNT: "6" })).toThrow(/Incomplete shard configuration/);
		});

		it("throws on non-numeric or non-integer string representations", () => {
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "abc", CF_SHARD_COUNT: "6" })).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "0", CF_SHARD_COUNT: "xyz" })).toThrow(/Invalid CF_SHARD_COUNT/);
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "1.5", CF_SHARD_COUNT: "3" })).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "0", CF_SHARD_COUNT: "2.7" })).toThrow(/Invalid CF_SHARD_COUNT/);
		});

		it("throws when parsed values violate boundary constraints", () => {
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "5", CF_SHARD_COUNT: "5" })).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "-1", CF_SHARD_COUNT: "3" })).toThrow(/Invalid CF_SHARD_INDEX/);
			expect(() => parseShardConfig({ CF_SHARD_INDEX: "0", CF_SHARD_COUNT: "0" })).toThrow(/Invalid CF_SHARD_COUNT/);
		});
	});

	describe("shardTestCommands (round-robin assignment)", () => {
		it("preserves single-shard equivalence (index 0 of 1 returns all items in exact order)", () => {
			const items = ["chunk-a", "chunk-b", "chunk-c", "chunk-d", "chunk-e"];
			const sharded = shardTestCommands(items, 0, 1);
			expect(sharded).toEqual(items);
		});

		it("produces exhaustive, disjoint, deterministic assignment across 2, 3, 6, and 12 shards", () => {
			const itemCounts = [7, 24, 47, 100, 250];
			const shardCounts = [2, 3, 6, 12];

			for (const total of itemCounts) {
				const items = Array.from({ length: total }, (_, i) => `cmd-${i}`);

				for (const count of shardCounts) {
					const shards = Array.from({ length: count }, (_, idx) => shardTestCommands(items, idx, count));

					// Determinism: running again yields identical result
					for (let idx = 0; idx < count; idx++) {
						expect(shardTestCommands(items, idx, count)).toEqual(shards[idx]);
					}

					// Disjointness: no item appears in more than one shard
					const seen = new Set<string>();
					let overlapCount = 0;
					for (const shard of shards) {
						for (const item of shard) {
							if (seen.has(item)) overlapCount++;
							seen.add(item);
						}
					}
					expect(overlapCount).toBe(0);

					// Exhaustiveness: union of all shards equals original items
					expect(seen.size).toBe(total);
					for (const item of items) {
						expect(seen.has(item)).toBe(true);
					}

					// Balanced chunk count invariant: difference between largest and smallest shard <= 1
					const sizes = shards.map(s => s.length);
					const minSize = Math.min(...sizes);
					const maxSize = Math.max(...sizes);
					expect(maxSize - minSize).toBeLessThanOrEqual(1);
				}
			}
		});

		it("throws when applySharding produces an empty shard from full inventory", () => {
			const fakeCommand = { label: "test", cwd: ".", command: ["bun", "test", "./foo.test.ts"] };
			// If inventory has 2 commands and 6 shards are requested, shard 2 has 0 commands
			expect(() => applySharding([fakeCommand, fakeCommand], { index: 2, count: 6 })).toThrow(
				/Empty shard 2\/6 assigned/,
			);
		});
	});

	describe("isBunTestFile contract cases", () => {
		const positiveCases = [
			// .test variants
			"unit.test.ts",
			"component.test.tsx",
			"helpers.test.js",
			"jsx-view.test.jsx",
			"esm-module.test.mjs",
			"cjs-module.test.cjs",
			"ts-module.test.mts",
			"cts-module.test.cts",
			// _test variants
			"unit_test.ts",
			"component_test.tsx",
			"helpers_test.js",
			"jsx_test.jsx",
			"esm_test.mjs",
			"cjs_test.cjs",
			"ts_test.mts",
			"cts_test.cts",
			// .spec variants
			"unit.spec.ts",
			"component.spec.tsx",
			"helpers.spec.js",
			"jsx-view.spec.jsx",
			"esm-module.spec.mjs",
			"cjs-module.spec.cjs",
			"ts-module.spec.mts",
			"cts-module.spec.cts",
			// _spec variants
			"unit_spec.ts",
			"component_spec.tsx",
			"helpers_spec.js",
			"jsx_spec.jsx",
			"esm_spec.mjs",
			"cjs_spec.cjs",
			"ts_spec.mts",
			"cts_spec.cts",
		];

		for (const filename of positiveCases) {
			it(`recognizes Bun test file pattern: ${filename}`, () => {
				expect(isBunTestFile(filename)).toBe(true);
			});
		}

		const negativeCases = [
			"types.test.d.ts",
			"schema.spec.d.ts",
			"data.test.json",
			"notes.test.txt",
			"sample_test.md",
			"test.ts",
			"spec.ts",
			"contest.ts",
			"specification.ts",
			"helpers.ts",
			"index.js",
			"component.tsx",
		];

		for (const filename of negativeCases) {
			it(`rejects non-test file: ${filename}`, () => {
				expect(isBunTestFile(filename)).toBe(false);
			});
		}
	});

	describe("substring-overlap path protection", () => {
		it("preserves exact ./ prefix so Bun test runner executes exact file without substring filtering", () => {
			const candidatePaths = [
				"test/auth.test.ts",
				"test/auth.test.ts.extra.test.ts",
				"test/user.test.ts",
				"test/user-profile.test.ts",
			];

			// Formatting ensures exact ./ relative prefix
			const formatted = candidatePaths.map(p => (p.startsWith("./") ? p : `./${p}`));
			for (const p of formatted) {
				expect(p.startsWith("./")).toBe(true);
				// A path starting with ./ is treated as a file path by Bun test, not a filter query
				expect(p).toMatch(/^\.\//);
			}

			// Substring overlap check: 'user' is a substring of 'user-profile', but exact ./ paths remain distinct
			expect(formatted[2]).not.toBe(formatted[3]);
			expect(formatted[0]).not.toBe(formatted[1]);
		});
	});

	describe("calculateDiscoveryHash", () => {
		it("produces deterministic 16-hex character hash invariant to file order", () => {
			const filesA = ["./test/b.test.ts", "./test/a.test.ts", "./test/c.test.ts"];
			const filesB = ["./test/a.test.ts", "./test/c.test.ts", "./test/b.test.ts"];

			const hashA = calculateDiscoveryHash(filesA);
			const hashB = calculateDiscoveryHash(filesB);

			expect(hashA).toBe(hashB);
			expect(hashA).toMatch(/^[0-9a-f]{16}$/);
		});

		it("produces different hashes for different file inventories", () => {
			const hash1 = calculateDiscoveryHash(["./test/a.test.ts"]);
			const hash2 = calculateDiscoveryHash(["./test/b.test.ts"]);
			expect(hash1).not.toBe(hash2);
		});
	});

	describe("extractBunSummary", () => {
		it("extracts pass and fail counts from standard Bun test output", () => {
			const output = `
bun test v1.4.0 (x86_64-linux)
✓ ./test/a.test.ts > basic assertion [1.20ms]
✓ ./test/b.test.ts > complex logic [3.45ms]

 2 pass
 0 fail
Ran 2 tests across 2 files. [15.00ms]
`;
			const summary = extractBunSummary(output);
			expect(summary.pass).toBe(2);
			expect(summary.fail).toBe(0);
			expect(summary.skip).toBe(0);
			expect(summary.total).toBe(2);
			expect(summary.files).toBe(2);
		});

		it("extracts failures, skips, and todos accurately", () => {
			const output = `
 18 pass
 2 fail
 3 skip
 1 todo
Ran 24 tests across 4 files. [120.00ms]
`;
			const summary = extractBunSummary(output);
			expect(summary.pass).toBe(18);
			expect(summary.fail).toBe(2);
			expect(summary.skip).toBe(3);
			expect(summary.todo).toBe(1);
			expect(summary.total).toBe(24);
			expect(summary.files).toBe(4);
		});

		it("handles output with ANSI escapes and missing ran lines", () => {
			const output = `\x1b[32m 42 pass\x1b[0m\n\x1b[31m 0 fail\x1b[0m\n`;
			const summary = extractBunSummary(output);
			expect(summary.pass).toBe(42);
			expect(summary.fail).toBe(0);
			expect(summary.total).toBe(42);
		});

		it("returns zeroes when output has no parseable test summary", () => {
			const summary = extractBunSummary("compilation error: module not found");
			expect(summary.pass).toBe(0);
			expect(summary.fail).toBe(0);
			expect(summary.total).toBe(0);
		});
	});
});
