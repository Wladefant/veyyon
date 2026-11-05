/**
 * Replaces the global `Worker` constructor until `restore()` runs. Each construction increments
 * `constructed` and throws `failure`, so a test reads how many workers the code under test tried to
 * start without starting one.
 */
export interface WorkerStandIn {
	readonly constructed: number;
	restore(): void;
}

export function installWorkerStandIn(failure: Error): WorkerStandIn {
	const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
	if (!original) throw new Error("globalThis.Worker is not defined; the stand-in has nothing to replace");
	let constructed = 0;
	class StandInWorker {
		constructor() {
			constructed++;
			throw failure;
		}
	}
	Object.defineProperty(globalThis, "Worker", { value: StandInWorker, configurable: true, writable: true });
	return {
		get constructed() {
			return constructed;
		},
		restore() {
			Object.defineProperty(globalThis, "Worker", original);
		},
	};
}
