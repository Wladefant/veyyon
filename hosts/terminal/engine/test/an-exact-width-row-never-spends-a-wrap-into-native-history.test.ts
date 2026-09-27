/**
 * An exact-width row must cost the terminal nothing: ConPTY materializes the
 * pending wrap left by a row that reached the last column *before* it processes
 * the cursor move that follows, the wrap is spent as a line feed, and on the
 * bottom screen row that line feed scrolls a live row into native history. The
 * status line and composer then sit one row above a stranded copy of themselves,
 * and only an erase-and-replay can repair it.
 *
 * WHY THIS CLOSES THE DEFECT.
 * Every row the engine rewrites through `lineRewriteSequence` now ends at column
 * zero, so the pending wrap is spent by an explicit carriage return instead of
 * leaking into the next cursor move. The oracle is a terminal model that spends
 * the wrap the way ConPTY does; the real `TUI` and the real `VirtualTerminal`
 * drive it, so the defect is reached the way a user reaches it (a status row
 * that changes every frame, or a transcript that scrolls).
 *
 * THE CLASS, not the incident.
 * Any rewritten row that fills the width is a member, on both the partial-update
 * path (only the changed row is rewritten, then an explicit cursor move) and the
 * scrolling-append path (whole window rewritten row by row). Both are exercised,
 * and the assertions are on native history: no row may enter it except the ones
 * that genuinely scrolled off, and the buffer must be exactly the logical
 * transcript's tail.
 *
 * WHAT IT DOES NOT CATCH.
 * The model is an approximation of conhost, not conhost: a real host that
 * materializes the wrap under conditions this model does not encode (a
 * double-width glyph straddling the last cell, an update that ends the frame
 * without any following cursor move) stays green here. Rows in the fixture are
 * ASCII, where one code unit is one column; the wide-character and
 * combining-mark cases are covered by the width suites. Alternate-screen
 * repaints are not driven at all.
 */
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 20;
const HEIGHT = 4;

/** CSI final bytes that move the cursor, so a pending wrap can be spent first. */
const CURSOR_MOVE_FINAL = "HfABCD";

function ansiSequenceEnd(data: string, start: number): number {
	const next = data.charCodeAt(start + 1);
	if (next === 0x5b) {
		// CSI: parameter and intermediate bytes, then a final byte in 0x40-0x7e.
		let i = start + 2;
		while (i < data.length && (data.charCodeAt(i) < 0x40 || data.charCodeAt(i) > 0x7e)) i++;
		return Math.min(i + 1, data.length);
	}
	if (next === 0x5d) {
		// OSC: through BEL or ST.
		let i = start + 2;
		while (i < data.length) {
			const code = data.charCodeAt(i);
			if (code === 0x07) return i + 1;
			if (code === 0x1b && data.charCodeAt(i + 1) === 0x5c) return i + 2;
			i++;
		}
		return data.length;
	}
	return Math.min(start + 2, data.length);
}

function isCursorMove(sequence: string): boolean {
	return sequence.startsWith("\x1b[") && CURSOR_MOVE_FINAL.includes(sequence[sequence.length - 1] ?? "");
}

/**
 * Spends the pending wrap ConPTY spends: a row that reached the last column
 * leaves the wrap pending until the next cursor-addressing sequence, which
 * costs one line feed before it is honoured (#9783). The pending width is
 * carried across writes, because a paint that ends on the bottom row leaves
 * the wrap pending for whatever the next paint writes first.
 */
class ConptyPendingWrapTerminal extends VirtualTerminal {
	#pendingRowWidth = 0;

	override write(data: string): void {
		let out = "";
		for (let i = 0; i < data.length; ) {
			const character = data[i] ?? "";
			if (character === "\x1b") {
				const end = ansiSequenceEnd(data, i);
				const sequence = data.slice(i, end);
				if (isCursorMove(sequence)) {
					if (this.#pendingRowWidth >= this.columns) out += "\r\n";
					// Any cursor move cancels the wrap, whether or not it was spent.
					this.#pendingRowWidth = 0;
				}
				out += sequence;
				i = end;
				continue;
			}
			if (character === "\r" || character === "\n") this.#pendingRowWidth = 0;
			// ASCII fixture rows: one code unit, one column.
			else this.#pendingRowWidth += 1;
			out += character;
			i += 1;
		}
		super.write(out);
	}
}

/** A fixed transcript with a status row that fills the width and changes every frame. */
class ExactWidthStatusFrame implements Component {
	#status = "status 1".padEnd(WIDTH, ".");

	setStatus(text: string): void {
		this.#status = text.padEnd(WIDTH, ".");
	}

	invalidate(): void {}

	render(width: number): string[] {
		return ["history one", "history two", "editor", this.#status.slice(0, width)];
	}
}

/** A transcript that grows by one full-width row at a time, so it must scroll. */
class GrowingExactWidthTranscript implements Component {
	readonly rows: string[] = [];

	append(label: string): void {
		this.rows.push(label.padEnd(WIDTH, "."));
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.rows.map(row => row.slice(0, width));
	}
}

describe("an exact-width row never spends a wrap into native history", () => {
	it("keeps the live screen still when the bottom status row is rewritten", async () => {
		const terminal = new ConptyPendingWrapTerminal(WIDTH, HEIGHT);
		const frame = new ExactWidthStatusFrame();
		const tui = new TUI(terminal, true);
		tui.addChild(frame);

		try {
			tui.start({ clearScrollback: true });
			await settleFrames(terminal, tui);

			for (let update = 2; update <= 8; update++) {
				frame.setStatus(`status ${update}`);
				tui.requestRender(true);
				await settleFrames(terminal, tui);
			}

			expect(terminal.getBufferPosition().baseY).toBe(0);
			expect(terminal.getScrollBuffer().map(line => line.trimEnd())).toEqual([
				"history one",
				"history two",
				"editor",
				"status 8............",
			]);
		} finally {
			tui.stop();
		}
	});

	it("scrolls exactly one row at a time when a full-width transcript grows", async () => {
		const terminal = new ConptyPendingWrapTerminal(WIDTH, HEIGHT);
		const frame = new GrowingExactWidthTranscript();
		const tui = new TUI(terminal, true);
		tui.addChild(frame);

		try {
			tui.start({ clearScrollback: true });
			await settleFrames(terminal, tui);

			for (let row = 0; row < 6; row++) {
				frame.append(`row ${row}`);
				tui.requestRender();
				await settleFrames(terminal, tui);
			}

			const buffer = terminal.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer.length).toBe(terminal.getBufferPosition().baseY + HEIGHT);
			expect(buffer).toEqual(frame.rows.map(line => line.trimEnd()).slice(-buffer.length));
		} finally {
			tui.stop();
		}
	});
});
