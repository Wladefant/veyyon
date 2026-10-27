import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type Component, type RenderScheduler, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

/** Ctrl+C twice inside 500 ms exits. The first press arms that window and holds the next frame, as the app does. */
class BlockingDoubleInterruptComponent implements Component {
	interruptsHandled = 0;
	exitRequests = 0;
	#firstInterruptAt = 0;
	#blockNextRenderMs = 0;
	secondInterruptSeen = false;
	slowRenderBeforeSecond = false;

	constructor(private readonly armed: () => void) {}

	armSlowRender(blockMs: number): void {
		this.#blockNextRenderMs = blockMs;
	}

	handleInput(data: string): void {
		if (data !== "\x03") return;
		this.interruptsHandled++;
		if (this.interruptsHandled === 1) {
			this.#firstInterruptAt = Date.now();
			this.armed();
			return;
		}
		this.secondInterruptSeen = true;
		const now = Date.now();
		if (!this.slowRenderBeforeSecond && this.#firstInterruptAt !== 0 && now - this.#firstInterruptAt < 500) {
			this.exitRequests++;
		}
		this.#firstInterruptAt = 0;
	}

	render(_width: number): readonly string[] {
		const blockMs = this.#blockNextRenderMs;
		this.#blockNextRenderMs = 0;
		if (blockMs > 0) {
			if (!this.secondInterruptSeen) this.slowRenderBeforeSecond = true;
			setSystemTime(new Date(Date.now() + blockMs));
		}
		return ["ready"];
	}
}

/** Counts every press it receives, so a frame shows whether the press was painted. */
class PressProbe implements Component {
	#presses = 0;

	handleInput(_data: string): void {
		this.#presses++;
	}

	render(_width: number): readonly string[] {
		return [`presses:${this.#presses}`];
	}
}

async function drainNextTick(): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
}

function fakeTimerScheduler(): RenderScheduler {
	return {
		now: () => Date.now(),
		scheduleImmediate: callback => {
			process.nextTick(callback);
		},
		scheduleRender: (callback, delayMs) => {
			if (delayMs <= 0) {
				let cancelled = false;
				process.nextTick(() => {
					if (!cancelled) callback();
				});
				return {
					cancel: () => {
						cancelled = true;
					},
				};
			}
			const handle = setTimeout(callback, delayMs);
			return {
				cancel: () => clearTimeout(handle),
			};
		},
	};
}

describe("TUI input priority", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("handles a queued second Ctrl+C before a slow repaint can consume the double-interrupt window", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const component = new BlockingDoubleInterruptComponent(() => tui.holdFrameForInput());
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await drainNextTick();
		component.armSlowRender(650);
		vi.advanceTimersByTime(40);

		terminal.sendInput("\x03");
		setTimeout(() => terminal.sendInput("\x03"), 10);
		await drainNextTick();
		vi.advanceTimersByTime(0);
		vi.advanceTimersByTime(10);

		tui.stop();

		expect(component.slowRenderBeforeSecond).toBe(false);
		expect(component.interruptsHandled).toBe(2);
		expect(component.exitRequests).toBe(1);
	});

	// Esc and Ctrl+C included: the engine holds a frame only when a handler armed a double-press
	// window, so a press that arms nothing (closing a selector, interrupting a turn) paints at once.
	it.each([
		["navigation", "\x1b[B"],
		["Esc", "\x1b"],
		["Ctrl+C", "\x03"],
	])("paints a %s press that arms no gesture without an input-grace delay", async (_name, key) => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const component = new PressProbe();
		tui.addChild(component);
		tui.setFocus(component);

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);

			terminal.sendInput(key);
			await drainNextTick();
			await drainNextTick();

			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("presses:1");
		} finally {
			tui.stop();
		}
	});
});
