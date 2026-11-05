import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type Component, type RenderScheduler, TUI } from "@veyyon/tui";
import { isKittyProtocolActive, setKittyProtocolActive } from "@veyyon/utils/keys";
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

/** Draws whatever the test last set, so a frame shows whether it painted after the change. */
class TextProbe implements Component {
	text = "before";

	handleInput(_data: string): void {}

	render(_width: number): readonly string[] {
		return [this.text];
	}
}

/**
 * Answers a press in more than one frame: one at once, then one per entry in `answerAfterMs`, as a
 * dashboard that reads its rows from disk after the key does.
 */
class AwaitedAnswerProbe implements Component {
	#presses = 0;
	#answers = 0;

	constructor(
		private readonly requestRender: () => void,
		private readonly answerAfterMs: readonly number[],
	) {}

	handleInput(_data: string): void {
		this.#presses++;
		for (const ms of this.answerAfterMs) {
			setTimeout(() => {
				this.#answers++;
				this.requestRender();
			}, ms);
		}
	}

	render(_width: number): readonly string[] {
		return [`presses:${this.#presses} answers:${this.#answers}`];
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

	/** Start a TUI over `component`, idle long enough that the cadence holds nothing back. */
	async function startIdle(component: Component): Promise<{ terminal: VirtualTerminal; tui: TUI }> {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(60, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await drainNextTick();
		vi.advanceTimersByTime(40);
		return { terminal, tui };
	}

	/** Paint whatever is due now, then move the clock `ms` and paint whatever that made due. */
	async function advance(ms: number): Promise<void> {
		await paintDue();
		// Bun's fake clock moves 1 ms on `advanceTimersByTime(0)`, so a zero step leaves it alone.
		if (ms > 0) vi.advanceTimersByTime(ms);
		await paintDue();
	}

	/** A due frame paints on a tick: the request schedules on one, the zero-delay render on the next. */
	async function paintDue(): Promise<void> {
		await drainNextTick();
		await drainNextTick();
		await drainNextTick();
	}

	function screen(terminal: VirtualTerminal): string {
		return terminal
			.getViewport()
			.map(row => row.trimEnd())
			.join("\n");
	}

	// The cadence caps frames at 30 fps from the previous frame's start. A press answered after an
	// await (a dashboard reading its rows) requested its second frame 2 ms after the first and waited
	// out the other 31 ms with nothing else painting.
	it("paints the answer a press awaited without waiting out the frame cadence", async () => {
		let tui: TUI | undefined;
		const probe = new AwaitedAnswerProbe(() => tui?.requestRender(), [2]);
		const started = await startIdle(probe);
		tui = started.tui;
		try {
			started.terminal.sendInput("x");
			await advance(0);
			expect(screen(started.terminal)).toContain("presses:1 answers:0");
			await advance(2);
			expect(screen(started.terminal)).toContain("presses:1 answers:1");
		} finally {
			started.tui.stop();
		}
	});

	it("lets a press skip the cadence for two frames and no more", async () => {
		let tui: TUI | undefined;
		const probe = new AwaitedAnswerProbe(() => tui?.requestRender(), [2, 4]);
		const started = await startIdle(probe);
		tui = started.tui;
		try {
			started.terminal.sendInput("x");
			await advance(2);
			expect(screen(started.terminal)).toContain("presses:1 answers:1");
			// The third frame keeps the cadence from the second frame's start, 2 ms after the press.
			await advance(2);
			expect(screen(started.terminal)).toContain("presses:1 answers:1");
			await advance(29);
			expect(screen(started.terminal)).toContain("presses:1 answers:1");
			await advance(3);
			expect(screen(started.terminal)).toContain("presses:1 answers:2");
		} finally {
			started.tui.stop();
		}
	});

	it("keeps the cadence for the frames a pointer report asks for", async () => {
		let tui: TUI | undefined;
		const probe = new AwaitedAnswerProbe(() => tui?.requestRender(), [2]);
		const started = await startIdle(probe);
		tui = started.tui;
		try {
			started.terminal.sendInput("\x1b[<35;5;5M");
			await advance(3);
			expect(screen(started.terminal)).toContain("presses:1 answers:0");
			await advance(31);
			expect(screen(started.terminal)).toContain("presses:1 answers:1");
		} finally {
			started.tui.stop();
		}
	});

	it("paints a press at once while another frame waits out the cadence", async () => {
		const probe = new PressProbe();
		const { terminal, tui } = await startIdle(probe);
		try {
			// A stream painting at the cadence: one frame now, the next waiting out the interval.
			tui.requestRender();
			await advance(0);
			await advance(1);
			tui.requestRender();
			await advance(1);

			terminal.sendInput("x");
			await advance(0);
			expect(screen(terminal)).toContain("presses:1");
		} finally {
			tui.stop();
		}
	});

	// Wheel and hover arrive at a rate the cadence exists to cap, and a release answers nothing.
	it.each([
		["pointer report", "\x1b[<35;5;5M"],
		["key release", "\x1b[97;1:3u"],
	])("leaves a frame waiting out the cadence to it on a %s", async (_name, input) => {
		const kittyBefore = isKittyProtocolActive();
		const probe = new TextProbe();
		const { terminal, tui } = await startIdle(probe);
		setKittyProtocolActive(true);
		try {
			tui.requestRender();
			await advance(0);
			await advance(1);
			probe.text = "after";
			tui.requestRender();
			await advance(1);

			terminal.sendInput(input);
			await advance(0);
			expect(screen(terminal)).toContain("before");
			await advance(32);
			expect(screen(terminal)).toContain("after");
		} finally {
			tui.stop();
			setKittyProtocolActive(kittyBefore);
		}
	});

	it("holds a waiting frame for a press that arms a double-press window", async () => {
		let tui: TUI | undefined;
		const component = new BlockingDoubleInterruptComponent(() => tui?.holdFrameForInput());
		const started = await startIdle(component);
		tui = started.tui;
		try {
			tui.requestRender();
			await advance(0);
			await advance(1);
			// A frame waiting out the cadence when the first press arrives.
			tui.requestRender();
			await drainNextTick();
			component.armSlowRender(650);

			started.terminal.sendInput("\x03");
			setTimeout(() => started.terminal.sendInput("\x03"), 10);
			await advance(0);
			await advance(10);

			expect(component.slowRenderBeforeSecond).toBe(false);
			expect(component.exitRequests).toBe(1);
		} finally {
			started.tui.stop();
		}
	});
});
