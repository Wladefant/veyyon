/**
 * The module-global state the leak tracer watches, beyond the environment.
 *
 * Kept apart from `global-state-leak-tracer.ts` on purpose: that module is
 * imported by `scripts/test-sandbox/find-test-leaks.ts` outside a test runner, and it must not
 * drag `dirs.ts` (or anything else being probed) into that process.
 *
 * `@veyyon/utils` module state and the process's armed intervals are probed here. The
 * resolver is where the state that silently changes every later file's paths actually
 * lives, and importing a heavier package into every traced process would risk the
 * diagnostic initialising state it is supposed to be observing.
 */
import * as path from "node:path";
import { __preProfileAgentDirForTests, getActiveProfile, getAgentDir, getProjectDir } from "../../src/dirs";
import { registerLeakProbe } from "./global-state-leak-tracer";

/**
 * `setProfile("work")` with no restore leaves every later file resolving under
 * `profiles/work/`, and putting the environment back does NOT undo it: the active
 * profile is module state, which is why `enterIsolatedConfigRoot`'s restore
 * re-derives it rather than only refreshing paths.
 */
registerLeakProbe("activeProfile", () => getActiveProfile() ?? "(default)");

/** The resolved agent dir, which `setAgentDir` changes in module state as well as
 *  in the environment. */
registerLeakProbe("agentDir", () => getAgentDir());

/** `setProjectDir` also moves `process.cwd()`, so a suite that changes the project
 *  root and does not restore it breaks every relative path after it. */
registerLeakProbe("projectDir", () => getProjectDir());

/**
 * The pre-profile agent-dir baseline. It is INVISIBLE in the environment and in every
 * other probe here — `setAgentDir` overwrites it, and nothing about the resolved agent
 * dir or the active profile reveals the change. What it decides is where
 * `setProfile(undefined)` lands, so a suite that leaves it pointing at its own deleted
 * temp dir breaks the next file that returns to the default profile, and the report would
 * name a path that no test in that file ever mentioned.
 */
registerLeakProbe("preProfileAgentDir", () => __preProfileAgentDirForTests() ?? "(none)");

/**
 * Intervals still armed, by the line that armed them.
 *
 * A suite that builds an animated component and never stops it leaves the component's interval
 * firing for the rest of the process. An interval that fires while a later file runs fake timers
 * moves onto the fake clock, and that file's `vi.getTimerCount()` then counts a timer it never
 * armed: the failure lands on the later file, and the file that armed the interval passes.
 *
 * An interval is armed until its `_destroyed` flag is set, which `clearInterval`,
 * `clearTimeout`, `close()` and `vi.useRealTimers()` (for a fake interval) all do. Each timer is
 * held through a `WeakRef`: the runtime keeps an armed one reachable, and a stopped one stays
 * collectible, so a suite that asserts its components are collected still sees them collected.
 * `scripts/test-sandbox/find-test-leaks.test.ts` drives a fixture that stops three intervals,
 * leaves one armed and forces a full collection before the read, so a runtime that stops setting
 * the flag, or that lets an armed interval be collected, fails the tracer's self-tests.
 *
 * Only `setInterval` is tracked. A pending `setTimeout` fires once and ends; a timeout that
 * re-arms itself through `refresh()` is not seen.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const armedIntervals = new Set<WeakRef<NodeJS.Timeout>>();
const armingSites = new WeakMap<NodeJS.Timeout, string>();
const nativeSetInterval = globalThis.setInterval;

/**
 * The `path:line` of the first frame below the wrapper that names a file on disk, repo-relative.
 * A frame from code with no file, such as a runtime builtin, is skipped.
 */
function armingSite(stack: string | undefined): string {
	for (const frame of stack?.split("\n").slice(2) ?? []) {
		const location = /\(?(\/[^\s()]+):(\d+):\d+\)?$/.exec(frame.trim());
		if (location) return `${path.relative(REPO_ROOT, location[1] ?? "")}:${location[2]}`;
	}
	return "(unknown)";
}

globalThis.setInterval = ((handler: unknown, ms?: number, ...args: unknown[]) => {
	const timer = Reflect.apply(nativeSetInterval, globalThis, [handler, ms, ...args]) as NodeJS.Timeout;
	armingSites.set(timer, armingSite(new Error().stack));
	armedIntervals.add(new WeakRef(timer));
	return timer;
}) as typeof setInterval;

registerLeakProbe("armedIntervals", () => {
	const bySite = new Map<string, number>();
	for (const ref of armedIntervals) {
		const timer = ref.deref();
		if (timer === undefined || (timer as { _destroyed?: boolean })._destroyed === true) {
			armedIntervals.delete(ref);
			continue;
		}
		const site = armingSites.get(timer) ?? "(unknown)";
		bySite.set(site, (bySite.get(site) ?? 0) + 1);
	}
	if (bySite.size === 0) return "(none)";
	return [...bySite]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([site, count]) => `${site} x${count}`)
		.join(", ");
});
