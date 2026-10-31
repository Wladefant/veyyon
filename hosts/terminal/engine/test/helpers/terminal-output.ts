import { vi } from "bun:test";
import type { VirtualTerminal } from "../virtual-terminal";

/** Record every chunk the TUI writes to `term`, in order, while still passing each one to the terminal. */
export function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

/** The index of the lowest viewport row holding visible text, or -1 when the viewport is blank. */
export function lastPaintedRow(term: VirtualTerminal): number {
	return term.getViewport().reduce((last, row, i) => (Bun.stripANSI(row).trim().length > 0 ? i : last), -1);
}

/** Each row with its ANSI styling removed and its trailing blanks trimmed. */
export function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

/** The terminal's visible rows as plain text, trailing blanks trimmed. */
export function viewportRows(term: VirtualTerminal): string[] {
	return plainRows(term.getViewport());
}
