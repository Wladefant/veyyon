/**
 * WHY: a frame that shrinks below the committed row count is judged by the collapse rebase, which compares every
 * surviving row against the committed record byte for byte. The committed-prefix audit used to run first on the
 * same frame. Its tail sample tolerates one edited row and copies the frame's row into the record, so a collapsed
 * frame that replaced one recorded row (the only surviving row, or one row among unchanged neighbours) reached the
 * rebase already matching the record. The rebase then read the collapse as a squeeze, kept the replaced row
 * counted as committed, and the new row never entered native history: once later rows pushed it off the screen it
 * was gone. The render-stress replay `linux-normal-small` seed `0x1badb002` failed on its first operation this way.
 *
 * The class closed here: for every position of the replaced row among the surviving rows, on a direct terminal and
 * in a multiplexer pane, the new row is on screen or in native history right after the collapse, and in native
 * history once the frame grows past the viewport. The unchanged collapse (a strict prefix of the record) is swept beside it, and
 * no variant commits a second copy of a row above the replaced one or of a row the collapse dropped.
 *
 * Not caught: a root that declares native-scrollback seams, whose collapse can take the erase-and-replay path
 * instead; `a-row-in-native-history-is-never-committed-again.test.ts` drives that root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Component, TUI } from "../src/index";
import { settleFrames } from "./helpers/settle-frames";
import { plainRows } from "./helpers/terminal-output";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 6;
const TALL = 38;
const SURVIVORS = 10;
const GROWTH = 20;

class Rows implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

const recorded = (index: number): string => `row ${String(index).padStart(2, "0")}`;

/** Which surviving row the collapse replaces; `null` collapses into a strict prefix of the record. */
const REPLACED_ROWS = [
	{ name: "the only surviving row", survivors: 1, replaced: 0 },
	{ name: "the first of ten surviving rows", survivors: SURVIVORS, replaced: 0 },
	{ name: "a middle row among unchanged neighbours", survivors: SURVIVORS, replaced: 5 },
	{ name: "the last surviving row", survivors: SURVIVORS, replaced: SURVIVORS - 1 },
	{ name: "no row (a strict prefix)", survivors: SURVIVORS, replaced: null },
] as const;

const TERMINAL_KINDS = ["direct", "multiplexer"] as const;

function history(term: VirtualTerminal): string[] {
	return plainRows(term.getScrollBuffer().slice(0, term.getBufferPosition().baseY));
}

interface Outcome {
	/** Native history, then the screen, right after the collapse. */
	shownAfterCollapse: string[];
	historyAfterGrowth: string[];
}

async function collapseThenGrow(survivors: number, replaced: number | null): Promise<Outcome> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 1_000);
	const tui = new TUI(term);
	const root = new Rows();
	tui.addChild(root);
	tui.start();
	try {
		await settleFrames(term, tui);
		root.lines = Array.from({ length: TALL }, (_, i) => recorded(i));
		tui.requestRender();
		await settleFrames(term, tui);

		const collapsed = Array.from({ length: survivors }, (_, i) => (i === replaced ? `fresh ${i}` : recorded(i)));
		root.lines = collapsed;
		tui.requestRender();
		await settleFrames(term, tui);
		const shownAfterCollapse = [...history(term), ...plainRows(term.getViewport())];

		root.lines = [...collapsed, ...Array.from({ length: GROWTH }, (_, i) => `grown ${i}`)];
		tui.requestRender();
		await settleFrames(term, tui);
		return { shownAfterCollapse, historyAfterGrowth: history(term) };
	} finally {
		tui.stop();
	}
}

describe("a collapse that rewrites a recorded row puts the new row in history", () => {
	let savedTmux: string | undefined;
	let savedTermProgram: string | undefined;
	beforeEach(() => {
		savedTmux = Bun.env.TMUX;
		savedTermProgram = Bun.env.TERM_PROGRAM;
		delete Bun.env.TERM_PROGRAM;
	});
	afterEach(() => {
		if (savedTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = savedTmux;
		if (savedTermProgram === undefined) delete Bun.env.TERM_PROGRAM;
		else Bun.env.TERM_PROGRAM = savedTermProgram;
	});

	for (const terminal of TERMINAL_KINDS) {
		for (const { name, survivors, replaced } of REPLACED_ROWS) {
			test(`${terminal} terminal, replacing ${name}`, async () => {
				if (terminal === "multiplexer") Bun.env.TMUX = "/tmp/tmux-1000/default,12345,0";
				else delete Bun.env.TMUX;
				const { shownAfterCollapse, historyAfterGrowth } = await collapseThenGrow(survivors, replaced);

				if (replaced !== null) {
					const fresh = `fresh ${replaced}`;
					expect(shownAfterCollapse).toContain(fresh);
					expect(historyAfterGrowth.filter(row => row === fresh)).toEqual([fresh]);
				}
				// Rows above the replaced one stay recognized as committed, and rows the collapse dropped are not in
				// the frame at all: each is in history once. Rows from the replaced one down may be committed again
				// below their stale copies.
				const firstRepainted = replaced ?? survivors;
				for (let i = 0; i < TALL - HEIGHT; i++) {
					if (i >= firstRepainted && i < survivors) continue;
					expect(historyAfterGrowth.filter(row => row === recorded(i))).toEqual([recorded(i)]);
				}
			});
		}
	}
});
