/**
 * SGR (mode 1006) mouse reports, as a terminal sends them, at a 0-based viewport row and column.
 * The report itself is 1-based, so each adds one to both coordinates.
 */

/** A left-button press. */
export function sgrPress(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** A left-button release. */
export function sgrRelease(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

/** Pointer motion with no button held. */
export function sgrMotion(row: number, col: number): string {
	return `\x1b[<35;${col + 1};${row + 1}M`;
}
