/**
 * Correspondence between the lines of two versions of one text: which line of
 * the later version holds each unchanged line of the earlier one, and which
 * lines of the later version have no counterpart (they were written by the
 * change). Lines are the segments of `text.split("\n")`, 1-indexed.
 *
 * The unchanged head and tail are found by comparing the texts in blocks and
 * are never split; only the changed middle is split and diffed, so a small
 * edit to a large file costs a block compare of its text and a newline count
 * of its head, not a diff of every line.
 */
import { lazy } from "@veyyon/utils/abortable";
import type * as Diff from "diff";

/** The `diff` package, evaluated on the first map with a changed middle rather than when the patcher loads. */
const diffPackage = lazy(() => require("diff") as typeof Diff);

const NEWLINE = 10;

/**
 * Characters compared per `startsWith` call before the scan narrows to one
 * character at a time. A native block compare runs about 15 times faster than
 * a `charCodeAt` loop over the same text.
 */
const COMPARE_BLOCK = 1024;

function countNewlines(text: string, start: number, end: number): number {
	let count = 0;
	for (let at = text.indexOf("\n", start); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

/** The number of lines in `text`: its `split("\n")` segments, counted without splitting. */
export function lineCount(text: string): number {
	return countNewlines(text, 0, text.length) + 1;
}

function isLineStart(text: string, at: number): boolean {
	return at === 0 || text.charCodeAt(at - 1) === NEWLINE;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let at = 0;
	while (at + COMPARE_BLOCK <= limit && a.startsWith(b.slice(at, at + COMPARE_BLOCK), at)) at += COMPARE_BLOCK;
	while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++;
	return at;
}

/** Length of the longest common suffix of `a` and `b`, at most `limit`. */
function commonSuffixLength(a: string, b: string, limit: number): number {
	let common = 0;
	while (
		common + COMPARE_BLOCK <= limit &&
		a.startsWith(b.slice(b.length - common - COMPARE_BLOCK, b.length - common), a.length - common - COMPARE_BLOCK)
	) {
		common += COMPARE_BLOCK;
	}
	while (common < limit && a.charCodeAt(a.length - 1 - common) === b.charCodeAt(b.length - 1 - common)) common++;
	return common;
}

/** The lines of `text.slice(start, end)`, where `end` is a line start of `text` or its end. */
function middleLines(text: string, start: number, end: number, endsAtLineStart: boolean): string[] {
	if (endsAtLineStart && end === start) return [];
	const lines = text.slice(start, end).split("\n");
	// A middle that stops at the next line's start ends in a newline; the empty
	// segment after it is that next line, which belongs to the tail.
	if (endsAtLineStart) lines.pop();
	return lines;
}

/**
 * The line diff of two non-empty middles, or `undefined` when it needs more
 * edits than `budget` allows for their length. The diff's work grows with its
 * edit count times the lines it compares, so the bound caps it.
 */
function diffMiddle(
	previous: string[],
	current: string[],
	budget: number | undefined,
): Diff.ChangeObject<string[]>[] | undefined {
	if (budget === undefined) return diffPackage.value.diffArrays(previous, current);
	const maxEditLength = Math.floor(budget / (previous.length + current.length));
	return diffPackage.value.diffArrays(previous, current, { maxEditLength });
}

export class LineMap {
	readonly #previousText: string;
	/** Offset of the unchanged tail in the previous text, or -1 when the change runs to its end. */
	readonly #tailOffset: number;
	/** Lines of the previous text, counted on the first lookup that needs the bound. */
	#previousLineCount: number | undefined;
	readonly #prefix: number;
	readonly #suffixStart: number;
	readonly #shift: number;
	readonly #middle: Map<number, number>;
	readonly #written: number[];

	/**
	 * `diffBudget` bounds the diff of the changed middle: it runs only while
	 * its edit count times the middle's line count stays within the budget,
	 * and a middle past it is read as rewritten, pairing none of its lines and
	 * reporting each of its current lines written. Unbounded when omitted.
	 */
	constructor(previousText: string, currentText: string, diffBudget?: number) {
		this.#previousText = previousText;
		const previousLength = previousText.length;
		const currentLength = currentText.length;
		const differ = commonPrefixLength(previousText, currentText);
		if (differ === previousLength && differ === currentLength) {
			const lines = lineCount(previousText);
			this.#previousLineCount = lines;
			this.#tailOffset = -1;
			this.#prefix = lines;
			this.#suffixStart = lines + 1;
			this.#shift = 0;
			this.#middle = new Map();
			this.#written = [];
			return;
		}

		// Whole lines before the first difference are shared; the line it falls in is not.
		const prefix = countNewlines(previousText, 0, differ);
		const prefixChars = prefix === 0 ? 0 : previousText.lastIndexOf("\n", differ - 1) + 1;

		// Common trailing characters, never reaching back into the shared head.
		const common = commonSuffixLength(
			previousText,
			currentText,
			Math.min(previousLength, currentLength) - prefixChars,
		);

		// The tail starts at the first line start inside the common trailing
		// characters that is a line start in both texts.
		let previousTail = -1;
		let currentTail = -1;
		if (common > 0) {
			const previousEdge = previousLength - common;
			const currentEdge = currentLength - common;
			if (isLineStart(previousText, previousEdge) && isLineStart(currentText, currentEdge)) {
				previousTail = previousEdge;
				currentTail = currentEdge;
			} else {
				const newline = previousText.indexOf("\n", previousEdge);
				if (newline !== -1) {
					previousTail = newline + 1;
					currentTail = currentEdge + (previousTail - previousEdge);
				}
			}
		}
		const hasTail = previousTail !== -1;

		const previousMiddle = middleLines(previousText, prefixChars, hasTail ? previousTail : previousLength, hasTail);
		const currentMiddle = middleLines(currentText, prefixChars, hasTail ? currentTail : currentLength, hasTail);

		const middle = new Map<number, number>();
		const written: number[] = [];
		let previousLine = prefix + 1;
		let currentLine = prefix + 1;
		const changes =
			previousMiddle.length === 0 || currentMiddle.length === 0
				? undefined
				: diffMiddle(previousMiddle, currentMiddle, diffBudget);
		if (changes === undefined) {
			for (let i = 0; i < currentMiddle.length; i++) written.push(currentLine + i);
		} else {
			for (const change of changes) {
				const count = change.value.length;
				if (change.added) {
					for (let i = 0; i < count; i++) written.push(currentLine + i);
					currentLine += count;
				} else if (change.removed) {
					previousLine += count;
				} else {
					for (let i = 0; i < count; i++) middle.set(previousLine + i, currentLine + i);
					previousLine += count;
					currentLine += count;
				}
			}
		}

		this.#tailOffset = previousTail;
		this.#prefix = prefix;
		this.#suffixStart = prefix + previousMiddle.length + 1;
		this.#shift = currentMiddle.length - previousMiddle.length;
		this.#middle = middle;
		this.#written = written;
	}

	/** The line of the current text holding unchanged `previousLine`, or `undefined` when it was changed or removed. */
	get(previousLine: number): number | undefined {
		if (!Number.isInteger(previousLine) || previousLine < 1) return undefined;
		if (previousLine <= this.#prefix) return previousLine;
		if (previousLine < this.#suffixStart) return this.#middle.get(previousLine);
		return previousLine <= this.#lineCount() ? previousLine + this.#shift : undefined;
	}

	/** The lines of `previousLines` this map pairs with the same line number of the current text. */
	unmoved(previousLines: Iterable<number>): number[] {
		const unmoved: number[] = [];
		for (const line of previousLines) {
			if (this.get(line) === line) unmoved.push(line);
		}
		return unmoved;
	}

	/** Lines of the current text with no counterpart in the previous one, ascending. */
	written(): readonly number[] {
		return this.#written;
	}

	#lineCount(): number {
		this.#previousLineCount ??=
			this.#tailOffset === -1
				? this.#suffixStart - 1
				: this.#suffixStart + countNewlines(this.#previousText, this.#tailOffset, this.#previousText.length);
		return this.#previousLineCount;
	}
}
