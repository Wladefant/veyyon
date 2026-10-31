import { vi } from "bun:test";

/**
 * Fake timers for code whose time sources are `setTimeout`, `Date.now()` and `Bun.sleep`.
 *
 * `vi.useFakeTimers()` covers `setTimeout` and `Date`; `Bun.sleep` is routed onto a fake
 * `setTimeout`, so a sleep that is still pending counts in `vi.getTimerCount()` like any other
 * timer. Undo with `vi.restoreAllMocks()` followed by `vi.useRealTimers()`.
 */
export function installFakeTime(): void {
	vi.useFakeTimers();
	vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	}) as typeof Bun.sleep);
}

const DRIVE_STEP_MS = 10;
const DRIVE_MAX_STEPS = 10_000;
/**
 * Real milliseconds each step of {@link driveFakeTime} parks the thread before fake time moves.
 *
 * An event-loop turn does not wait for the thread pool, and a turn takes microseconds: stepping
 * fake time once per turn spent seconds of fake time inside one 3ms write and fired the budget
 * timers the code under test had armed ahead of that write. Bun's fake timers freeze `Date`,
 * `performance.now`, `process.hrtime`, `node:timers/promises` and `Bun.sleep`, so `Atomics.wait`
 * is the one real wait left.
 */
const DRIVE_PACE_MS = 0.1;
const paceCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * The most fake milliseconds {@link driveFakeTime} spends per real millisecond. Real I/O inside the
 * driven work consumes fake time at no more than this rate, so a budget the work arms ahead of its
 * I/O expires only when the I/O takes longer than the budget divided by this factor.
 */
export const FAKE_TIME_MAX_SPEEDUP = DRIVE_STEP_MS / DRIVE_PACE_MS;

/** One real event-loop turn, so a completion that landed during the pace runs before fake time moves. */
function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * Settle `work` under {@link installFakeTime}: each step parks the thread for {@link DRIVE_PACE_MS}
 * of real time so in-flight I/O completes, runs one real event-loop turn, then advances fake time by
 * 10ms, so timers fire in time order while the I/O between them runs as it would. Fails after 100s
 * of fake time.
 *
 * Read a rejection with `.then(onFulfilled, onRejected)`, not `expect(...).rejects`: under fake
 * timers `rejects` can stall the turns this loop runs on, and the test then hangs until its timeout.
 */
export async function driveFakeTime<T>(work: Promise<T>): Promise<T> {
	let settled = false;
	// The rejection handler is attached now, not after the loop: a rejection left unhandled across
	// one event-loop turn is reported by the test runner as a failure of its own.
	const outcome = work.then(
		value => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	void outcome.then(() => {
		settled = true;
	});
	for (let step = 0; !settled; step++) {
		if (step === DRIVE_MAX_STEPS) throw new Error(`work did not settle within ${DRIVE_MAX_STEPS} steps of fake time`);
		Atomics.wait(paceCell, 0, 0, DRIVE_PACE_MS);
		await nextTurn();
		if (!settled) vi.advanceTimersByTime(DRIVE_STEP_MS);
	}
	const result = await outcome;
	if (!result.ok) throw result.error;
	return result.value;
}
