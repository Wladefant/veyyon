import { afterEach, describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { StallSampler } from "@veyyon/utils/stall-sampler";

/**
 * WHY THIS SUITE EXISTS. Until a profile stops, JavaScriptCore keeps every function its samples
 * caught reachable, and with each function the closure it captured. The stall sampler kept a busy
 * profile for 10s, so every provider request of those 10s stayed alive through the closures that
 * built it: the whole request context and its serialized body. Over 40 prompts of a mixed-tool
 * session the heap left after a full collection peaked at 173-177 MB, against 66-68 MB with no
 * profiler running.
 *
 * THE CLASS. Anything a sampled closure captured outliving the watchdog tick that follows the work.
 * The cases drive the real profiler: a closure over an object holds the loop until the profiler has
 * sampled it, and the object must be collectable once a busy tick or a block's read replaces the
 * profile. An idle tick keeps the profile, and the object with it: that case is the control, and it
 * proves the others observe the profiler's hold rather than an object that was never held.
 *
 * WHAT IT DOES NOT CATCH. A function sampled inside the current tick interval stays reachable until
 * the next tick; that bound is the design. An idle profile keeps what it sampled until it is full,
 * 100s at the idle interval, and the idle interval samples a tenth as often.
 */

const samplers: StallSampler[] = [];

/** A running sampler, its start settled. */
async function startedSampler(): Promise<StallSampler> {
	const sampler = new StallSampler();
	samplers.push(sampler);
	sampler.quiet(performance.now(), true);
	await sampler.stacksBetween(0, 0);
	return sampler;
}

afterEach(async () => {
	// The profiler is process-global; stop every sampler's profile before the next case starts its own.
	for (const sampler of samplers.splice(0)) await sampler.borrow();
});

function holdTheLoopForMs(ms: number): number {
	const until = performance.now() + ms;
	let x = 0;
	while (performance.now() < until) x += Math.sqrt(x + 1);
	return x;
}

/**
 * Runs a closure over a fresh object long enough for the busy interval to sample it about twenty
 * times, and returns a weak handle on the object. Nothing but the profile refers to the closure after.
 */
function sampleAClosureOverAnObject(): WeakRef<object> {
	const captured = { held: true };
	const work = (): boolean => holdTheLoopForMs(200) > 0 && captured.held;
	work();
	return new WeakRef(captured);
}

/** Whether a full collection, run in a later task than the one that held the object, frees it. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
	await new Promise(resolve => setTimeout(resolve, 0));
	Bun.gc(true);
	await new Promise(resolve => setTimeout(resolve, 0));
	return ref.deref() === undefined;
}

describe("a busy tick releases what the profiler sampled", () => {
	test("an idle tick keeps the profile, and what it sampled with it", async () => {
		const sampler = await startedSampler();
		const ref = sampleAClosureOverAnObject();
		sampler.quiet(performance.now(), false);
		expect(await collected(ref)).toBe(false);
	});

	test("a busy tick releases every function the replaced profile sampled", async () => {
		const sampler = await startedSampler();
		const ref = sampleAClosureOverAnObject();
		sampler.quiet(performance.now(), true);
		expect(await collected(ref)).toBe(true);
	});

	test("reading a block's stacks releases every function the profile sampled", async () => {
		const sampler = await startedSampler();
		const from = performance.now();
		const ref = sampleAClosureOverAnObject();
		const stacks = await sampler.stacksBetween(from, performance.now());
		expect(stacks?.samples).toBeGreaterThan(0);
		expect(await collected(ref)).toBe(true);
	});
});
