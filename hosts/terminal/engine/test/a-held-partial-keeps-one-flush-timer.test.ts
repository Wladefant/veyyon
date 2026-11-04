/**
 * A partial escape the buffer is holding is timed by one flush timer, whatever order chunks and
 * timer passes arrive in.
 *
 * WHY THIS SUITE EXISTS. A fresh escape arriving during the zero-delay deferral of an expired
 * partial the buffer holds (SGR mouse prefix, or any partial under the kitty protocol) ran the
 * expiry inline. The expiry held the stale partial and re-armed without clearing the pending
 * deferral, then `process` appended the fresh escape to the stale head and armed a third timer over
 * the second. The merged buffer matched neither the hold rule nor the parser, and the overwritten
 * handles kept firing, so the sequence was delivered as single typed characters before its tail
 * arrived.
 *
 * The class closed: a fresh escape after an expiry delivers the stale head on its own, clears every
 * pending flush timer, and starts the fresh partial's hold window at its own arrival. The gap left:
 * this pins the timer count, the delivery of a held sequence and the hold window's start; it does
 * not prove the hold window itself is the right length.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { StdinBuffer } from "@veyyon/tui/stdin-buffer";

const TIMEOUT_MS = 10;
const HOLD_MS = 1_000;

/** An SGR mouse report with its tail missing: no keyboard sequence starts this way, so it is held. */
const SGR_MOUSE_HEAD = "\x1b[<35;10";

function bufferWithEvents(): { buffer: StdinBuffer; data: string[] } {
	const buffer = new StdinBuffer({ timeout: TIMEOUT_MS, partialHoldTimeout: HOLD_MS });
	const data: string[] = [];
	buffer.on("data", sequence => data.push(sequence));
	return { buffer, data };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a held partial escape", () => {
	it("keeps one flush timer when a fresh escape lands during the deferred expiry", () => {
		vi.useFakeTimers();
		const { buffer } = bufferWithEvents();

		buffer.process(SGR_MOUSE_HEAD);
		// The incomplete-sequence timer fires and leaves only its zero-delay deferral pending.
		vi.runOnlyPendingTimers();
		buffer.process("\x1b[<35;20");

		expect(vi.getTimerCount()).toBe(1);
		buffer.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("delivers the stale head alone and holds the fresh partial until its tail arrives", () => {
		vi.useFakeTimers();
		const { buffer, data } = bufferWithEvents();

		buffer.process(SGR_MOUSE_HEAD);
		vi.runOnlyPendingTimers();
		buffer.process("\x1b[<35;20");
		for (let pass = 0; pass < 20; pass++) vi.runOnlyPendingTimers();
		buffer.process(";5M");

		expect(data).toEqual([SGR_MOUSE_HEAD, "\x1b[<35;20;5M"]);
		buffer.destroy();
	});

	it("measures the fresh partial's hold window from its own arrival, not the stale head's", () => {
		vi.useFakeTimers();
		const { buffer, data } = bufferWithEvents();

		buffer.process(SGR_MOUSE_HEAD);
		// Each pass pair is one timeout and its deferral: TIMEOUT_MS of hold. Stop with the
		// deferral pending, most of the stale head's hold window spent.
		vi.runOnlyPendingTimers();
		for (let pass = 0; pass < 90; pass++) {
			vi.runOnlyPendingTimers();
			vi.runOnlyPendingTimers();
		}
		buffer.process("\x1b[<35;20");
		// Past the end of the stale head's window, well inside the fresh partial's.
		for (let pass = 0; pass < 60; pass++) vi.runOnlyPendingTimers();
		buffer.process(";5M");

		expect(data).toEqual([SGR_MOUSE_HEAD, "\x1b[<35;20;5M"]);
		buffer.destroy();
	});

	it("leaves no timer behind once the held sequence completes", () => {
		vi.useFakeTimers();
		const { buffer, data } = bufferWithEvents();

		buffer.process(SGR_MOUSE_HEAD);
		vi.runOnlyPendingTimers();
		buffer.process("\x1b[<35;20");
		vi.runOnlyPendingTimers();
		buffer.process(";5M");

		expect(data.at(-1)?.endsWith(";5M")).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
