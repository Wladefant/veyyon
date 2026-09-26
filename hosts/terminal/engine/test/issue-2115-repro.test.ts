import "./warm-natives"; // load the native addon under the real platform before any process.platform mock
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2115
//
// Large CJK session resumes on Windows legacy console hosts used to feed the
// terminal a full synchronized paint for the entire transcript. ProcessTerminal
// split that payload into ConPTY-sized writes, but the renderer still built a
// multi-megabyte paint and asked the Windows host to process every historical
// row in one DEC 2026 frame. Legacy conhost/ConPTY byte parsing could park the
// viewport mid-conversation, and even ASCII sessions became sluggish once the
// replay crossed ~1-2 MiB.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class LargeCjkContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) this.appendLine();
	}

	appendLine(): void {
		const i = this.#lines.length;
		this.#lines.push(`第${i.toString().padStart(5, "0")}行：${"界".repeat(80)}`);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) {
			rendered[i] = this.#lines[i]!.slice(0, width);
		}
		return rendered;
	}
}

class ManualRenderScheduler implements RenderScheduler {
	#now = 0;
	#immediate: (() => void)[] = [];
	#timers: { at: number; callback: () => void; canceled: boolean }[] = [];

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { at: this.#now + Math.max(0, delayMs), callback, canceled: false };
		this.#timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}

	async flush(term: VirtualTerminal): Promise<void> {
		while (this.#immediate.length > 0) {
			const callbacks = this.#immediate.splice(0);
			for (const callback of callbacks) callback();
		}
		await term.flush();
	}

	async advanceBy(ms: number, term: VirtualTerminal): Promise<void> {
		await this.flush(term);
		this.#now += ms;
		while (true) {
			const due = this.#timers.filter(timer => !timer.canceled && timer.at <= this.#now);
			if (due.length === 0) break;
			for (const timer of due) {
				timer.canceled = true;
				timer.callback();
			}
			await this.flush(term);
		}
		await this.flush(term);
	}
}

// Multiplexer detection also falls back to the TERM prefix, so TERM is pinned:
// a suite running inside tmux would otherwise classify a direct-host case as a
// pane and change which render path it takes. Every key is restored after the
// case, so the process environment is never left patched.
const HOST_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_SOCKET_PATH",
	"TERM",
	"TERM_PROGRAM",
	"VEYYON_TUI_RESIZE_IN_PLACE",
] as const;
const DIRECT_HOST_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	CMUX_SOCKET_PATH: undefined,
	TERM: "xterm-256color",
	TERM_PROGRAM: undefined,
	VEYYON_TUI_RESIZE_IN_PLACE: undefined,
};
const MULTIPLEXER_ENV: Record<string, string | undefined> = { ...DIRECT_HOST_ENV, TMUX: "1" };

async function withEnv<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key of HOST_ENV_KEYS) saved[key] = process.env[key];
	try {
		for (const key of HOST_ENV_KEYS) {
			const value = patch[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await run();
	} finally {
		for (const key of HOST_ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("issue #2115: ConPTY large-session resume truncates at logical lines", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		vi.restoreAllMocks();
	});

	it("bounds a Windows CJK resume paint while preserving the visible tail", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 12_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeCjkContent(9000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const fullPaint = writes.find(write => write.includes("\x1b[3J"));
			expect(fullPaint).toBeDefined();
			expect(fullPaint).not.toContain("\x1b[2J");
			expect(Buffer.byteLength(fullPaint ?? "", "utf8")).toBeLessThan(128 * 1024);
			expect(fullPaint).toContain("older lines hidden");
			expect(fullPaint).not.toContain("第00000行");

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[viewport.length - 1]).toContain("第08999行");
			expect(term.getScrollBuffer().some(line => line.includes("older lines hidden"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps later tail appends on the cheap append path", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 12_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const content = new LargeCjkContent(9000);
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(content);

		try {
			tui.start({ clearScrollback: true });
			await scheduler.advanceBy(40, term);
			writes.length = 0;

			content.appendLine();
			tui.requestRender();
			await scheduler.advanceBy(200, term);

			const postAppend = writes.join("");
			expect(Buffer.byteLength(postAppend, "utf8")).toBeLessThan(2048);
			expect(postAppend).not.toContain("\x1b[H");
			expect(postAppend).toContain("第09000行");
		} finally {
			tui.stop();
		}
	});

	// The bound keys on paint intent, not on the host alone: bounding every full
	// paint also bounded the user's own redraw. Ctrl+O expand, a thinking or
	// setting toggle and a display reset all enter through `resetDisplay()`,
	// which replays the current transcript on purpose, and the bound replaced
	// every row above the retained tail with the hidden-lines marker — expanding
	// a long session silently threw the session away.
	it("replays the whole transcript on a user-driven reset and still bounds the replacement after it", async () => {
		await withEnv(DIRECT_HOST_ENV, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const term = new VirtualTerminal(80, 24, 20_000);
			const writes: string[] = [];
			const realWrite = term.write.bind(term);
			vi.spyOn(term, "write").mockImplementation((data: string) => {
				writes.push(data);
				realWrite(data);
			});
			const tui = new TUI(term);
			tui.addChild(new LargeCjkContent(9000));

			try {
				tui.start({ clearScrollback: true });
				await term.waitForRender();

				// The premise: this host really does bound a bulk replay, so the
				// assertions below cannot pass merely because ConPTY was not modelled.
				expect(writes.find(write => write.includes("\x1b[3J"))).toContain("older lines hidden");

				writes.length = 0;
				tui.resetDisplay();

				const redraw = writes.join("");
				expect(redraw).not.toContain("older lines hidden");
				expect(redraw).toContain("第00000行");
				expect(redraw).toContain("第08999行");

				// The opt-out is one-shot: the replacement that follows is bounded again.
				writes.length = 0;
				tui.requestRender(true, { clearScrollback: true });
				await term.waitForRender();

				const replace = writes.join("");
				expect(replace).toContain("older lines hidden");
				expect(Buffer.byteLength(replace, "utf8")).toBeLessThan(128 * 1024);
			} finally {
				tui.stop();
			}
		});
	});

	// The opt-out is consumed by the next authoritative render, whichever kind it
	// is. A multiplexer turns the reset into an in-place update rather than a full
	// paint, and an opt-out that outlived that update would be inherited by the
	// next /resume or handoff and replay its multi-megabyte transcript unbounded —
	// the stall this suite exists for.
	it("consumes the opt-out on an in-place update so it cannot leak into a later replacement", async () => {
		await withEnv(MULTIPLEXER_ENV, async () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const term = new VirtualTerminal(80, 24, 20_000);
			const scheduler = new ManualRenderScheduler();
			const writes: string[] = [];
			const realWrite = term.write.bind(term);
			vi.spyOn(term, "write").mockImplementation((data: string) => {
				writes.push(data);
				realWrite(data);
			});
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(new LargeCjkContent(9000));

			try {
				tui.start({ clearScrollback: true });
				await scheduler.advanceBy(200, term);
				writes.length = 0;

				// A full paint here would make the assertion below pass for the wrong
				// reason, so pin the update: the tail is repainted and the screen is
				// never cleared.
				tui.resetDisplay();
				await scheduler.flush(term);

				const reset = writes.join("");
				expect(reset).toContain("第08999行");
				expect(reset).not.toContain("\x1b[2J");

				writes.length = 0;
				tui.requestRender(true, { clearScrollback: true });
				await scheduler.advanceBy(200, term);

				const replace = writes.join("");
				expect(replace).toContain("older lines hidden");
				expect(Buffer.byteLength(replace, "utf8")).toBeLessThan(128 * 1024);
			} finally {
				tui.stop();
			}
		});
	});
});
