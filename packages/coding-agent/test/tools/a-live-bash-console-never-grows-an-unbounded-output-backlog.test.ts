import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { getBuiltinTheme } from "@veyyon/coding-agent/theme/builtin-themes";
import { createTheme } from "@veyyon/coding-agent/theme/theme";
import { BashInteractiveOverlayComponent } from "@veyyon/coding-agent/tools/shell/bash-interactive";
import type { Terminal } from "@xterm/headless";

/**
 * WHY:
 * `BashInteractiveOverlayComponent.appendOutput` hands every PTY chunk to xterm through an async
 * callback. While that callback is outstanding the chunk sits in `#writeQueue`, and nothing bounded
 * that array: a command printing faster than xterm decoded — `seq 1 1000000` in the console — held
 * one array entry per chunk for the whole tool timeout, growing without limit until the command
 * finished.
 *
 * The class now caps the *pending* backlog and discards its oldest entries, so the console shows the
 * newest output and a caught-up console is untouched.
 *
 * WHAT THIS DOES NOT CATCH: what the bash tool reports. `OutputSink`, not this queue, is the bounded
 * source of truth for the captured output, and it receives the chunk either way.
 *
 * Faking xterm here is the point, not a shortcut: the defect only exists while a write callback is
 * outstanding, so a deterministic backlog needs a terminal whose callbacks this suite releases.
 */
const CAP = 512;

interface Harness {
	ctor: typeof Terminal;
	/** Every chunk handed to the terminal, in the order it was written. */
	delivered: string[];
	/** Release the outstanding write callbacks until the queue is empty. Returns the release count. */
	releaseAll: () => number;
}

function createHarness(options: { sync?: boolean } = {}): Harness {
	const delivered: string[] = [];
	const pending: Array<() => void> = [];
	/** Stands in for xterm's Terminal: records each write and holds its callback until the test asks. */
	class HarnessTerminal {
		write(data: string, callback: () => void): void {
			delivered.push(data);
			if (options.sync) {
				// A console that keeps up: the callback lands before the next append.
				callback();
				return;
			}
			pending.push(callback);
		}
		dispose(): void {}
	}
	const releaseAll = (): number => {
		let released = 0;
		while (pending.length > 0) {
			if (released > 100_000) throw new Error("the live write queue never drained");
			pending.shift()!();
			released += 1;
		}
		return released;
	};
	return { ctor: HarnessTerminal as unknown as typeof Terminal, delivered, releaseAll };
}

function createComponent(harness: Harness): BashInteractiveOverlayComponent {
	const themeJson = getBuiltinTheme("dark");
	if (!themeJson) throw new Error("builtin dark theme unavailable");
	return new BashInteractiveOverlayComponent("seq 1 1000000", createTheme(themeJson), () => 40, harness.ctor);
}

describe("a live bash console never grows an unbounded output backlog", () => {
	it("discards the oldest pending output once the backlog passes the cap", async () => {
		const pushed = 5_000;
		const harness = createHarness();
		const component = createComponent(harness);

		for (let i = 0; i < pushed; i += 1) component.appendOutput(`chunk-${i}\n`);

		// One chunk is in flight; everything behind it waits on that callback.
		expect(harness.delivered).toEqual(["chunk-0\n"]);

		expect(harness.releaseAll()).toBeLessThanOrEqual(CAP + 1);

		// The console saw the in-flight chunk plus the newest window, so what it draws stays
		// current under a flood, and the dropped chunks are the old ones.
		expect(harness.delivered.length).toBe(CAP + 1);
		expect(harness.delivered[0]).toBe("chunk-0\n");
		expect(harness.delivered[1]).toBe(`chunk-${pushed - CAP}\n`);
		expect(harness.delivered.at(-1)).toBe(`chunk-${pushed - 1}\n`);
		expect(harness.delivered).not.toContain("chunk-1\n");

		// `runInteractiveBashPty` awaits this before it reports the run, so a queue that
		// never drained would hang the tool instead of finishing it.
		const flushed = await Promise.race([component.flushOutput().then(() => true), delay(2_000).then(() => false)]);
		expect(flushed).toBe(true);
	});

	it("delivers every chunk in order while the terminal keeps up", async () => {
		const pushed = 2_000;
		const harness = createHarness({ sync: true });
		const component = createComponent(harness);

		for (let i = 0; i < pushed; i += 1) component.appendOutput(`chunk-${i}\n`);

		expect(harness.delivered).toEqual(Array.from({ length: pushed }, (_, i) => `chunk-${i}\n`));
	});
});
