import { afterEach, describe, expect, it, vi } from "bun:test";
import { ExponentialYield, YieldGate } from "@veyyon/agent-core/utils/yield";

const YIELD_INTERVAL_MS = 50;

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Build a gate over an injected clock and a counting yield so the test drives
 * the gate logic without spying on process-global `Date.now`. That global is
 * shared across files, so under concurrent `bun test` a sibling file's
 * `vi.restoreAllMocks()` could wipe a spy mid-run — the exact race that made
 * the previous singleton-based test flake.
 */
function makeGate(): { gate: YieldGate; advanceBy: (ms: number) => void; yields: () => number } {
	let now = 1_000_000;
	const yieldTurn = vi.fn(async () => {});
	const gate = new YieldGate({ now: () => now, yieldTurn });
	return {
		gate,
		advanceBy: (ms: number) => {
			now += ms;
		},
		yields: () => yieldTurn.mock.calls.length,
	};
}

describe("YieldGate.yieldIfDue", () => {
	it("yields on the first call and gates immediate callers", async () => {
		const { gate, advanceBy, yields } = makeGate();

		await gate.yieldIfDue();
		expect(yields()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(yields()).toBe(1);
	});

	it("yields again once the gate window elapses", async () => {
		const { gate, advanceBy, yields } = makeGate();

		await gate.yieldIfDue();
		expect(yields()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS);
		await gate.yieldIfDue();
		expect(yields()).toBe(2);
	});

	it("treats a backward clock jump as due instead of gating forever", async () => {
		const { gate, advanceBy, yields } = makeGate();

		await gate.yieldIfDue();
		expect(yields()).toBe(1);

		// NTP correction / fake timers can move the wall clock backward; the next
		// call must still yield rather than wait for an interval that never comes.
		advanceBy(-YIELD_INTERVAL_MS * 4);
		await gate.yieldIfDue();
		expect(yields()).toBe(2);
	});

	// The agent loop yields on every streamed event, after every tool batch and at the top of every
	// turn, so a due yield that sleeps adds its sleep to every tool round and to every response's
	// first token. Twenty due yields cost twenty event-loop turns: a sleep of even 1 ms per yield
	// takes them past the bound.
	it("hands the event loop a turn rather than sleeping", async () => {
		let now = 0;
		const gate = new YieldGate({ now: () => now });
		const started = performance.now();
		for (let i = 0; i < 20; i++) {
			now += YIELD_INTERVAL_MS;
			await gate.yieldIfDue();
		}
		expect(performance.now() - started).toBeLessThan(20);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value as soon as it settles", async () => {
		const ey = new ExponentialYield({ minMs: 5_000, maxMs: 10_000 });
		const racer = Bun.sleep(10).then(() => "done");
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe("done");
		// The 5s yield must not have delayed us: settle within a comfy margin.
		expect(elapsed).toBeLessThan(500);
	});

	it("cancels the losing sleep so it does not keep the loop alive", async () => {
		// If the losing Bun.sleep weren't cancelled, this test would block for
		// the full minMs after the racer wins, since the prior implementation
		// kept fresh timers ticking. We pick a minMs far larger than the racer
		// delay and assert we return well before it.
		const ey = new ExponentialYield({ minMs: 2_000, maxMs: 2_000 });
		const racer = Bun.sleep(20).then(() => 42);
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe(42);
		expect(elapsed).toBeLessThan(500);

		// After race resolves, ensure the AbortController-driven cancel really
		// unblocked the underlying timer: a short follow-up sleep should not
		// be perturbed by residual pending timers. (Sanity: this returns.)
		await Bun.sleep(30);
	});
});
