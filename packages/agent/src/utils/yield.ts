/**
 * Cooperative yield utility for preventing Bun event-loop busy-wait.
 *
 * ## Root Cause
 *
 * Bun 1.3.x (JavaScriptCore) event loop busy-waits (spins in userspace)
 * when the only pending work is an unresolved Promise — even if there are
 * active I/O watchers (stdin, child process pipes, etc.).  The event loop
 * continuously polls for microtask resolution instead of blocking in
 * `epoll_wait`, consuming ~100% of a CPU core.
 *
 * This affects any `await` on a never-resolved Promise, including:
 * - `Promise.withResolvers()` used for user input callbacks
 * - `await proc.exited` for long-running child processes
 * - Agent loop iterations waiting for the next tool call
 *
 * ## Fix
 *
 * A recurring `setInterval` keeps the event loop sleeping in `epoll_wait`.
 * The `EventLoopKeepalive` class installs and clears this keepalive timer.
 *
 * `yieldIfDue()` hands the event loop a turn from the agent-loop hot path, so a
 * run of already-settled promises (buffered stream events, back-to-back tool
 * batches) cannot hold off timers, input and rendering. `ExponentialYield`
 * backs off the bash executor's long waits.
 */

import { scheduler, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { DAY_MS, isAbortError } from "@veyyon/utils";

// ---------------------------------------------------------------------------
// EventLoopKeepalive — the primary fix for idle-state busy-wait
// ---------------------------------------------------------------------------

export class EventLoopKeepalive {
	#tmr = setInterval(() => {}, DAY_MS).unref();
	[Symbol.dispose](): void {
		clearInterval(this.#tmr);
	}
}

// ---------------------------------------------------------------------------
// yieldIfDue — keeps timers, input and rendering serviced on the agent-loop hot path
// ---------------------------------------------------------------------------

const YIELD_INTERVAL_MS = 50;

/**
 * Sleep for at least `ms` milliseconds of wall-clock time.
 * Retries the wait if it returns prematurely (which can happen when napi
 * callbacks wake the event loop via `uv_async_send`). When `signal` is
 * provided, the wait is cancellable and silently returns on abort instead
 * of throwing — callers race against another promise that decides what to
 * do next.
 */
async function sleepAtLeast(ms: number, signal?: AbortSignal): Promise<void> {
	const start = performance.now();
	let remaining = ms;
	while (remaining > 0) {
		if (signal?.aborted) return;
		try {
			await scheduler.wait(remaining, { signal });
		} catch (err) {
			if (isAbortError(err)) return;
			throw err;
		}
		remaining = ms - (performance.now() - start);
	}
}

/**
 * Cooperative yield gate. Hands the event loop a turn at most once every
 * {@link YieldGateOptions.intervalMs}; hot-path callers invoke it freely and only
 * the due call yields. A yield costs one event-loop turn, never a wall-clock
 * sleep: an agent loop calls it on every streamed event, after every tool batch
 * and at the top of every turn, so a sleep here is added to every one of them.
 *
 * The clock and the yield are injectable so tests drive the gate logic without
 * touching process-global `Date.now` — a global a concurrent test file can
 * restore mid-run, which previously made the shared gate flake.
 */
export interface YieldGateOptions {
	now?: () => number;
	yieldTurn?: () => Promise<unknown>;
	intervalMs?: number;
}

export class YieldGate {
	#lastYieldAt = 0;
	readonly #now: () => number;
	readonly #yieldTurn: () => Promise<unknown>;
	readonly #intervalMs: number;

	constructor(opts: YieldGateOptions = {}) {
		this.#now = opts.now ?? (() => Date.now());
		this.#yieldTurn = opts.yieldTurn ?? yieldToEventLoop;
		this.#intervalMs = opts.intervalMs ?? YIELD_INTERVAL_MS;
	}

	async yieldIfDue(): Promise<void> {
		const now = this.#now();
		const elapsed = now - this.#lastYieldAt;
		// `elapsed < 0` means the wall clock moved backward relative to the last
		// yield (NTP step, fake-timer test, or a stale future timestamp left by
		// another caller): treat it as due and re-anchor rather than gate forever.
		if (elapsed >= 0 && elapsed < this.#intervalMs) return;
		await this.#yieldTurn();
		this.#lastYieldAt = this.#now();
	}
}

/**
 * Process-wide gate shared by all hot-path callers so tight loops collectively
 * respect the interval rather than each yielding independently.
 */
const sharedYieldGate = new YieldGate();

/**
 * Hand the event loop a turn, at most once every {@link YIELD_INTERVAL_MS}
 * across all callers.
 */
export function yieldIfDue(): Promise<void> {
	return sharedYieldGate.yieldIfDue();
}

// ---------------------------------------------------------------------------
// ExponentialYield — retained for bash-executor long waits
// ---------------------------------------------------------------------------

const EXP_DEFAULT_MIN_MS = 20;
const EXP_DEFAULT_MAX_MS = 10_000;
const EXP_DEFAULT_MULTIPLIER = 2;

export class ExponentialYield {
	#currentMs: number;
	readonly #minMs: number;
	readonly #maxMs: number;
	readonly #multiplier: number;

	constructor(opts?: { minMs?: number; maxMs?: number; multiplier?: number }) {
		this.#minMs = opts?.minMs ?? EXP_DEFAULT_MIN_MS;
		this.#maxMs = opts?.maxMs ?? EXP_DEFAULT_MAX_MS;
		this.#multiplier = opts?.multiplier ?? EXP_DEFAULT_MULTIPLIER;
		this.#currentMs = this.#minMs;
	}

	notifyActivity(): void {
		this.#currentMs = this.#minMs;
	}

	async sleep(signal?: AbortSignal): Promise<number> {
		const ms = this.#currentMs;
		await sleepAtLeast(ms, signal);
		this.#currentMs = Math.min(this.#currentMs * this.#multiplier, this.#maxMs);
		return ms;
	}

	/**
	 * Race `racers` against an exponentially-backed-off cooperative yield.
	 * The losing sleep is cancelled as soon as a racer settles, so no stray
	 * timers keep the event loop alive past the racer's resolution.
	 */
	async race<T>(racers: Array<Promise<T>>): Promise<T> {
		const racer = Promise.race(racers);
		const controller = new AbortController();
		try {
			const yieldMarker = Symbol("exp-yield");
			for (;;) {
				const result = await Promise.race<T | typeof yieldMarker>([
					racer,
					this.sleep(controller.signal).then(() => yieldMarker as T | typeof yieldMarker),
				]);
				if (result !== yieldMarker) {
					this.notifyActivity();
					return result;
				}
			}
		} finally {
			controller.abort();
		}
	}
}
