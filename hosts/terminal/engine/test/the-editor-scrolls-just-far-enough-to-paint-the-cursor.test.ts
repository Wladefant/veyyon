/**
 * A height-capped editor scrolls just far enough to paint the cursor's row.
 *
 * WHY: the scroll window is chosen from the cursor's visual row, and the frame paints the cursor on
 * the row the layout marks. When the two are computed apart they can disagree: the window then
 * stops one row short, leaves the cursor above or below the painted rows, or jumps to the end of
 * the draft. The class this closes is any frame whose window does not contain the painted cursor,
 * and any move that scrolls further than the one row needed to bring it back into view, across
 * wrapped lines, line ends and programmatic jumps.
 *
 * It does not pin which row a page-sized jump lands on, only that the cursor is painted after it.
 */
import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const WIDTH = 20;
const HEIGHT = 4;
/** Short lines between lines that wrap to two and three rows at {@link WIDTH}. */
const DRAFT = [
	"alpha",
	"beta gamma delta epsilon zeta eta theta",
	"iota",
	"kappa lambda mu nu xi omicron pi rho sigma",
	"tau",
	"upsilon",
	"phi chi psi omega alpha beta",
	"end",
];
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function cappedEditor(): { editor: Editor; visualRows: number } {
	const editor = new Editor(defaultEditorTheme);
	editor.setBorderVisible(false);
	editor.focused = true;
	editor.setText(DRAFT.join("\n"));
	const visualRows = editor.render(WIDTH).length;
	editor.setMaxHeight(HEIGHT);
	return { editor, visualRows };
}

/** The painted row holding the cursor; fails unless exactly one row holds it. */
function cursorRow(editor: Editor): number {
	const rows = editor.render(WIDTH);
	const holding = rows.flatMap((row, index) => (row.includes(CURSOR_MARKER) ? [index] : []));
	expect(holding).toHaveLength(1);
	expect(rows).toHaveLength(HEIGHT);
	return holding[0]!;
}

describe("a height-capped editor scrolls just far enough to paint the cursor", () => {
	it("walks the cursor down to the bottom row and keeps it there while the draft scrolls", () => {
		const { editor, visualRows } = cappedEditor();
		// The walk crosses wrapped rows, not only one row per logical line.
		expect(visualRows).toBeGreaterThan(DRAFT.length);
		editor.setCursor({ line: 0, col: 0 });
		const seen = [cursorRow(editor)];
		for (let press = 1; press < visualRows; press++) {
			editor.handleInput(DOWN);
			seen.push(cursorRow(editor));
		}
		expect(seen).toEqual(Array.from({ length: visualRows }, (_, row) => Math.min(row, HEIGHT - 1)));
	});

	it("walks the cursor up to the top row and keeps it there while the draft scrolls back", () => {
		const { editor, visualRows } = cappedEditor();
		editor.setCursor({ line: DRAFT.length - 1, col: 0 });
		const seen = [cursorRow(editor)];
		for (let press = 1; press < visualRows; press++) {
			editor.handleInput(UP);
			seen.push(cursorRow(editor));
		}
		expect(seen).toEqual(Array.from({ length: visualRows }, (_, row) => Math.max(HEIGHT - 1 - row, 0)));
	});

	it("paints the cursor after a jump to any line start, middle or end", () => {
		const { editor } = cappedEditor();
		const targets = DRAFT.flatMap((line, index) => [
			{ line: index, col: 0 },
			{ line: index, col: Math.floor(line.length / 2) },
			{ line: index, col: line.length },
		]);
		// Jump forward through the draft, then back, so each jump leaves the previous window.
		for (const target of [...targets, ...targets.slice().reverse()]) {
			editor.setCursor(target);
			cursorRow(editor);
		}
	});
});
