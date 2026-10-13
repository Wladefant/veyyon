import { afterEach, describe, expect, it } from "bun:test";
import {
	allocateCloudflareTestCommands,
	fastWorkspacePackages,
	nativeAndIntegrationPackages,
	parseCiTestShard,
	partitionTestCommands,
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
	const originalCI = Bun.env.CI;

	afterEach(() => {
		if (original === undefined) delete Bun.env.VEYYON_TEST_CONCURRENCY;
		else Bun.env.VEYYON_TEST_CONCURRENCY = original;
		if (originalCI === undefined) delete Bun.env.CI;
		else Bun.env.CI = originalCI;
	});

	it("runs one chunk at a time by default, however many chunks there are", () => {
		delete Bun.env.VEYYON_TEST_CONCURRENCY;
		// Asserted at several sizes: the default must not scale with the workload, which
		// is exactly how the machine got saturated.
		expect(testConcurrency(1)).toBe(1);
		expect(testConcurrency(96)).toBe(1);
		expect(testConcurrency(1000)).toBe(1);
	});

	it("defaults to one in CI but honors a safe explicit override", () => {
		Bun.env.CI = "true";
		delete Bun.env.VEYYON_TEST_CONCURRENCY;
		expect(testConcurrency(96)).toBe(1);
		Bun.env.VEYYON_TEST_CONCURRENCY = "2";
		expect(testConcurrency(96)).toBe(2);
		Bun.env.VEYYON_TEST_CONCURRENCY = "invalid";
		expect(testConcurrency(96)).toBe(1);
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

	it("assigns each command to exactly one shard", () => {
		const shards = [1, 2, 3].map(index => partitionTestCommands(commands, { index, count: 3 }));
		expect(shards.map(shard => shard.length)).toEqual([6, 6, 5]);
		expect(shards.flat().map(command => command.label).sort()).toEqual(commands.map(command => command.label).sort());
	});

	it("parses one-based shard specifications and rejects invalid values", () => {
		expect(parseCiTestShard("2/3")).toEqual({ index: 2, count: 3 });
		expect(parseCiTestShard(undefined)).toBeUndefined();
		expect(() => parseCiTestShard("0/3")).toThrow();
		expect(() => parseCiTestShard("4/3")).toThrow();
		expect(() => parseCiTestShard("2/0")).toThrow();
	});

	it("separates heavy commands across shards for workspace-cloudflare mode", () => {
		const workspaceCommands = fastWorkspacePackages.map(pkg => ({ label: pkg }));
		const shard1 = allocateCloudflareTestCommands("workspace-cloudflare", workspaceCommands, { index: 1, count: 3 });
		const shard2 = allocateCloudflareTestCommands("workspace-cloudflare", workspaceCommands, { index: 2, count: 3 });
		const shard3 = allocateCloudflareTestCommands("workspace-cloudflare", workspaceCommands, { index: 3, count: 3 });

		// Explicit overrides based on measured suite durations
		expect(shard1.map(c => c.label)).toContain("packages/ai");
		expect(shard2.map(c => c.label)).toContain("plugins/hashline");
		expect(shard3.map(c => c.label)).toContain("tests/simulations");

		// Natural round-robin modulo placement on shard 1
		expect(shard1.map(c => c.label)).toContain("packages/agent");
		expect(shard1.map(c => c.label)).toContain("packages/utils");

		// Heavy commands must be strictly separated across distinct shards
		expect(shard1.map(c => c.label)).not.toContain("plugins/hashline");
		expect(shard1.map(c => c.label)).not.toContain("tests/simulations");
		expect(shard2.map(c => c.label)).not.toContain("packages/ai");
		expect(shard2.map(c => c.label)).not.toContain("tests/simulations");
		expect(shard3.map(c => c.label)).not.toContain("packages/ai");
		expect(shard3.map(c => c.label)).not.toContain("plugins/hashline");
	});

	it("preserves every ordinary command exactly once across all shards", () => {
		const workspaceCommands = fastWorkspacePackages.map(pkg => ({ label: pkg }));
		const workspaceShards = [1, 2, 3].map(index =>
			allocateCloudflareTestCommands("workspace-cloudflare", workspaceCommands, { index, count: 3 }),
		);
		const allWorkspaceAllocated = workspaceShards.flat().map(c => c.label).sort();
		expect(allWorkspaceAllocated).toEqual(workspaceCommands.map(c => c.label).sort());

		// In native mode, every non-binding command must run exactly once across the shards
		const nativeCommands = nativeAndIntegrationPackages.map(pkg => ({ label: pkg }));
		const nativeShards = [1, 2, 3].map(index =>
			allocateCloudflareTestCommands("native", nativeCommands, { index, count: 3 }),
		);
		const ordinaryNativeAllocated = nativeShards
			.flat()
			.filter(c => c.label !== "natives/bridge/bindings")
			.map(c => c.label)
			.sort();
		const expectedOrdinary = nativeCommands
			.filter(c => c.label !== "natives/bridge/bindings")
			.map(c => c.label)
			.sort();
		expect(ordinaryNativeAllocated).toEqual(expectedOrdinary);
	});

	it("runs full native binding tests on both baseline (shard 1) and modern (shard 2), not shard 3", () => {
		const nativeCommands = nativeAndIntegrationPackages.map(pkg => ({ label: pkg }));
		const shard1 = allocateCloudflareTestCommands("native", nativeCommands, { index: 1, count: 3 });
		const shard2 = allocateCloudflareTestCommands("native", nativeCommands, { index: 2, count: 3 });
		const shard3 = allocateCloudflareTestCommands("native", nativeCommands, { index: 3, count: 3 });

		expect(shard1.map(c => c.label)).toContain("natives/bridge/bindings");
		expect(shard2.map(c => c.label)).toContain("natives/bridge/bindings");
		expect(shard3.map(c => c.label)).not.toContain("natives/bridge/bindings");
	});

	it("preserves default generic partition unchanged for other modes and counts", () => {
		const genericCommands = Array.from({ length: 17 }, (_, index) => ({ label: `generic-${index}` }));

		// Generic mode with 3 shards reuses partitionTestCommands
		for (let index = 1; index <= 3; index++) {
			const allocated = allocateCloudflareTestCommands("generic", genericCommands, { index, count: 3 });
			const partitioned = partitionTestCommands(genericCommands, { index, count: 3 });
			expect(allocated).toEqual(partitioned);
		}

		// Shard count other than 3 falls back to partitionTestCommands
		for (const count of [2, 4]) {
			for (let index = 1; index <= count; index++) {
				const allocatedWorkspace = allocateCloudflareTestCommands("workspace-cloudflare", genericCommands, {
					index,
					count,
				});
				expect(allocatedWorkspace).toEqual(partitionTestCommands(genericCommands, { index, count }));

				const allocatedNative = allocateCloudflareTestCommands("native", genericCommands, { index, count });
				expect(allocatedNative).toEqual(partitionTestCommands(genericCommands, { index, count }));
			}
		}
	});
});
