import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "../src";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// A fullscreen overlay paints on the alternate screen. Every keystroke in one
// (settings search, a picker, a plan-review annotation, an extension's
// fullscreen view) changes a row or two; the paint must rewrite those rows,
// not the whole terminal.

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string {
		const out = this.writes.join("");
		this.writes.length = 0;
		return out;
	}
}

class Rows implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

function screen(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/** 1-based screen rows a paint addressed with an absolute row move. */
function rewrittenRows(frame: string): number[] {
	return [...frame.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]));
}

async function openFullscreen(lines: string[], rows = lines.length) {
	const terminal = new RecordingTerminal(30, rows);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.start();
	await scheduler.drain(terminal);
	const overlay = new Rows(lines);
	tui.showOverlay(overlay, { fullscreen: true, width: "100%", maxHeight: "100%" });
	await scheduler.drain(terminal);
	terminal.takeWrites();
	return { terminal, scheduler, tui, overlay };
}

describe("fullscreen overlay paints", () => {
	it("rewrites only the rows that changed, and leaves no stale cells behind", async () => {
		const lines = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
		const { terminal, scheduler, tui, overlay } = await openFullscreen(lines);

		overlay.lines = ["alpha", "bravo", "CHARLIE CHANGED", "delta", "echo", "foxtrot"];
		tui.requestRender();
		await scheduler.drain(terminal);
		const grown = terminal.takeWrites();
		expect(rewrittenRows(grown)).toEqual([3]);
		for (const unchanged of ["alpha", "bravo", "delta", "echo", "foxtrot"]) expect(grown).not.toContain(unchanged);
		expect(screen(terminal)).toEqual(overlay.lines);

		// A shorter replacement must clear the rest of the old text.
		overlay.lines = ["alpha", "bravo", "c", "delta", "echo", "foxtrot"];
		tui.requestRender();
		await scheduler.drain(terminal);
		expect(rewrittenRows(terminal.takeWrites())).toEqual([3]);
		expect(screen(terminal)).toEqual(overlay.lines);
		tui.stop();
	});

	it("still rewrites every row on a forced repaint", async () => {
		const lines = ["alpha", "bravo", "charlie", "delta"];
		const { terminal, scheduler, tui } = await openFullscreen(lines);

		tui.requestRender(true);
		await scheduler.drain(terminal);
		const frame = terminal.takeWrites();
		for (const row of lines) expect(frame).toContain(row);
		expect(screen(terminal)).toEqual(lines);
		tui.stop();
	});
});
