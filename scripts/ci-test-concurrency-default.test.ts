import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
	addBunTestTotals,
	allocateCloudflareTestCommands,
	buildChildEnv,
	childJUnitCountMismatch,
	commandsForMode,
	fastWorkspacePackages,
	formatBunTestTotals,
	nativeAndIntegrationPackages,
	parseCiTestShard,
	partitionTestCommands,
	resolveCiTestShard,
	testConcurrency,
} from "./ci-test-ts";

/**
 * How many test chunks run at once.
 *
 * This has a test because the previous default, one chunk per available core,
 * made a full local run drive the load average past 80 on a many-core
 * workstation and left the machine unusable. Each chunk is a `bun test` process
 * that spawns children of its own, so the real process count is a multiple of the
 * chunk count. Someone running the suite is usually still working on that same
 * machine, so sequential is the correct default and fanout is an explicit choice.
 */
describe("local test concurrency", () => {
	const original = Bun.env.VEYYON_TEST_CONCURRENCY;

	afterEach(() => {
		if (original === undefined) delete Bun.env.VEYYON_TEST_CONCURRENCY;
		else Bun.env.VEYYON_TEST_CONCURRENCY = original;
	});

	it("runs one chunk at a time by default, however many chunks there are", () => {
		delete Bun.env.VEYYON_TEST_CONCURRENCY;
		// Asserted at several sizes: the default must not scale with the workload, which
		// is exactly how the machine got saturated.
		expect(testConcurrency(1)).toBe(1);
		expect(testConcurrency(96)).toBe(1);
		expect(testConcurrency(1000)).toBe(1);
	});

	it("honors an explicit numeric opt-in, capped at the number of chunks", () => {
		Bun.env.VEYYON_TEST_CONCURRENCY = "4";
		expect(testConcurrency(96)).toBe(4);
		// Never more workers than there is work.
		expect(testConcurrency(2)).toBe(2);
	});

	it("treats `all` and `max` as full fanout, for a dedicated test box", () => {
		Bun.env.VEYYON_TEST_CONCURRENCY = "all";
		expect(testConcurrency(96)).toBe(96);
		Bun.env.VEYYON_TEST_CONCURRENCY = "max";
		expect(testConcurrency(12)).toBe(12);
	});

	it("falls back to sequential when the override is not a usable number", () => {
		// A typo must degrade to the safe value, never to unbounded fanout.
		for (const bad of ["", "abc", "0", "-3"]) {
			Bun.env.VEYYON_TEST_CONCURRENCY = bad;
			expect({ bad, workers: testConcurrency(96) }).toEqual({ bad, workers: 1 });
		}
	});
});
describe("Cloudflare test command sharding", () => {
	const commands = Array.from({ length: 17 }, (_, index) => ({ label: `command-${index}` }));

	it("partitions every command exactly once across uneven shard sizes", () => {
		const shards = [1, 2, 3].map(index => partitionTestCommands(commands, { index, count: 3 }));
		expect(shards.map(shard => shard.length)).toEqual([6, 6, 5]);
		expect(shards.flat().map(command => command.label).sort()).toEqual(commands.map(command => command.label).sort());
	});

	it("parses one-based shard specifications and rejects invalid bounds", () => {
		expect(parseCiTestShard("2/3")).toEqual({ index: 2, count: 3 });
		expect(parseCiTestShard(undefined)).toBeUndefined();
		for (const invalid of ["0/3", "4/3", "2/0", "1/2/3"]) {
			expect(() => parseCiTestShard(invalid)).toThrow();
		}
	});

	it("preserves every workspace command once while keeping heavy suites on assigned shards", async () => {
		const workspaceCommands = await commandsForMode("workspace-cloudflare");
		const standardPackages = workspaceCommands
			.filter(command => command.label !== "packages/catalog (isolated)")
			.map(command => command.label)
			.sort();
		expect(standardPackages).toEqual([...fastWorkspacePackages].sort());
		expect(workspaceCommands.filter(command => command.label === "packages/catalog (isolated)")).toHaveLength(1);

		const shards = [1, 2, 3].map(index =>
			allocateCloudflareTestCommands("workspace-cloudflare", workspaceCommands, { index, count: 3 }),
		);
		expect(shards.flat().map(command => command.label).sort()).toEqual(
			workspaceCommands.map(command => command.label).sort(),
		);
		expect(shards[0].map(command => command.label)).toContain("plugins/hashline");
		expect(shards[0].map(command => command.label)).toContain("packages/ai");
		expect(shards[1].map(command => command.label)).toContain("plugins/argot");
		expect(shards[2].map(command => command.label)).toContain("tests/simulations");
	});

	it("preserves native package suites and the isolated engine fuzz suite", async () => {
		const nativeCommands = await commandsForMode("native");
		const standardPackages = nativeCommands
			.filter(command => command.label !== "hosts/terminal/engine (isolated)")
			.map(command => command.label)
			.sort();
		expect(standardPackages).toEqual([...nativeAndIntegrationPackages].sort());

		const engine = nativeCommands.find(command => command.label === "hosts/terminal/engine");
		const isolatedEngine = nativeCommands.find(command => command.label === "hosts/terminal/engine (isolated)");
		expect(engine).toBeDefined();
		expect(isolatedEngine).toBeDefined();
		expect(engine?.command).toContain("test/editor-wordwrap-fuzz.test.ts");
		expect(isolatedEngine?.command.slice(-1)).toEqual(["test/editor-wordwrap-fuzz.test.ts"]);

		const shards = [1, 2, 3].map(index =>
			allocateCloudflareTestCommands("native", nativeCommands, { index, count: 3 }),
		);
		const nonDuplicated = shards.flat().filter(command => command.label !== "natives/bridge/bindings");
		expect(nonDuplicated.map(command => command.label).sort()).toEqual(
			nativeCommands
				.filter(command => command.label !== "natives/bridge/bindings")
				.map(command => command.label)
				.sort(),
		);
		expect(shards[0].map(command => command.label)).toContain("natives/bridge/bindings");
		expect(shards[1].map(command => command.label)).toContain("natives/bridge/bindings");
		expect(shards[2].map(command => command.label)).not.toContain("natives/bridge/bindings");
	});
	it("reports aggregated Bun case totals in the Cloudflare log format", () => {
		const totals = { pass: 0, fail: 0, skip: 0, todo: 0, reportedTests: 0, files: 0, runs: 0 };
		addBunTestTotals(totals, "2 pass\n1 skip\nRan 3 tests across 2 files.\n");
		addBunTestTotals(totals, "1 fail\nRan 1 test across 1 file.\n");
		expect(formatBunTestTotals(totals)).toBe(
			"CLOUDFLARE_CI_TEST_COUNTS pass=2 fail=1 skip=1 todo=0 tests=4 reported=4 files=3 runs=2",
		);
	});

	it("resolves shard specifications from both Veyyon and Cloudflare environment forms", () => {
		expect(resolveCiTestShard({ VEYYON_CI_TEST_SHARD: "7/12" })).toEqual({ index: 7, count: 12 });
		expect(resolveCiTestShard({ CF_SHARD_INDEX: "6", CF_SHARD_COUNT: "12" })).toEqual({ index: 7, count: 12 });
		expect(resolveCiTestShard({ VEYYON_CI_SHARD: "7", VEYYON_CI_SHARDS: "12" })).toEqual({ index: 7, count: 12 });
		expect(resolveCiTestShard({})).toBeUndefined();

		// Bounds checks
		expect(() => resolveCiTestShard({ CF_SHARD_INDEX: "12", CF_SHARD_COUNT: "12" })).toThrow();
		expect(() => resolveCiTestShard({ CF_SHARD_INDEX: "-1", CF_SHARD_COUNT: "12" })).toThrow();
		expect(() => resolveCiTestShard({ VEYYON_CI_SHARD: "13", VEYYON_CI_SHARDS: "12" })).toThrow();
		expect(() => resolveCiTestShard({ VEYYON_CI_SHARD: "0", VEYYON_CI_SHARDS: "12" })).toThrow();

		// Conflict detection
		expect(() =>
			resolveCiTestShard({ VEYYON_CI_SHARD: "1", VEYYON_CI_SHARDS: "12", CF_SHARD_INDEX: "1", CF_SHARD_COUNT: "12" }),
		).toThrow();

		// Agreement between forms
		expect(
			resolveCiTestShard({ VEYYON_CI_SHARD: "7", VEYYON_CI_SHARDS: "12", CF_SHARD_INDEX: "6", CF_SHARD_COUNT: "12" }),
		).toEqual({ index: 7, count: 12 });
	});

	it("partitions every mode with 12-way disjointness and completeness", async () => {
		const modes = [
			"workspace-cloudflare",
			"native",
			"coding-agent-singleton",
			"coding-agent-ui",
			"coding-agent-runtime",
			"coding-agent-native",
			"scripts",
		] as const;

		for (const mode of modes) {
			const allCommands = await commandsForMode(mode);
			const shards = Array.from({ length: 12 }, (_, index) =>
				allocateCloudflareTestCommands(mode, allCommands, { index: index + 1, count: 12 }),
			);

			// Disjointness: no command appears in more than one shard
			const seenLabels = new Set<string>();
			let duplicateCount = 0;
			for (const shard of shards) {
				for (const command of shard) {
					if (seenLabels.has(command.label)) {
						duplicateCount++;
					}
					seenLabels.add(command.label);
				}
			}
			expect(duplicateCount).toBe(0);

			// Completeness: all commands are present across the 12 shards exactly once
			const partitionedLabels = shards.flat().map(command => command.label).sort();
			const expectedLabels = allCommands.map(command => command.label).sort();
			expect(partitionedLabels).toEqual(expectedLabels);
		}
	});

});
describe("Cloudflare child JUnit totals", () => {
	it("accepts matching Bun and JUnit case totals", () => {
		const dir = mkdtempSync(join(tmpdir(), "veyyon-junit-counts-"));
		try {
			const report = join(dir, "child.xml");
			writeFileSync(report, '<testsuite><testcase name="pass"/><testcase name="skip"><skipped/></testcase></testsuite>');
			expect(childJUnitCountMismatch("1 pass\n1 skip\nRan 2 tests across 1 file.", report)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects missing summaries and JUnit totals that disagree", () => {
		const dir = mkdtempSync(join(tmpdir(), "veyyon-junit-counts-"));
		try {
			const report = join(dir, "child.xml");
			writeFileSync(report, '<testsuite><testcase name="pass"/></testsuite>');
			expect(childJUnitCountMismatch("no summary", report)).toContain("missing Bun test summary");
			expect(childJUnitCountMismatch("2 pass\nRan 2 tests across 1 file.", report)).toContain("JUnit");
			expect(childJUnitCountMismatch("0 pass\nRan 0 tests across 1 file.", report)).toContain("empty Bun test summary");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips CLOUDFLARE_API_TOKEN and provider credentials from child test environments", () => {
		const env = buildChildEnv({
			CLOUDFLARE_API_TOKEN: "secret-token",
			ANTHROPIC_API_KEY: "secret-key",
			TEST_KEEP: "kept",
		});
		expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.TEST_KEEP).toBe("kept");
	});
});
