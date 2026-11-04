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

/** One real event-loop turn, so I/O in flight completes before fake time moves on. */
function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * Settle `work` under {@link installFakeTime} by alternating a real event-loop turn with a 10ms step
 * of fake time, so timers fire in time order while the I/O between them runs as it would. Fails after
 * 100s of fake time.
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
		await nextTurn();
		if (!settled) vi.advanceTimersByTime(DRIVE_STEP_MS);
	}
	const result = await outcome;
	if (!result.ok) throw result.error;
	return result.value;
}
