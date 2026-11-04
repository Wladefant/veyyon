import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { getBuiltinTheme } from "@veyyon/coding-agent/theme/builtin-themes";
import { createTheme } from "@veyyon/coding-agent/theme/theme";
import { BashInteractiveOverlayComponent } from "@veyyon/coding-agent/tools/shell/bash-interactive";
import xterm, { type Terminal } from "@xterm/headless";

/**
 * WHY:
 * `BashInteractiveOverlayComponent.appendOutput` hands every PTY chunk to xterm through an async
 * callback. While that callback is outstanding the chunk sits in `#writeQueue`, and nothing bounded
 * that array: a command printing faster than xterm decoded — `seq 1 1000000` in the console — held
 * one array entry per chunk for the whole tool timeout, growing without limit until the command
 * finished.
 *
 * The class now caps the *pending* backlog and discards its oldest entries, so the console shows the
 * newest output and a caught-up console is untouched. It also releases the chunks xterm already
 * consumed on every append: the queue only resets on a full drain, so a producer that keeps a backlog
 * alive while xterm drains it (the interleaved case) used to keep one entry per completed write. And
 * because a dropped chunk can carry the terminator of an OSC or DCS string, the first chunk after a
 * gap starts with a string terminator, or the console would swallow everything that follows.
 *
 * WHAT THIS DOES NOT CATCH: what the bash tool reports. `OutputSink`, not this queue, is the bounded
 * source of truth for the captured output, and it receives the chunk either way.
 *
 * Faking xterm here is the point, not a shortcut: the defect only exists while a write callback is
 * outstanding, so a deterministic backlog needs a terminal whose callbacks this suite releases. The
 * resync case uses the real headless xterm, because what it defends is what xterm's parser draws.
 */
const CAP = 512;
const ST = "\u001b\\";
const MB = 1024 * 1024;

interface Harness {
	ctor: typeof Terminal;
	/** Every chunk handed to the terminal, in the order it was written (empty when `retain` is off). */
	delivered: string[];
	/** Release the outstanding write callbacks until the queue is empty. Returns the release count. */
	releaseAll: () => number;
	/** Release the oldest outstanding write callback, if any. */
	releaseOne: () => void;
}

function createHarness(options: { sync?: boolean; retain?: boolean } = {}): Harness {
	const delivered: string[] = [];
	const pending: Array<() => void> = [];
	/** Stands in for xterm's Terminal: records each write and holds its callback until the test asks. */
	class HarnessTerminal {
		write(data: string, callback: () => void): void {
			if (options.retain !== false) delivered.push(data);
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
	const releaseOne = (): void => {
		pending.shift()?.();
	};
	return { ctor: HarnessTerminal as unknown as typeof Terminal, delivered, releaseAll, releaseOne };
}

function createComponent(harness: Pick<Harness, "ctor">): BashInteractiveOverlayComponent {
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
		// The first chunk after the gap opens with a string terminator (see the resync case below).
		expect(harness.delivered[1]).toBe(`${ST}chunk-${pushed - CAP}\n`);
		expect(harness.delivered.at(-1)).toBe(`chunk-${pushed - 1}\n`);
		expect(harness.delivered).not.toContain("chunk-1\n");

		// `runInteractiveBashPty` awaits this before it reports the run, so a queue that
		// never drained would hang the tool instead of finishing it.
		const flushed = await Promise.race([component.flushOutput().then(() => true), delay(2_000).then(() => false)]);
		expect(flushed).toBe(true);
	});

	it("releases the chunks xterm consumed while a producer keeps the backlog alive", async () => {
		const appends = 20_000;
		const chunkBytes = 4096;
		// `retain: false`: a harness that kept each delivered chunk would pin it itself.
		const harness = createHarness({ retain: false });
		const component = createComponent(harness);

		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < appends; i += 1) {
			// A distinct flat string per chunk, so the heap holds each one it retains.
			component.appendOutput(Buffer.alloc(chunkBytes, 97 + (i % 26)).toString("latin1"));
			// xterm finishes one write for every two appends: it drains, but never catches up.
			if (i % 2 === 1) harness.releaseOne();
		}
		Bun.gc(true);
		const retainedMB = (process.memoryUsage().heapUsed - before) / MB;

		// 10,000 completed writes of 4 KiB each is about 40 MiB when the consumed prefix stays in
		// the queue; the pending window is CAP chunks, about 2 MiB.
		expect(retainedMB).toBeLessThan(12);

		// Measured while the component is alive, so the bound is the queue's, not a collected one.
		expect(harness.releaseAll()).toBeLessThanOrEqual(CAP + 1);
		const flushed = await Promise.race([component.flushOutput().then(() => true), delay(2_000).then(() => false)]);
		expect(flushed).toBe(true);
	});

	it("does not let a dropped string terminator swallow the output after the gap", async () => {
		const component = createComponent({ ctor: xterm.Terminal });

		// The in-flight chunk opens a window-title OSC; its BEL terminator is in the next chunk,
		// which the flood behind it pushes out of the window.
		component.appendOutput("\u001b]0;title");
		component.appendOutput("\u0007");
		const lines = 2_000;
		for (let i = 0; i < lines; i += 1) component.appendOutput(`line-${i}\r\n`);

		const flushed = await Promise.race([component.flushOutput().then(() => true), delay(10_000).then(() => false)]);
		expect(flushed).toBe(true);

		const screen = Bun.stripANSI(component.render(120).join("\n"));
		expect(screen).toContain(`line-${lines - 1}`);
		component.dispose();
	});

	it("delivers every chunk in order while the terminal keeps up", async () => {
		const pushed = 2_000;
		const harness = createHarness({ sync: true });
		const component = createComponent(harness);

		for (let i = 0; i < pushed; i += 1) component.appendOutput(`chunk-${i}\n`);

		expect(harness.delivered).toEqual(Array.from({ length: pushed }, (_, i) => `chunk-${i}\n`));
	});
});
