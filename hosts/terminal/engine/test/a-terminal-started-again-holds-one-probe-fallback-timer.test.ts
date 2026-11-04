/**
 * A terminal started again while running holds one keyboard-probe fallback timer, so nothing it
 * armed outlives `stop()`.
 *
 * WHY THIS SUITE EXISTS. `start()` over a running terminal replaces its stdin reader, and the
 * keyboard probe it sends arms a 150ms modifyOtherKeys fallback. The probe assigned the new timer
 * over the pending one, so the first stayed armed and unreachable: `stop()` cleared only the second,
 * and the first fired after teardown, wrote `CSI > 4 ; 2 m` to the restored terminal and left it
 * reporting modified keys to the shell.
 *
 * The class closed: arming the probe fallback replaces a pending one. The gap left: this pins the
 * fallback timer only; other probes a restart sends are covered by their own suites.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
/** Past the 150ms window the keyboard probe waits for a reply before falling back. */
const PAST_PROBE_WINDOW_MS = 200;

function enableCount(writes: readonly string[]): number {
	return writes.join("").split(MODIFY_OTHER_KEYS_ON).length - 1;
}

describe("a terminal started again while running", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.useRealTimers();
	});

	it("falls back to modifyOtherKeys once when no keyboard reply arrives", () => {
		vi.useFakeTimers();
		harness = createProcessTerminalRenderHarness(100, 30);
		harness.terminal.start(
			() => {},
			() => {},
		);
		harness.writes.length = 0;

		vi.advanceTimersByTime(PAST_PROBE_WINDOW_MS);

		expect(enableCount(harness.writes)).toBe(1);
	});

	it("enables no keyboard mode after stop()", () => {
		vi.useFakeTimers();
		harness = createProcessTerminalRenderHarness(100, 30);
		harness.terminal.start(
			() => {},
			() => {},
		);
		harness.terminal.stop();
		harness.writes.length = 0;

		vi.advanceTimersByTime(PAST_PROBE_WINDOW_MS);

		expect(enableCount(harness.writes)).toBe(0);
	});
});
