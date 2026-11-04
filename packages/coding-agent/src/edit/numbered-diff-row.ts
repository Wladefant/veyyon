/**
 * The row grammar of the numbered diff an edit result holds in `details.diff`, and its inverse.
 *
 * A row is `+12|text` for a line the edit added, numbered in the new file, `-12|text` for a line it
 * removed and ` 12|text` for a context line, both numbered in the old file. Rows are joined with
 * `\n`, and a line holds no `\n`, so each row carries its line's text byte for byte. Gap rows and
 * `@@` hunk headers match no row and carry no line.
 */

export interface ParsedNumberedDiffRow {
	prefix: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

const NUMBERED_DIFF_ROW = /^([+\- ])(\d+)\|(.*)$/s;

export function formatNumberedDiffLine(prefix: "+" | "-" | " ", lineNum: number, content: string): string {
	return `${prefix}${lineNum}|${content}`;
}

export function parseNumberedDiffRow(row: string): ParsedNumberedDiffRow | undefined {
	const match = NUMBERED_DIFF_ROW.exec(row);
	if (!match) return undefined;
	const prefix = match[1] as "+" | "-" | " ";
	const lineNumber = Number.parseInt(match[2], 10);
	if (!Number.isFinite(lineNumber)) return undefined;
	return { prefix, lineNumber, content: match[3] ?? "" };
}

/**
 * The text after the edit `diff` records: `oldText` without the lines its `-` rows name, with each
 * `+` row's line placed at its new-file number. Context rows are not read. Undefined when a `-` row
 * names a line `oldText` does not hold with that text, when two `+` rows claim one number, or when a
 * `+` row's number lies past the end of the rebuilt text.
 *
 * Rebuilds the text only when the diff lists every changed line, which the numbered diffs an edit
 * writes do; a caller that stores the result in place of the text compares it first.
 */
export function applyNumberedDiff(oldText: string, diff: string): string | undefined {
	const oldLines = oldText.split("\n");
	const removed = new Set<number>();
	const added = new Map<number, string>();
	for (const row of diff.split("\n")) {
		const parsed = parseNumberedDiffRow(row);
		if (parsed === undefined || parsed.prefix === " ") continue;
		const { lineNumber, content } = parsed;
		if (parsed.prefix === "-") {
			if (oldLines[lineNumber - 1] !== content) return undefined;
			removed.add(lineNumber);
		} else {
			if (added.has(lineNumber)) return undefined;
			added.set(lineNumber, content);
		}
	}
	const lines: string[] = [];
	let oldIndex = 0;
	let placed = 0;
	for (;;) {
		const addedLine = added.get(lines.length + 1);
		if (addedLine !== undefined) {
			lines.push(addedLine);
			placed++;
		} else if (oldIndex === oldLines.length) {
			break;
		} else if (!removed.has(++oldIndex)) {
			lines.push(oldLines[oldIndex - 1]);
		}
	}
	return placed === added.size ? lines.join("\n") : undefined;
}
