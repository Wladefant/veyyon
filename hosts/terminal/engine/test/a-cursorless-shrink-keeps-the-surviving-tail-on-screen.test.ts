import "./warm-natives";
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

// WHY: a frame with no cursor marker that shrinks onto its own committed prefix must keep
// painting the surviving tail. The window floor at the commit boundary parked the window past
// the last frame row and painted blank lines. This closes the class "any cursorless collapse whose
// surviving frame is entirely committed", not only the 100 -> 50 incident. It leaves open
// cursor-bearing frames, which take the tail re-anchor branch, and multiplexer geometry changes.

class PlainLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

describe("cursorless shrink onto the committed prefix", () => {
	it("keeps the surviving tail on screen instead of painting blank rows", async () => {
		const term = new VirtualTerminal(40, 24);
		const tui = new TUI(term);
		const component = new PlainLinesComponent(Array.from({ length: 100 }, (_v, i) => `row-${i}`));
		tui.addChild(component);

		try {
			tui.start();
			await settleFrames(term, tui);

			// Identical 50-row prefix of the 100-row frame, no cursor marker anywhere.
			component.setLines(Array.from({ length: 50 }, (_v, i) => `row-${i}`));
			tui.requestRender();
			await settleFrames(term, tui);

			const viewport = term.getViewport().map(line => line.trimEnd());
			// The 24-row viewport must show the last 24 surviving rows, row-26 through row-49.
			expect(viewport).toEqual(Array.from({ length: 24 }, (_v, i) => `row-${i + 26}`));
		} finally {
			tui.stop();
		}
	});
});
