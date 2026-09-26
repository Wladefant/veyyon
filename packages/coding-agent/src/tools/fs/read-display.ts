/**
 * What a read's card draws, and how a session file stores it without a second copy of the file.
 *
 * The model reads a file as numbered rows under a snapshot header (`[a.ts#1F2E]`, `12:const x = 1;`)
 * and the card draws the same rows without the numbers, so a result holds the file twice. The
 * session writes the card text only when the result's own text does not rebuild it:
 * {@link readResultCodec} drops it from the written line when a rebuild named by `from` reproduces it
 * exactly, and restores it when the session loads, so the entry in memory is the one the tool
 * returned.
 */
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../core/builtin-names";
import { type CodedResultContent, firstResultText, MIN_CODED_TEXT } from "../core/output-notice";

/**
 * The file's lines as the card draws them, without the hashline or line-number prefixes the model
 * reads, and the line number each carries. `lineNumbers` is present only when the count from
 * `startLine` breaks (an elided span or a jump between ranges); a contiguous window counts up from
 * `startLine`.
 */
export interface ReadDisplayContent {
	/** Absent in a session file line when `from` rebuilds it from the result's text. */
	text?: string;
	startLine: number;
	lineNumbers?: Array<number | null>;
	/**
	 * How the dropped `text` is rebuilt from the result's first text block. `rows` drops the snapshot
	 * header and each row's `N:`, `N-M:` or `N|` prefix, reading the rows up to the first empty line,
	 * and takes `lineNumbers` from those prefixes. `prefix` is the block's first `length` characters,
	 * with `lineNumbers` stored as the tool returned it.
	 *
	 * A persisted tag. Changing what a rebuild produces is a new tag with the old rebuild kept, or every
	 * session written before the change draws a different card.
	 */
	from?: "rows" | "prefix";
	/** The `prefix` rebuild's length. */
	length?: number;
}

/** A read display with its text present, which is what a card draws. */
export interface ResolvedReadDisplay {
	text: string;
	startLine: number;
	lineNumbers?: Array<number | null>;
}

/** A row's number prefix: `12:`, a merged brace pair's `12-18:`, or line-number mode's `12|`. */
const ROW_PREFIX = /^([1-9]\d*)(?:-[1-9]\d*)?[:|]/;

/** The row that stands for an elided span, drawn as is and numbered by nothing. */
const ELISION_ROW = "…";

/**
 * The card rows of numbered result text: the rows after an optional `[…]` header line up to the first
 * empty line, which separates the rows from whatever notice follows. Undefined when a row carries no
 * number prefix, since then the text is not numbered rows.
 */
function rebuildRows(body: string): { text: string; numbers: Array<number | null> } | undefined {
	let start = 0;
	const firstEnd = body.indexOf("\n");
	const firstLine = firstEnd === -1 ? body : body.slice(0, firstEnd);
	if (firstLine.startsWith("[") && firstLine.endsWith("]")) {
		if (firstEnd === -1) return undefined;
		start = firstEnd + 1;
	}
	let text = "";
	const numbers: Array<number | null> = [];
	while (start <= body.length) {
		let end = body.indexOf("\n", start);
		if (end === -1) end = body.length;
		const line = body.slice(start, end);
		if (line === "") break;
		if (numbers.length > 0) text += "\n";
		if (line === ELISION_ROW) {
			text += line;
			numbers.push(null);
		} else {
			const prefix = ROW_PREFIX.exec(line);
			if (!prefix) return undefined;
			text += line.slice(prefix[0].length);
			numbers.push(Number(prefix[1]));
		}
		start = end + 1;
	}
	return numbers.length > 0 ? { text, numbers } : undefined;
}

/** `numbers` as a display stores them: absent when they count up from `startLine` without a break. */
function storedNumbers(numbers: Array<number | null>, startLine: number): Array<number | null> | undefined {
	for (let i = 0; i < numbers.length; i++) {
		if (numbers[i] !== startLine + i) return numbers;
	}
	return undefined;
}

function sameNumbers(a: readonly (number | null)[] | undefined, b: readonly (number | null)[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The display a written line stores for `display`, or undefined when no rebuild reproduces it. */
function encode(display: ResolvedReadDisplay, body: string): ReadDisplayContent | undefined {
	const { text, startLine, lineNumbers } = display;
	if (text.length < MIN_CODED_TEXT) return undefined;
	const rows = rebuildRows(body);
	if (rows !== undefined && rows.text === text && sameNumbers(storedNumbers(rows.numbers, startLine), lineNumbers)) {
		return { startLine, from: "rows" };
	}
	if (body.startsWith(text)) {
		return { startLine, ...(lineNumbers === undefined ? {} : { lineNumbers }), from: "prefix", length: text.length };
	}
	return undefined;
}

/** The display `from` names, rebuilt from the result's text; undefined when that text cannot rebuild it. */
function rebuild(display: ReadDisplayContent, content: CodedResultContent): ResolvedReadDisplay | undefined {
	const body = firstResultText(content);
	if (body === undefined) return undefined;
	const { startLine } = display;
	if (display.from === "rows") {
		const rows = rebuildRows(body);
		if (rows === undefined) return undefined;
		const lineNumbers = storedNumbers(rows.numbers, startLine);
		return { text: rows.text, startLine, ...(lineNumbers === undefined ? {} : { lineNumbers }) };
	}
	if (display.from === "prefix" && typeof display.length === "number" && display.length <= body.length) {
		const text = body.slice(0, display.length);
		return { text, startLine, ...(display.lineNumbers === undefined ? {} : { lineNumbers: display.lineNumbers }) };
	}
	return undefined;
}

function isWholeDisplay(value: unknown): value is ResolvedReadDisplay {
	return isRecord(value) && typeof value.text === "string" && typeof value.startLine === "number";
}

function isSlimDisplay(value: unknown): value is ReadDisplayContent {
	return isRecord(value) && value.text === undefined && typeof value.from === "string";
}

/** How a read result is written to a session file and read back. */
export const readResultCodec: ToolResultCodec = {
	toolName: "read" satisfies BuiltinToolName,
	slim(details, content) {
		if (!isRecord(details) || !isWholeDisplay(details.displayContent)) return details;
		const body = firstResultText(content);
		if (body === undefined) return details;
		const displayContent = encode(details.displayContent, body);
		return displayContent === undefined ? details : { ...details, displayContent };
	},
	restore(details, content) {
		if (!isRecord(details) || !isSlimDisplay(details.displayContent)) return;
		const rebuilt = rebuild(details.displayContent, content);
		if (rebuilt !== undefined) details.displayContent = rebuilt;
	},
};

/**
 * The display a card draws for a read result. A session loaded with the codec registered holds it
 * whole; a transcript read without that restore holds the written form, which is rebuilt here from
 * the result's text. Undefined when the result has no display or its text no longer rebuilds one.
 */
export function resolveReadDisplay(
	display: ReadDisplayContent | undefined,
	content: CodedResultContent,
): ResolvedReadDisplay | undefined {
	if (display === undefined) return undefined;
	if (display.text !== undefined) return display as ResolvedReadDisplay;
	return rebuild(display, content);
}
