/**
 * SGR (mode 1006) pointer reports at 1-based screen coordinates, as a terminal writes them. A suite
 * that finds its target on a rendered frame adds one to the frame index and passes the result. The
 * column defaults to 40, the middle of the 80-column frames the pointer suites draw.
 * `hosts/terminal/engine/test/helpers/sgr-mouse.ts` holds the 0-based forms the engine suites use.
 */

/** A left-button press. */
export function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}

/** Pointer motion with no button held. */
export function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}

/** One wheel notch. */
export function wheelAt(direction: "up" | "down", row1: number, col1 = 40): string {
	return `\x1b[<${direction === "down" ? 65 : 64};${col1};${row1}M`;
}
