import * as logger from "./logger";
import { errorMessage } from "./type-guards";

export interface IdleTrimOptions {
	/** Quiet time after the last busy window before the trim runs, in ms. Default 30 000. */
	quietMs?: number;
	/** Length of one CPU sampling window, in ms. Default 5 000. */
	sampleMs?: number;
	/**
	 * A window whose process CPU exceeds this share of its wall time is busy. Default 0.05: an idle
	 * interactive session measures 0.5%, a streaming turn tens of percent.
	 */
	busyCpuRatio?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Process CPU consumed so far, in microseconds; injectable for tests. Default `process.cpuUsage`. */
	cpuUsage?: () => { user: number; system: number };
	/** Timer source; injectable for tests. Default `setTimeout`. */
	schedule?: (cb: () => void, ms: number) => IdleTrimTimer;
	/** The trim itself; injectable for tests and for a caller that releases more. Default `trimEngine`. */
	trim?: () => void;
}

/**
 * Deletes the engine's compiled code, runs a full collection and releases free malloc pages.
 * `Bun.shrink()` has no `node:*` equivalent: V8 exposes no call that discards compiled code.
 */
export function trimEngine(): void {
	Bun.shrink();
}

/** Timer handle the trim arms. `cancel`, when present, is invoked on stop(). */
interface IdleTrimTimer {
	unref?(): void;
	cancel?(): void;
}

/**
 * Discards the JavaScript engine's compiled code and returns the allocator's free pages once the
 * process has been quiet for `quietMs`.
 *
 * A session waiting on its user keeps every function it has run compiled: the startup path, the
 * last turn's streaming and rendering, each tool it called. JavaScriptCore regenerates any of it
 * from source on the next call. `Bun.shrink()` deletes the code blocks, runs a full collection and
 * releases free malloc pages, on the next idle point of the loop.
 *
 * MEASURED on the linux-x64 binary, interactive session against a local endpoint:
 * - idle after startup: RSS 337 -> 323 MiB, JS heap 70.6 -> 49.7 MiB.
 * - idle after eight turns: RSS 374 -> 349 MiB.
 * - the trim holds the loop 36-46 ms and costs 81-105 ms of CPU across the collector threads.
 * - the next keystroke echoes in 6.5 ms instead of 3.2 ms; the next turn takes 115 ms instead of
 *   75 ms, and RSS after it stays 15 MiB under the untrimmed run, since only the code that turn
 *   ran is compiled again.
 *
 * Quiet is read from process CPU rather than from any one source of work, so a turn, a subagent,
 * a tool, a render or a keystroke all hold the trim off without reporting to it, in every mode.
 * A window whose CPU stays under `busyCpuRatio` of its wall time is quiet. After a trim the
 * process stays trimmed until a busy window is seen, so an idle process trims once rather than
 * every `quietMs`. The window holding the trim is not judged: its CPU is the trim's own collection.
 *
 * The sampling timer is `unref`'d and never keeps the process alive; stop() cancels it.
 */
export class IdleTrim {
	#quietMs: number;
	#sampleMs: number;
	#busyCpuRatio: number;
	#now: () => number;
	#cpuUsage: () => { user: number; system: number };
	#schedule: (cb: () => void, ms: number) => IdleTrimTimer;
	#trim: () => void;
	#running = false;
	// Bumped by stop(); a tick armed under an older generation no-ops, so start()→stop()→start()
	// never leaves two sampling chains running.
	#generation = 0;
	#handle: IdleTrimTimer | undefined;
	#windowStartMs = 0;
	/** Process CPU at the start of the armed window, in microseconds. */
	#windowStartCpuUs = 0;
	/** End of the most recent busy window: the quiet period is measured from here. */
	#quietSinceMs = 0;
	/** A trim ran and no busy window has been seen since. */
	#trimmed = false;
	/** The armed window holds the trim's own collection and is not judged. */
	#skipWindow = false;

	constructor(options: IdleTrimOptions = {}) {
		this.#quietMs = options.quietMs ?? 30_000;
		this.#sampleMs = options.sampleMs ?? 5_000;
		this.#busyCpuRatio = options.busyCpuRatio ?? 0.05;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return { unref: () => timer.unref?.(), cancel: () => clearTimeout(timer) };
			});
		this.#trim = options.trim ?? trimEngine;
	}

	/** Start sampling. The quiet period starts now. Idempotent. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#trimmed = false;
		this.#skipWindow = false;
		this.#quietSinceMs = this.#now();
		this.#arm();
	}

	/** Stop sampling and cancel the armed window. */
	stop(): void {
		this.#running = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	get running(): boolean {
		return this.#running;
	}

	#arm(): void {
		const generation = this.#generation;
		this.#windowStartMs = this.#now();
		const cpu = this.#cpuUsage();
		this.#windowStartCpuUs = cpu.user + cpu.system;
		this.#handle = this.#schedule(() => this.#sample(generation), this.#sampleMs);
		this.#handle.unref?.();
	}

	#sample(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const now = this.#now();
		const cpu = this.#cpuUsage();
		const cpuMs = (cpu.user + cpu.system - this.#windowStartCpuUs) / 1000;
		const wallMs = now - this.#windowStartMs;
		if (this.#skipWindow) {
			this.#skipWindow = false;
		} else if (cpuMs > wallMs * this.#busyCpuRatio) {
			this.#quietSinceMs = now;
			this.#trimmed = false;
		} else if (!this.#trimmed && now - this.#quietSinceMs >= this.#quietMs) {
			try {
				this.#trim();
			} catch (error) {
				// The engine offers no trim; sampling for one that can never run is waste.
				logger.warn("Idle trim failed; sampling stopped", { error: errorMessage(error) });
				this.stop();
				return;
			}
			this.#trimmed = true;
			this.#skipWindow = true;
			logger.debug("Idle trim ran", { quietMs: Math.round(now - this.#quietSinceMs) });
		}
		this.#arm();
	}
}
