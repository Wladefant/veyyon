/**
 * No test file may construct a `ToolExecutionComponent` directly. They come from the helper, which
 * stops their animation when the test ends.
 *
 * WHY THIS SUITE EXISTS. A live tool block runs an 80ms interval that ticks the spinner and asks the TUI
 * to repaint, and `stopAnimation()` is the only thing that clears it. Sixteen test files constructed one
 * and never stopped it, so each left an interval firing at a dead component for the rest of the process.
 * The cost was invisible until it was not: one of those leaks turned another suite's unrestored global
 * theme into 12 failures across session-manager migration, large-session memory guards and
 * eval/idle-timeout, none of which render a tool block at all.
 *
 * Cleanup that depends on remembering does not hold across 23 files and everything added after them, so
 * the requirement is structural: construction goes through `helpers/tool-execution`, which stops every
 * component it hands out when the test that built it ends. This suite is what makes "forgot to use the
 * helper" a failure in the file that forgot, rather than a mystery in a suite that did nothing wrong.
 *
 * The ban is read as source text, because a leaked interval is silent until it collides with something
 * else. The helper's half of the contract is observed: a block built in one test repaints while that
 * test runs and never after it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createToolExecution, withToolExecutions } from "./helpers/tool-execution";

const TEST_ROOT = path.resolve(import.meta.dir);
const HELPER = path.join(TEST_ROOT, "helpers", "tool-execution.ts");
const DIRECT_CONSTRUCTION = "new ToolExecutionComponent(";

/**
 * Every `.ts` file under `test/`, so a new suite is covered the moment it is added, read once for
 * the whole file. Three cases each walking and re-reading 360 sources put this suite over its
 * five-second budget on a checkout served over the network, which reads as a defect in the rule
 * rather than in the machine.
 */
let sources: Map<string, string> | undefined;

function testSources(): Map<string, string> {
	if (sources) return sources;
	const found = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules") continue;
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.endsWith(".ts")) found.set(full, readFileSync(full, "utf8"));
		}
	};
	walk(TEST_ROOT);
	sources = found;
	return found;
}

describe("tool block construction in tests", () => {
	/**
	 * The contract. The helper itself is the one allowed constructor call, since it is what performs the
	 * cleanup.
	 *
	 * The case bound is the walk plus one read of every test source. On a checkout served over the
	 * network that is seconds, so the default five would fail on latency rather than on an offender.
	 */
	it("goes through the helper, never a direct constructor call", () => {
		const offenders: string[] = [];
		for (const [file, source] of testSources()) {
			// The helper is the one place allowed to call the constructor, and THIS file quotes the
			// banned string in order to search for it.
			if (file === HELPER || file === import.meta.filename) continue;
			if (source.includes(DIRECT_CONSTRUCTION)) offenders.push(path.relative(TEST_ROOT, file));
		}

		expect(offenders).toEqual([]);
	}, 30_000);

	/**
	 * And the helper still does the thing the ban exists for. Without these two, someone could satisfy the
	 * rule above by having the helper merely forward the constructor, which would make every suite look
	 * compliant while leaking exactly as before. Real timers on purpose: a fake clock is dropped when its
	 * test ends, which would hide the very interval these cases look for.
	 */
	describe("a block the helper hands out", () => {
		let repaints = 0;
		const countingUi = { requestRender: () => {}, requestComponentRender: () => repaints++ } as never;

		beforeAll(async () => {
			await initTheme();
		});

		it("repaints while the test that built it runs", async () => {
			createToolExecution(
				"eval",
				{ language: "py", code: "import time\ntime.sleep(10)" },
				{},
				undefined,
				countingUi,
			);

			await sleep(250);

			expect(repaints).toBeGreaterThan(0);
		});

		it("stops repainting once the test that built it has ended", async () => {
			const before = repaints;

			await sleep(250);

			expect(repaints).toBe(before);
		});

		it("stops a scoped builder's blocks once its body settles", async () => {
			let scoped = 0;
			const ui = { requestRender: () => {}, requestComponentRender: () => scoped++ } as never;

			await withToolExecutions(async create => {
				create("eval", { language: "py", code: "import time\ntime.sleep(10)" }, {}, undefined, ui);
				await sleep(250);
			});
			const settled = scoped;
			await sleep(250);

			expect(settled).toBeGreaterThan(0);
			expect(scoped).toBe(settled);
		});
	});

	/**
	 * The ban is worth nothing if nothing uses the helper: a scan that finds zero direct constructions
	 * because the suites were deleted would pass silently. Pin that the helper is genuinely in use.
	 */
	it("is used by the suites that render tool blocks", () => {
		let users = 0;
		for (const source of testSources().values()) {
			if (source.includes("createToolExecution(")) users += 1;
		}

		expect(users).toBeGreaterThanOrEqual(20);
	});
});
