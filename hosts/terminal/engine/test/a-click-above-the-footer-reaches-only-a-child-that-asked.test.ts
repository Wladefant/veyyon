/**
 * WHY THIS SUITE EXISTS.
 *
 * While the engine holds the mouse (scroll isolation), every report above the
 * pinned footer used to be swallowed, so nothing in the transcript region could
 * own a click: the anchored Agents block listed live agents that a click could
 * not reach. The engine now routes a left click above the footer to the root
 * child drawn on that row, and only to one that declares click targets
 * (`wantsPointer() === true`).
 *
 * The class it closes is the mapping, not one component: a click lands on the
 * child and the local line actually drawn under the pointer, at the top of the
 * frame and with the frame scrolled past the viewport (where screen row and
 * frame row differ by the window top). The opt-in is held from both sides: a
 * child with a route and no declared targets stays deaf, and a frozen scroll
 * view, whose rows are scroll-space rows, routes nothing.
 *
 * What it does NOT catch: whether a host component answers `wantsPointer()` at
 * the right times, or what it does with the click. The Agents block's own
 * contract is pinned in
 * packages/coding-agent/test/a-click-on-an-agent-hud-row-focuses-that-agent.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 12;

class Rows implements Component {
	constructor(public rows: string[]) {}
	invalidate(): void {}
	render(): readonly string[] {
		return this.rows;
	}
}

/** A transcript-region child with click targets, or with a route and none. */
class Target extends Rows implements MouseRoutable {
	clicks: Array<{ line: number; col: number }> = [];
	constructor(
		rows: string[],
		readonly wants: boolean,
	) {
		super(rows);
	}
	wantsPointer(): boolean {
		return this.wants;
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (event.leftClick) this.clicks.push({ line, col });
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

/** Footer chip row that keeps the mouse grabbed in a frame that fits. */
class Chip extends Rows implements MouseRoutable {
	constructor() {
		super(["  chip"]);
	}
	wantsPointer(): boolean {
		return true;
	}
	routeMouse(): void {}
}

async function rig(above: Component[]) {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	for (const child of above) tui.addChild(child);
	tui.addChild(new Chip());
	const composer = new Composer();
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setPinnedFooterChildCount(2);
	tui.setScrollbackRebuild(false);
	tui.setScrollTransport("mouse");
	tui.setScrollIsolation(true);
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler };
}

/** SGR left-button press at 0-based screen (row, col). */
function leftClickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** The 0-based screen row showing `text`. */
function screenRowOf(term: VirtualTerminal, text: string): number {
	const row = term.getViewport().findIndex(line => line.includes(text));
	expect(row).toBeGreaterThanOrEqual(0);
	return row;
}

describe("a click above the footer reaches only a child that asked", () => {
	it("delivers the click to the declaring child at the line drawn under it", async () => {
		const target = new Target(["agents", "row-a", "row-b"], true);
		const { term, tui } = await rig([new Rows(["turn-1"]), target]);
		try {
			term.sendInput(leftClickAt(screenRowOf(term, "row-b"), 5));
			expect(target.clicks).toEqual([{ line: 2, col: 5 }]);
		} finally {
			tui.stop();
		}
	});

	it("maps through the window top once the frame scrolls past the viewport", async () => {
		const target = new Target(["agents", "row-a", "row-b"], true);
		const history = new Rows(Array.from({ length: HEIGHT * 3 }, (_, i) => `h${i}`));
		const { term, tui } = await rig([history, target]);
		try {
			expect(tui.scrollTapeRows).toBeGreaterThan(0);
			term.sendInput(leftClickAt(screenRowOf(term, "row-a"), 1));
			expect(target.clicks).toEqual([{ line: 1, col: 1 }]);
		} finally {
			tui.stop();
		}
	});

	it("keeps a child with a route but no declared targets deaf", async () => {
		const deaf = new Target(["agents", "row-a"], false);
		const { term, tui } = await rig([deaf]);
		try {
			term.sendInput(leftClickAt(screenRowOf(term, "row-a"), 2));
			expect(deaf.clicks).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("routes nothing while the view is scrolled back", async () => {
		const history = new Rows(Array.from({ length: HEIGHT * 3 }, (_, i) => `h${i}`));
		const target = new Target(["agents", "row-a"], true);
		const { term, tui, scheduler } = await rig([history, target]);
		try {
			// One wheel notch up freezes the transcript region on scroll-space rows.
			term.sendInput("\x1b[<64;1;1M");
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);
			for (let row = 0; row < HEIGHT - 2; row++) term.sendInput(leftClickAt(row, 1));
			expect(target.clicks).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("routes nothing while an overlay covers the transcript, and routes again once it closes", async () => {
		const target = new Target(["agents", "row-a", "row-b"], true);
		const { term, tui, scheduler } = await rig([new Rows(["turn-1"]), target]);
		try {
			const row = screenRowOf(term, "row-b");
			const handle = tui.showOverlay(new Rows(["modal"]), {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				aboveFooter: true,
			});
			await scheduler.drain(term);
			for (let r = 0; r < HEIGHT - 2; r++) term.sendInput(leftClickAt(r, 1));
			expect(target.clicks).toEqual([]);

			handle.hide();
			await scheduler.drain(term);
			term.sendInput(leftClickAt(screenRowOf(term, "row-b"), 1));
			expect(target.clicks).toEqual([{ line: 2, col: 1 }]);
			expect(row).toBeGreaterThanOrEqual(0);
		} finally {
			tui.stop();
		}
	});

	it("ignores a click that is not the left button", async () => {
		const target = new Target(["agents", "row-a"], true);
		const { term, tui } = await rig([target]);
		try {
			const row = screenRowOf(term, "row-a");
			// Button 2 is the right button, button 1 the middle one.
			term.sendInput(`\x1b[<2;2;${row + 1}M`);
			term.sendInput(`\x1b[<1;2;${row + 1}M`);
			expect(target.clicks).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
