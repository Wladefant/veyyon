/**
 * WHY: an eval cell whose idle watchdog fired while its kernel was still starting killed the whole
 * host (Wladefant/veyyon#73). `waitForPromiseWithCancellation` threw on an already-aborted signal or
 * exhausted deadline before it subscribed to the kernel-start promise; that promise then rejected with
 * the signal's own reason (`TimeoutError: Idle for 10s`) and nothing observed it, which Bun reports as
 * a process-fatal unhandled rejection.
 *
 * Closes the class: every early exit of the helper, for a promise that rejects later. Does not cover
 * unhandled rejections raised elsewhere in the eval stack.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { waitForPromiseWithCancellation } from "../executor-base";

class Cancelled extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
	}
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

beforeEach(() => {
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
});

// Bun reports an unhandled rejection after the microtask queue drains; a few macrotask turns cover it.
async function settleMacrotasks(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await nextMacrotask();
}

describe("waitForPromiseWithCancellation abandoning a promise that rejects later", () => {
	it("survives a signal that was already aborted by the idle watchdog", async () => {
		const reason = new DOMException("Idle for 10s", "TimeoutError");
		const controller = new AbortController();
		controller.abort(reason);

		const { promise: start, reject } = Promise.withResolvers<never>();
		queueMicrotask(() => reject(reason));
		const outcome = await waitForPromiseWithCancellation(start, { signal: controller.signal }, Cancelled).catch(
			err => err,
		);
		await settleMacrotasks();

		expect(outcome).toBeInstanceOf(Cancelled);
		expect((outcome as Cancelled).timedOut).toBe(true);
		expect(unhandled).toEqual([]);
	});

	it("survives an exhausted deadline", async () => {
		const { promise: start, reject } = Promise.withResolvers<never>();
		queueMicrotask(() => reject(new Error("kernel start failed")));
		const outcome = await waitForPromiseWithCancellation(start, { deadlineMs: Date.now() - 1 }, Cancelled).catch(
			err => err,
		);
		await settleMacrotasks();

		expect(outcome).toBeInstanceOf(Cancelled);
		expect(unhandled).toEqual([]);
	});

	it("still delivers the rejection when the wait outlives the promise", async () => {
		const controller = new AbortController();
		const failure = new Error("kernel start failed");

		const { promise: start, reject } = Promise.withResolvers<never>();
		const waiting = waitForPromiseWithCancellation(start, { signal: controller.signal }, Cancelled).catch(err => err);
		reject(failure);
		const outcome = await waiting;

		expect(outcome).toBe(failure);
	});
});
