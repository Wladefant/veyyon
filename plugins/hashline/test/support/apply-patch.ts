import { applyEdits, parsePatch } from "@veyyon/hashline";

/** The text `patch` produces when applied to `text`. */
export function applyPatch(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

/** `lines` as file text: one line each, newline-terminated. */
export function linesText(lines: readonly string[]): string {
	return `${lines.join("\n")}\n`;
}

/** The number of lines in `text`; an empty file and a lone newline hold none. */
export function lineCount(text: string): number {
	if (text === "" || text === "\n") return 0;
	return text.replace(/\n$/, "").split("\n").length;
}
