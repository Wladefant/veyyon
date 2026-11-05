/**
 * WHY: the loop's one-second clock runs while a run is in flight or the screen is
 * open, and has to be cleared as soon as neither holds. A clock left running
 * writes nothing once the row is gone and the screen is closed, so a suite that
 * watches the row or the screen passes with it leaked. What the leak does is keep
 * an idle session on the event loop for the rest of the process. These cases
 * count the pending timers instead, on fake timers.
 *
 * THE CLASS: each way the clock stops being wanted (the run ends, the loop is
 * cleared, the screen closes), each checked by the timer count and by the row or
 * the screen staying still for three more ticks.
 *
 * WHAT IT DOES NOT CATCH: whether the clock repaints on its own while it is
 * wanted, which only the real clock shows;
 * `a-running-loop-repaints-its-own-clock.test.ts` covers that half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createDashboardController } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { countingScreen, ctxWriting, runtimeRunning } from "./helpers/autoresearch-loop";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** Three ticks of a clock that should no longer be running. */
const THREE_TICKS_MS = 3_000;

describe("an idle loop keeps no clock on the event loop", () => {
	// The row paints through the process-wide theme, so a suite that renders it
	// has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	/** Timers pending before the case armed anything. */
	let idle: number;

	beforeEach(() => {
		vi.useFakeTimers();
		idle = vi.getTimerCount();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the clock when the run ends and keeps the row", () => {
		const rows: Array<string | undefined> = [];
		const ctx = ctxWriting(rows);
		const dashboard = createDashboardController();
		const runtime = runtimeRunning();
		dashboard.update(ctx, runtime);
		expect(vi.getTimerCount()).toBe(idle + 1);

		// The run is logged: the loop is still live and its row stays, but nothing on it moves.
		runtime.runningExperiment = null;
		dashboard.update(ctx, runtime);
		expect(vi.getTimerCount()).toBe(idle);
		const settled = rows.length;
		vi.advanceTimersByTime(THREE_TICKS_MS);
		expect(rows.length).toBe(settled);
		expect(rows.at(-1)).toBeDefined();
		dashboard.clear(ctx);
	});

	it("clears the clock and the row when the loop is cleared", () => {
		const rows: Array<string | undefined> = [];
		const ctx = ctxWriting(rows);
		const dashboard = createDashboardController();
		dashboard.update(ctx, runtimeRunning());
		expect(vi.getTimerCount()).toBe(idle + 1);

		dashboard.clear(ctx);
		expect(vi.getTimerCount()).toBe(idle);
		// A row that outlives its loop advertises a chord onto a session that is over.
		expect(rows.at(-1)).toBeUndefined();
		const cleared = rows.length;
		vi.advanceTimersByTime(THREE_TICKS_MS);
		expect(rows.length).toBe(cleared);
	});

	it("clears the clock when the screen closes", async () => {
		const screen = countingScreen();
		const dashboard = createDashboardController(screen.delegate);
		const shown = dashboard.showScreen(ctxWriting([]), createSessionRuntime(), null);
		expect(vi.getTimerCount()).toBe(idle + 1);

		screen.close();
		await shown;
		expect(vi.getTimerCount()).toBe(idle);
		const rendered = screen.renders();
		vi.advanceTimersByTime(THREE_TICKS_MS);
		expect(screen.renders()).toBe(rendered);
	});
});
