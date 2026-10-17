/**
 * The interactive TUI must not be in the CLI's STATIC import graph.
 *
 * WHY THIS SUITE EXISTS. `main.ts` loads interactive mode with `import("./modes/terminal/interactive-mode")` and
 * says why in a comment: the `modes/components` subtree is the largest single chunk of the boot graph, so
 * kicking it off deliberately lets it overlap with session creation "and so print/rpc/acp runs never pay
 * for it at all". That was not true. Two static edges pulled the same subtree in anyway, and a
 * `veyyon -p "hi"` run loaded the settings overlay, the plugin-settings panel and the interactive mode it
 * would never construct:
 *
 *   1. Four extensibility loaders held `import * as PiCodingAgent from "../../index"` so extension authors
 *      could be handed the package as `api.pi`. `src/index.ts` re-exports `./modes`, whose barrel
 *      re-exports `interactive-mode`. Three of those loaders run during startup, so every launch loaded
 *      the whole library surface -- with no extensions installed. They now go through
 *      `extensibility/coding-agent-api.ts`, which imports the barrel on demand.
 *   2. `main.ts` imported two tiny functions from `modes/terminal/components/dialogs/welcome.ts`, which put a component
 *      module -- and `@veyyon/tui`, the theme and the shimmer machinery behind it -- in the static graph of
 *      every launch. Those two functions moved to `modes/terminal/components/dialogs/launch-tip.ts`, which imports nothing
 *      but `APP_NAME`.
 *
 * A comment cannot hold this. Both edges were written by people who had no reason to think about startup
 * cost, and neither looked wrong: one is how the extension API is defined, the other is an import of two
 * functions. What makes the difference measurable is that they are STATIC -- Bun reads the entire
 * statically reachable graph before evaluating anything -- so the check has to be on the graph, not on a
 * naming convention. Resolving the graph here is why `interactive-mode`'s inclusive load fell from 402ms
 * to 75ms and the instrumented boot wall from ~2.0s to ~1.1s.
 *
 * The graph is the shared module-reach walk (`test/helpers/module-reach-gate.ts`), which resolves every
 * workspace package from its `exports` map. This suite once carried its own walker that mapped
 * `@veyyon/<name>` to `packages/<name>/src`, so `@veyyon/agent-core`, `@veyyon/kernel` and `@veyyon/tui`
 * resolved to nothing and every edge through them was invisible to a "does not reach" assertion.
 *
 * What it does not catch: a module that is lazy here but reached at run time through a dynamic import
 * that runs on every launch; that cost is measured by the launch reach ceiling, not by this graph.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { moduleReach } from "@veyyon/utils/module-reach";
import { CACHE, RESOLUTION, SRC } from "./helpers/module-reach-gate";

/**
 * The boot graph, from both entry points that make it up.
 *
 * `cli.ts` hands off with `await import("./main")` on purpose -- profile selection has to run before
 * anything reads the agent directory -- so its own static graph stops at the handoff and says nothing
 * about what a launch loads. `main.ts` is where the rest of the launch is statically reachable from, and
 * it is reached on every run, so the union of the two is the graph a user actually pays for.
 */
const CLI_GRAPH = new Set([
	...moduleReach(path.join(SRC, "cli.ts"), RESOLUTION, CACHE),
	...moduleReach(path.join(SRC, "main.ts"), RESOLUTION, CACHE),
]);

/** Modules that must stay out of the static boot graph, with what each one drags in behind it. */
const MUST_BE_LAZY: ReadonlyArray<{ file: string; why: string }> = [
	{ file: "modes/terminal/interactive-mode.ts", why: "the whole interactive mode; print/rpc/acp runs never build it" },
	{
		file: "modes/terminal/components/dialogs/plugin-settings.ts",
		why: "the plugin settings panel and the marketplace types",
	},
	{
		file: "modes/terminal/components/selectors/settings-selector.ts",
		why: "every settings tab and its component tree",
	},
	{ file: "modes/terminal/components/dialogs/welcome.ts", why: "the welcome card, the sun mark and the tips corpus" },
	{ file: "index.ts", why: "the package barrel, which re-exports every mode and every component" },
	{ file: "modes/index.ts", why: "the modes barrel, which re-exports interactive-mode" },
];

describe("the CLI's static import graph", () => {
	for (const { file, why } of MUST_BE_LAZY) {
		/**
		 * One assertion per module so a regression names the module it broke, not a set difference. Each
		 * of these is reachable at runtime through a dynamic import when it is genuinely needed.
		 */
		it(`excludes ${file} (${why})`, () => {
			expect(CLI_GRAPH.has(path.join(SRC, file))).toBe(false);
		});
	}

	/**
	 * The walk has to cross package boundaries, or every assertion above passes on a graph that stops at
	 * the first `@veyyon/` specifier. Pin the entry points and one module from each package the old walker
	 * could not resolve.
	 */
	it("is walked across every workspace package the launch imports", () => {
		const packages = path.join(SRC, "..", "..");
		const root = path.join(packages, "..");
		for (const file of [
			path.join(SRC, "cli.ts"),
			path.join(SRC, "main.ts"),
			path.join(SRC, "sdk.ts"),
			path.join(packages, "agent", "src", "index.ts"),
			path.join(root, "kernel", "src", "session", "session-manager.ts"),
		]) {
			expect(CLI_GRAPH.has(file)).toBe(true);
		}
	});

	/**
	 * The two fixes, as edges. The extension API module is the one place allowed to reach the barrel, and
	 * only through a dynamic import, so its static graph excludes it. The launch tip is in the boot graph
	 * from the module that holds no component, which is why the welcome card above is not.
	 */
	it("keeps the barrel out of the extension API's static graph and the launch tip in the boot graph", () => {
		const api = moduleReach(path.join(SRC, "extensibility", "coding-agent-api.ts"), RESOLUTION, CACHE);
		expect(api.has(path.join(SRC, "index.ts"))).toBe(false);
		expect(CLI_GRAPH.has(path.join(SRC, "extensibility", "coding-agent-api.ts"))).toBe(true);
		expect(CLI_GRAPH.has(path.join(SRC, "modes", "terminal", "components", "dialogs", "launch-tip.ts"))).toBe(true);
	});
});
