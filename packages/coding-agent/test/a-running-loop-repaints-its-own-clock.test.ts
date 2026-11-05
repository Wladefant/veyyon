/**
 * WHY: the status row states the elapsed time of the run in flight, and the only
 * thing that repainted it was the extension calling `update` on a state
 * transition. A benchmark between two transitions is exactly the minute a reader
 * is watching the row, so the clock sat frozen at the elapsed time the run had
 * when it started, and a long run looked hung.
 *
 * The class is a surface that states a live value and has no clock of its own.
 * Closed here at the controller, which is the only owner of that clock: the row
 * advances while a run is in flight, and the screen repaints while it is open,
 * with nobody calling either.
 *
 * These cases run on the real clock rather than a fake one, because the contract
 * is that the row repaints without anybody asking, and a fake timer proves only
 * that a callback was registered.
 *
 * What it does not catch: the row's content (the command suite owns that), and
 * the clock standing down once nothing needs it, which writes nothing a row can
 * show; `an-idle-loop-keeps-no-clock-on-the-event-loop.test.ts` counts the timers
 * for that half.
 */
import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createDashboardController } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { stripAnsi } from "@veyyon/utils";
import { countingScreen, ctxWriting, runtimeRunning } from "./helpers/autoresearch-loop";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** One tick of the controller's clock, plus the slack a loaded runner needs. */
const ONE_TICK_MS = 1_300;

describe("a running loop repaints its own clock", () => {
	// The row paints through the process-wide theme, so a suite that renders it
	// has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	// Each case owns its controller, its timer and its rows, so the cases that wait out a real tick
	// wait concurrently and the file costs one tick rather than one per case.
	it.concurrent("advances the elapsed time without another state transition", async () => {
		const rows: Array<string | undefined> = [];
		const dashboard = createDashboardController();
		const runtime = runtimeRunning();

		dashboard.update(ctxWriting(rows), runtime);
		const first = rows.at(-1);
		expect(stripAnsi(first ?? "")).toContain("run #1");
		await sleep(ONE_TICK_MS);

		expect(rows.length).toBeGreaterThanOrEqual(2);
		// Five seconds in when the row was first written, six or more by now: the
		// repaint came from the controller, not from a caller.
		expect(rows.at(-1)).not.toBe(first);
		dashboard.clear(ctxWriting(rows));
	});

	it.concurrent("ticks the screen's render callback while the screen is open", async () => {
		const screen = countingScreen();
		const dashboard = createDashboardController(screen.delegate);

		const shown = dashboard.showScreen(ctxWriting([]), createSessionRuntime(), null);
		await sleep(ONE_TICK_MS);

		expect(screen.renders()).toBeGreaterThanOrEqual(1);
		screen.close();
		await shown;
	});

	it("delegates dashboard.requestRender() to the mounted screen handle without recursion", async () => {
		const screen = countingScreen();
		const dashboard = createDashboardController(screen.delegate);

		const shown = dashboard.showScreen(ctxWriting([]), createSessionRuntime(), null);
		dashboard.requestRender();
		expect(screen.renders()).toBe(1);

		dashboard.requestRender();
		expect(screen.renders()).toBe(2);

		screen.close();
		await shown;

		dashboard.requestRender();
		expect(screen.renders()).toBe(2);
	});
});
