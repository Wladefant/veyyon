/**
 * WHY: the singleton/global-state bucket was the one coding-agent bucket with no
 * `chunkSize`, so its whole file list ran as a single `bun test` process. The
 * justification was that global-state suites have to share a process to exercise
 * process-wide state. They do not: the isolation such a suite needs is that
 * nothing runs BESIDE it, which is `parallel: 1`, and a chunk boundary is a
 * stronger guarantee than a shared heap. Left whole the bucket grew to 555 files,
 * far past the ~170-370-file OOM ceiling the runner's own comment records, and was
 * SIGKILLed with exit 137 on every CI run. It reported as a rotating handful of
 * unrelated TUI and MCP suites "failing" at 30-40s apiece under memory pressure,
 * every one of which passes on its own, so the real cause was invisible in the log
 * and main stayed red across several commits.
 *
 * The class this closes: a coding-agent bucket whose file list is handed to one
 * process, and therefore has no bound on peak RSS no matter how large the bucket
 * grows. It is closed at the plan table every bucket is built from, swept at run
 * time, so a bucket added later cannot reintroduce it. `chunkSize` is also
 * required by the type, which makes the same mistake a compile error; this suite
 * is what catches the runtime spellings a type cannot see (a zero, a negative, or
 * a number so large it is the file count in disguise).
 *
 * What it does NOT catch: a chunk size that is legal but still too big for a
 * future bucket's memory profile. Only a run can answer that, and the failure
 * mode is exit 137 with the chunk composition printed beside it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	chunksAtOnce,
	codingAgentBucketPlans,
	dispatchTestCommands,
	type Mode,
	type TestCommand,
	validModes,
} from "./ci-test-ts";

describe("coding-agent bucket plans", () => {
	// Swept from the table itself, so a bucket added later is covered without a
	// new case here and without this list going stale in silence.
	const buckets = Object.entries(codingAgentBucketPlans);

	it("covers every declared bucket", () => {
		expect(buckets.length).toBeGreaterThan(0);
	});

	it("bounds every bucket to a chunk, so none is handed to one process", () => {
		const unbounded = buckets.filter(([, plan]) => !Number.isInteger(plan.chunkSize) || plan.chunkSize < 1);
		expect(unbounded.map(([name]) => name)).toEqual([]);
	});

	it("keeps every chunk small enough to be a bound rather than a formality", () => {
		// The runner's measured ceiling is a single 170-370-file invocation. A chunk
		// an order of magnitude under that is a bound; one near it is the same
		// unchunked bucket wearing a number.
		const tooLarge = buckets.filter(([, plan]) => plan.chunkSize > 20);
		expect(tooLarge.map(([name, plan]) => `${name}=${plan.chunkSize}`)).toEqual([]);
	});

	it("runs every bucket serially, which is the isolation a global-state suite needs", () => {
		const concurrent = buckets.filter(([, plan]) => plan.parallel !== 1);
		expect(concurrent.map(([name]) => name)).toEqual([]);
	});
});

/**
 * How many chunk processes CI runs side by side. A global-state suite needs nothing
 * beside it, so any mode that reaches the singleton bucket runs its chunks one at a
 * time; a wider bucket multiplies the job's peak RSS by its width, so the width stays
 * within the 4-vCPU runner. Every mode is swept from the runner's own mode table, so a
 * mode added later that runs the singleton bucket inside a wider fan-out turns this red.
 *
 * Not caught: a cross-process collision between two chunks of one bucket (a shared
 * port or file name). Only a run shows that, as a failure in one of the two chunks.
 */
describe("chunk processes CI runs at once", () => {
	const modes = Object.keys(validModes) as Mode[];

	it("runs the singleton bucket one chunk at a time", () => {
		expect(codingAgentBucketPlans.singleton.ciChunksAtOnce).toBe(1);
		expect(chunksAtOnce("coding-agent-singleton", true, 100)).toBe(1);
	});

	it("bounds every bucket's width to the runner's cores", () => {
		const outOfRange = Object.entries(codingAgentBucketPlans).filter(
			([, plan]) => !Number.isInteger(plan.ciChunksAtOnce) || plan.ciChunksAtOnce < 1 || plan.ciChunksAtOnce > 4,
		);
		expect(outOfRange.map(([name]) => name)).toEqual([]);
	});

	it("runs each single-bucket mode at its plan's width and every other mode one chunk at a time", () => {
		const widths = Object.fromEntries(modes.map(mode => [mode, chunksAtOnce(mode, true, 100)]));
		expect(widths).toEqual(
			Object.fromEntries(
				modes.map(mode => {
					const bucket = mode.startsWith("coding-agent-") ? mode.slice("coding-agent-".length) : "";
					const plan = Object.hasOwn(codingAgentBucketPlans, bucket)
						? codingAgentBucketPlans[bucket as keyof typeof codingAgentBucketPlans]
						: undefined;
					return [mode, plan?.ciChunksAtOnce ?? 1];
				}),
			),
		);
		// `coding-agent-heavy` runs the singleton bucket among the others.
		expect(widths["coding-agent-heavy"]).toBe(1);
	});

	it("never runs more chunk processes than there are chunks", () => {
		expect(modes.filter(mode => chunksAtOnce(mode, true, 1) !== 1)).toEqual([]);
	});
});

describe("real dispatcher follows chunksAtOnce policy", () => {
	const originalConcurrency = Bun.env.VEYYON_TEST_CONCURRENCY;

	afterEach(() => {
		if (originalConcurrency === undefined) {
			delete Bun.env.VEYYON_TEST_CONCURRENCY;
		} else {
			Bun.env.VEYYON_TEST_CONCURRENCY = originalConcurrency;
		}
	});

	function makeCommands(count: number): TestCommand[] {
		return Array.from({ length: count }, (_, index) => ({
			label: `chunk-${index}`,
			cwd: "packages/coding-agent",
			command: ["bun", "test", `chunk-${index}.test.ts`],
		}));
	}

	async function runDispatch(options: {
		mode: Mode;
		ci: boolean;
		commandCount: number;
		dryRun?: boolean;
		junitReportDir?: string | null;
	}) {
		const parallelCalls: Array<{ count: number; concurrency: number }> = [];
		const sequenceCalls: number[] = [];
		const plan = await dispatchTestCommands(
			{
				mode: options.mode,
				ci: options.ci,
				commands: makeCommands(options.commandCount),
				dryRun: options.dryRun ?? false,
				junitReportDir: options.junitReportDir ?? null,
			},
			{
				runParallel: async (commands, concurrency) => {
					parallelCalls.push({ count: commands.length, concurrency });
				},
				runSequence: async commands => {
					sequenceCalls.push(commands.length);
				},
			},
		);
		return { plan, parallelCalls, sequenceCalls };
	}

	it("keeps singleton, UI, and multi-bucket CI modes at width 1 even with JUnit and VEYYON_TEST_CONCURRENCY=all", async () => {
		Bun.env.VEYYON_TEST_CONCURRENCY = "all";

		for (const mode of ["coding-agent-singleton", "coding-agent-ui", "coding-agent-heavy", "all"] as const) {
			const ordinary = await runDispatch({ mode, ci: true, commandCount: 6 });
			expect(ordinary.plan).toEqual({ runner: "sequence", concurrency: 1 });
			expect(ordinary.sequenceCalls).toEqual([6]);
			expect(ordinary.parallelCalls).toEqual([]);

			const junit = await runDispatch({ mode, ci: true, commandCount: 6, junitReportDir: "/tmp/junit" });
			expect(junit.plan).toEqual({ runner: "parallel", concurrency: 1 });
			expect(junit.parallelCalls).toEqual([{ count: 6, concurrency: 1 }]);
			expect(junit.sequenceCalls).toEqual([]);
		}
	});

	it("dispatches CI runtime and native buckets at width 3 in both ordinary and JUnit execution", async () => {
		delete Bun.env.VEYYON_TEST_CONCURRENCY;

		for (const mode of ["coding-agent-runtime", "coding-agent-native"] as const) {
			const ordinary = await runDispatch({ mode, ci: true, commandCount: 6 });
			expect(ordinary.plan).toEqual({ runner: "parallel", concurrency: 3 });
			expect(ordinary.parallelCalls).toEqual([{ count: 6, concurrency: 3 }]);
			expect(ordinary.sequenceCalls).toEqual([]);

			const junit = await runDispatch({ mode, ci: true, commandCount: 6, junitReportDir: "/tmp/junit" });
			expect(junit.plan).toEqual({ runner: "parallel", concurrency: 3 });
			expect(junit.parallelCalls).toEqual([{ count: 6, concurrency: 3 }]);
			expect(junit.sequenceCalls).toEqual([]);

			const capped = await runDispatch({ mode, ci: true, commandCount: 2 });
			expect(capped.plan).toEqual({ runner: "parallel", concurrency: 2 });
			expect(capped.parallelCalls).toEqual([{ count: 2, concurrency: 2 }]);

			const single = await runDispatch({ mode, ci: true, commandCount: 1 });
			expect(single.plan).toEqual({ runner: "sequence", concurrency: 1 });
			expect(single.sequenceCalls).toEqual([1]);
		}
	});

	it("honors VEYYON_TEST_CONCURRENCY outside CI and keeps dry-run/empty runs sequential", async () => {
		delete Bun.env.VEYYON_TEST_CONCURRENCY;
		const localDefault = await runDispatch({ mode: "coding-agent-runtime", ci: false, commandCount: 6 });
		expect(localDefault.plan).toEqual({ runner: "sequence", concurrency: 1 });
		expect(localDefault.sequenceCalls).toEqual([6]);

		Bun.env.VEYYON_TEST_CONCURRENCY = "4";
		const localOverride = await runDispatch({ mode: "coding-agent-singleton", ci: false, commandCount: 6 });
		expect(localOverride.plan).toEqual({ runner: "parallel", concurrency: 4 });
		expect(localOverride.parallelCalls).toEqual([{ count: 6, concurrency: 4 }]);

		Bun.env.VEYYON_TEST_CONCURRENCY = "all";
		const localAllJunit = await runDispatch({
			mode: "coding-agent-singleton",
			ci: false,
			commandCount: 6,
			junitReportDir: "/tmp/junit",
		});
		expect(localAllJunit.plan).toEqual({ runner: "parallel", concurrency: 6 });
		expect(localAllJunit.parallelCalls).toEqual([{ count: 6, concurrency: 6 }]);

		const dryRun = await runDispatch({
			mode: "coding-agent-runtime",
			ci: true,
			commandCount: 6,
			dryRun: true,
			junitReportDir: "/tmp/junit",
		});
		expect(dryRun.plan.runner).toBe("sequence");
		expect(dryRun.sequenceCalls).toEqual([6]);
		expect(dryRun.parallelCalls).toEqual([]);

		const empty = await runDispatch({
			mode: "coding-agent-runtime",
			ci: true,
			commandCount: 0,
			junitReportDir: "/tmp/junit",
		});
		expect(empty.plan.runner).toBe("sequence");
		expect(empty.sequenceCalls).toEqual([0]);
		expect(empty.parallelCalls).toEqual([]);
	});
});
