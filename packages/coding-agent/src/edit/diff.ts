/**
 * Diff generation and replace-mode utilities for the edit tool.
 *
 * Provides diff string generation and the replace-mode edit logic
 * used when not in patch mode.
 */

import { errorMessage, lazy } from "@veyyon/utils";
import type * as Diff from "diff";
import { resolveToCwd } from "../tools/core/path-utils";
import { type BlockContextSource, exceedsBlockContextScanCeiling, findBlockContextLines } from "../utils/block-context";
import { parseUnifiedHunkHeader } from "../utils/unified-hunk-header";
import { EOF_MARKER, FILE_OP_MARKERS, PATCH_WRAPPER_MARKERS } from "./apply-patch/markers";
import { DEFAULT_FUZZY_THRESHOLD, EditMatchError, findMatch, type MatchOutcome } from "./match";
import { adjustIndentation, normalizeToLF, stripBom } from "./normalize";
import { formatNumberedDiffLine, parseNumberedDiffRow } from "./numbered-diff-row";
import { readPreviewText } from "./preview-text-cache";

/**
 * The `diff` package, evaluated on the first diff. It is 19 modules, and the edit tool module is evaluated
 * when a session builds its tools, before anything has been edited. `require`, because `bun build --compile`
 * evaluates an `import defer` namespace with the rest of the graph and the diff helpers are synchronous.
 */
const diffPackage = lazy(() => require("diff") as typeof Diff);

export interface DiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface DiffError {
	error: string;
}

export interface DiffHunk {
	changeContext?: string;
	oldStartLine?: number;
	newStartLine?: number;
	hasContextLines: boolean;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export class ParseError extends Error {
	constructor(
		message: string,
		readonly lineNumber?: number,
	) {
		super(lineNumber !== undefined ? `Line ${lineNumber}: ${message}` : message);
		this.name = "ParseError";
	}
}

export class ApplyPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyPatchError";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff String Generation
// ═══════════════════════════════════════════════════════════════════════════

function isDiffChangeRow(row: string | undefined): boolean {
	return row !== undefined && (row.startsWith("+") || row.startsWith("-"));
}

/** Blank row separating non-contiguous regions of a numbered diff. */
const DIFF_GAP_ROW = "";

/** Old-file line number of a source-visible row (`-` or context); `+`/gap/other rows yield undefined. */
function parseSourceRowLineNumber(row: string): number | undefined {
	const parsed = parseNumberedDiffRow(row);
	return parsed === undefined || parsed.prefix === "+" ? undefined : parsed.lineNumber;
}

/**
 * Drop gap rows that no longer separate anything. Context rows are inserted
 * one at a time, each adding its own gap rows from a snapshot of the diff, so
 * the raw result can contain adjacent gap rows, gap rows whose neighbors
 * became contiguous after a later insert filled the hole, and gap rows at the
 * diff edges. The sweep keeps a gap row only when it sits between two
 * source-numbered rows (old-file coordinates — the same numbering the
 * insertion gap test uses) that are actually non-contiguous, and never keeps
 * two in a row.
 */
function normalizeDiffGapRows(rows: string[]): void {
	const kept: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row !== DIFF_GAP_ROW) {
			kept.push(row);
			continue;
		}
		if (kept.length === 0 || kept[kept.length - 1] === DIFF_GAP_ROW) continue;
		let before: number | undefined;
		for (let j = kept.length - 1; j >= 0 && before === undefined; j--) {
			before = parseSourceRowLineNumber(kept[j]);
		}
		let after: number | undefined;
		for (let j = i + 1; j < rows.length && after === undefined; j++) {
			if (rows[j] === DIFF_GAP_ROW) continue;
			after = parseSourceRowLineNumber(rows[j]);
		}
		if (before === undefined || after === undefined || after <= before + 1) continue;
		kept.push(row);
	}
	if (kept.length !== rows.length) rows.splice(0, rows.length, ...kept);
}

function adjustedContextInsertIndex(rows: readonly string[], index: number): number {
	let start = index;
	while (start > 0 && isDiffChangeRow(rows[start - 1])) start--;
	let end = index;
	while (end < rows.length && isDiffChangeRow(rows[end])) end++;
	return index > start && index < end ? end : index;
}

function insertBracketContextRows(
	rows: string[],
	contextLines: ReadonlyMap<number, string>,
	seenRows: Set<string>,
): void {
	const context = Array.from(contextLines).sort(([left], [right]) => left - right);
	for (const [lineNumber, text] of context) {
		const row = formatNumberedDiffLine(" ", lineNumber, text);
		if (seenRows.has(row)) continue;

		let insertIndex = rows.length;
		let previousSourceLine: number | undefined;
		let nextSourceLine: number | undefined;
		for (let i = 0; i < rows.length; i++) {
			const parsed = parseNumberedDiffRow(rows[i]);
			if (!parsed || parsed.prefix === "+") continue;
			if (parsed.lineNumber < lineNumber) {
				previousSourceLine = parsed.lineNumber;
				continue;
			}
			nextSourceLine = parsed.lineNumber;
			insertIndex = i;
			break;
		}

		const chunk: string[] = [];
		if (previousSourceLine !== undefined && lineNumber > previousSourceLine + 1) chunk.push(DIFF_GAP_ROW);
		chunk.push(row);
		if (nextSourceLine !== undefined && nextSourceLine > lineNumber + 1) chunk.push(DIFF_GAP_ROW);

		const adjustedIndex = adjustedContextInsertIndex(rows, insertIndex);
		rows.splice(adjustedIndex, 0, ...chunk);
		seenRows.add(row);
	}
}

/**
 * Insert off-window block-boundary rows (enclosing header, matching closing
 * bracket, …) into a numbered diff. Context rows carry pre-edit line numbers —
 * the renumbering contract of `buildCompactDiffPreview` — so boundary lines
 * discovered in the new file are translated back to their pre-edit numbers
 * and merged with the old-file pass before a single insertion sweep. Without
 * the translation, a context line sitting in a net-offset region would be
 * re-inserted under its post-edit number: duplicated, out of order, and
 * renumbered incorrectly by the preview.
 */
async function addMatchingBracketContextRows(
	rows: string[],
	oldText: string,
	newText: string,
	source: BlockContextSource,
): Promise<void> {
	// Ask before splitting: each side of a large pair is a whole-file array, and
	// on a source over the boundary-scan ceiling the lookup below returns
	// nothing regardless.
	if (exceedsBlockContextScanCeiling(oldText) || exceedsBlockContextScanCeiling(newText)) return;
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const oldVisible: number[] = [];
	const newVisible: number[] = [];
	const seenRows = new Set(rows);
	// Change positions in new-file coordinates, used to translate an unchanged
	// new-file line number back to its pre-edit equivalent.
	const changes: { newPos: number; delta: 1 | -1 }[] = [];
	let offset = 0;

	for (const row of rows) {
		const parsed = parseNumberedDiffRow(row);
		if (!parsed) continue;
		switch (parsed.prefix) {
			case "-":
				oldVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber + offset, delta: -1 });
				offset--;
				break;
			case "+":
				newVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber, delta: 1 });
				offset++;
				break;
			default:
				// Context rows are visible in BOTH files: pre-edit number as
				// written, post-edit number shifted by the net change so far.
				oldVisible.push(parsed.lineNumber);
				newVisible.push(parsed.lineNumber + offset);
				break;
		}
	}

	const toOldLineNumber = (newLineNumber: number): number => {
		let shift = 0;
		for (const change of changes) {
			if (change.newPos <= newLineNumber) shift += change.delta;
		}
		return newLineNumber - shift;
	};

	// Each side hands its own text down: the lookup joins the line array back
	// into a source when it is not given one, which is a copy of the whole file
	// per side per call, and this caller is holding both strings already.
	const contextRows = await findBlockContextLines(oldLines, oldVisible, { ...source, text: oldText });
	for (const [lineNumber, text] of await findBlockContextLines(newLines, newVisible, { ...source, text: newText })) {
		const oldLineNumber = toOldLineNumber(lineNumber);
		if (!contextRows.has(oldLineNumber)) contextRows.set(oldLineNumber, text);
	}
	insertBracketContextRows(rows, contextRows, seenRows);
	normalizeDiffGapRows(rows);
}

/** UTF-16 units compared per step while two texts are scanned for the run of text they share. */
const SHARED_RUN_BLOCK = 4096;

function sharedPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let length = 0;
	while (
		length + SHARED_RUN_BLOCK <= limit &&
		a.slice(length, length + SHARED_RUN_BLOCK) === b.slice(length, length + SHARED_RUN_BLOCK)
	) {
		length += SHARED_RUN_BLOCK;
	}
	while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length++;
	return length;
}

function sharedSuffixLength(a: string, b: string, limit: number): number {
	let length = 0;
	while (
		length + SHARED_RUN_BLOCK <= limit &&
		a.slice(a.length - length - SHARED_RUN_BLOCK, a.length - length) ===
			b.slice(b.length - length - SHARED_RUN_BLOCK, b.length - length)
	) {
		length += SHARED_RUN_BLOCK;
	}
	while (length < limit && a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)) length++;
	return length;
}

/** Two texts cut to the lines they differ in, framed by up to `context` unchanged lines either side. */
interface ChangeSpan {
	/** Unchanged lines before the first difference, each ending in a line break. */
	before: string;
	/** The old text's lines from the first difference through the last. */
	oldText: string;
	/** The new text's lines from the first difference through the last. */
	newText: string;
	/** Unchanged lines after the last difference; the last has no line break when the file ends without one. */
	after: string;
	/** 1-indexed number, in both files, of the first line of `before`. */
	firstLine: number;
}

/** Whether the unit at `index` begins a line of `text`. */
function startsLine(text: string, index: number): boolean {
	return index === 0 || text.charCodeAt(index - 1) === 10;
}

/** The last line start of `text` at or before `index`. */
function lineStartAtOrBefore(text: string, index: number): number {
	return index === 0 ? 0 : text.lastIndexOf("\n", index - 1) + 1;
}

/**
 * Cut the lines both texts start with and end with, keeping `context` of them either side, as GNU diff
 * (`find_identical_ends`) and git (`xdl_trim_ends`) do before comparing.
 *
 * jsdiff splits and compares every line of both texts, so one changed line in a 3.5 MB file held the
 * event loop 44-67 ms. Each cut falls on a line boundary of both texts, which is where jsdiff ends a
 * token, so `oldText` and `newText` hold the tokens a whole-file diff would compare there. The shared
 * prefix is the one Myers' first snake follows, so the first change is where a whole-file diff puts it.
 * The shared suffix can move an insertion or deletion within a run of identical lines, as it does in GNU
 * diff and git. The context lines are framed around the diff rather than diffed, so an alignment cannot
 * reach into them and shorten a hunk's context.
 */
function changeSpan(oldContent: string, newContent: string, context: number): ChangeSpan {
	const prefix = lineStartAtOrBefore(oldContent, sharedPrefixLength(oldContent, newContent));

	let suffix = sharedSuffixLength(oldContent, newContent, Math.min(oldContent.length, newContent.length) - prefix);
	while (
		suffix > 0 &&
		!(startsLine(oldContent, oldContent.length - suffix) && startsLine(newContent, newContent.length - suffix))
	) {
		suffix--;
	}

	let start = prefix;
	for (let line = 0; line < context && start > 0; line++) start = lineStartAtOrBefore(oldContent, start - 1);
	let firstLine = 1;
	for (let at = oldContent.indexOf("\n"); at !== -1 && at < start; at = oldContent.indexOf("\n", at + 1)) firstLine++;

	const oldSuffixStart = oldContent.length - suffix;
	let kept = 0;
	for (let line = 0; line < context && kept < suffix; line++) {
		const end = oldContent.indexOf("\n", oldSuffixStart + kept);
		kept = end === -1 ? suffix : Math.min(suffix, end + 1 - oldSuffixStart);
	}

	return {
		before: oldContent.slice(start, prefix),
		oldText: oldContent.slice(prefix, oldSuffixStart),
		newText: newContent.slice(prefix, newContent.length - suffix),
		after: oldContent.slice(oldSuffixStart, oldSuffixStart + kept),
		firstLine,
	};
}

type LinePart = Pick<Diff.ChangeObject<string>, "value" | "added" | "removed">;

/** The row jsdiff writes after a hunk line that ends the file without a line break. */
const NO_NEWLINE_AT_END_OF_FILE = "\\ No newline at end of file";

/** The lines of a span's `before` or `after` text, without their line breaks. */
function contextRowLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export async function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 2,
	source: BlockContextSource = {},
): Promise<DiffResult> {
	const span = changeSpan(oldContent, newContent, Math.max(0, contextLines));
	const parts: LinePart[] = diffPackage.value.diffLines(span.oldText, span.newText);
	if (span.before) parts.unshift({ value: span.before, added: false, removed: false });
	if (span.after) parts.push({ value: span.after, added: false, removed: false });
	const output: string[] = [];

	let oldLineNum = span.firstLine;
	let newLineNum = span.firstLine;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					output.push(formatNumberedDiffLine("+", newLineNum, line));
					newLineNum++;
				} else {
					output.push(formatNumberedDiffLine("-", oldLineNum, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				const contextLimit = Math.max(0, contextLines);
				let leadingSkip = 0;
				let middleSkip = 0;
				let trailingSkip = 0;
				let linesToShow: string[];

				if (lastWasChange && nextPartIsChange) {
					if (raw.length > contextLimit * 2) {
						const leadingContext = raw.slice(0, contextLimit);
						const trailingContext = raw.slice(raw.length - contextLimit);
						middleSkip = raw.length - leadingContext.length - trailingContext.length;
						linesToShow = leadingContext.concat(trailingContext);
					} else {
						linesToShow = raw;
					}
				} else if (nextPartIsChange) {
					leadingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(leadingSkip);
				} else {
					trailingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(0, contextLimit);
				}

				// Leading-skip placeholder is omitted: the first emitted line's
				// number already conveys that earlier lines were trimmed.
				if (leadingSkip > 0) {
					oldLineNum += leadingSkip;
					newLineNum += leadingSkip;
				}

				const firstChunkLength = middleSkip > 0 ? contextLimit : linesToShow.length;
				for (const line of linesToShow.slice(0, firstChunkLength)) {
					output.push(formatNumberedDiffLine(" ", oldLineNum, line));
					oldLineNum++;
					newLineNum++;
				}

				// Mid-skip placeholder is omitted too: the jump between the trailing
				// number of the leading context and the leading number of the
				// trailing context conveys the gap, just like leading/trailing skips.
				if (middleSkip > 0) {
					oldLineNum += middleSkip;
					newLineNum += middleSkip;
					for (const line of linesToShow.slice(firstChunkLength)) {
						output.push(formatNumberedDiffLine(" ", oldLineNum, line));
						oldLineNum++;
						newLineNum++;
					}
				}

				// Trailing-skip placeholder is omitted for the same reason: the
				// final emitted line's number tells the reader the file continues.
				if (trailingSkip > 0) {
					oldLineNum += trailingSkip;
					newLineNum += trailingSkip;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	await addMatchingBracketContextRows(output, oldContent, newContent, source);

	return { diff: output.join("\n"), firstChangedLine };
}

// ═══════════════════════════════════════════════════════════════════════════
// Replace Mode Logic
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplaceOptions {
	/** Allow fuzzy matching */
	fuzzy: boolean;
	/** Replace all occurrences */
	all: boolean;
	/** Similarity threshold for fuzzy matching */
	threshold?: number;
}

export interface ReplaceResult {
	/** The new content after replacements */
	content: string;
	/** Number of replacements made */
	count: number;
	/**
	 * The match search that found nothing to replace, set exactly when `count` is 0. Its closest
	 * candidate feeds the error, so the caller does not run the fuzzy search a second time.
	 */
	unmatched?: MatchOutcome;
}

/**
 * Generate a unified diff string without file headers.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export async function generateUnifiedDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 3,
	source: BlockContextSource = {},
): Promise<DiffResult> {
	const span = changeSpan(oldContent, newContent, Math.max(0, contextLines));
	const { hunks } = diffPackage.value.structuredPatch("", "", span.oldText, span.newText, "", "", {
		context: contextLines,
	});
	const before = contextRowLines(span.before);
	const after = contextRowLines(span.after);
	const lineOffset = span.firstLine + before.length - 1;
	const output: string[] = [];
	let firstChangedLine: number | undefined;
	for (let index = 0; index < hunks.length; index++) {
		const hunk = hunks[index];
		const lead = index === 0 ? before : [];
		const trail = index === hunks.length - 1 ? after : [];
		let oldLine = hunk.oldStart + lineOffset - lead.length;
		let newLine = hunk.newStart + lineOffset - lead.length;
		const framed = lead.length + trail.length;
		output.push(`@@ -${oldLine},${hunk.oldLines + framed} +${newLine},${hunk.newLines + framed} @@`);
		for (const line of lead) {
			output.push(formatNumberedDiffLine(" ", oldLine, line));
			oldLine++;
			newLine++;
		}
		for (const line of hunk.lines) {
			if (line.startsWith("-")) {
				if (firstChangedLine === undefined) firstChangedLine = newLine;
				output.push(formatNumberedDiffLine("-", oldLine, line.slice(1)));
				oldLine++;
				continue;
			}
			if (line.startsWith("+")) {
				if (firstChangedLine === undefined) firstChangedLine = newLine;
				output.push(formatNumberedDiffLine("+", newLine, line.slice(1)));
				newLine++;
				continue;
			}
			if (line.startsWith(" ")) {
				output.push(formatNumberedDiffLine(" ", oldLine, line.slice(1)));
				oldLine++;
				newLine++;
				continue;
			}
			output.push(line);
		}
		for (const line of trail) {
			output.push(formatNumberedDiffLine(" ", oldLine, line));
			oldLine++;
		}
		if (trail.length > 0 && !span.after.endsWith("\n")) output.push(NO_NEWLINE_AT_END_OF_FILE);
	}

	await addMatchingBracketContextRows(output, oldContent, newContent, source);

	return { diff: output.join("\n"), firstChangedLine };
}

const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const LINE_HINT_REGEX = /^lines?\s+(\d+)(?:\s*-\s*(\d+))?(?:\s*@@)?$/i;
const TOP_OF_FILE_REGEX = /^(top|start|beginning)\s+of\s+file$/i;
const EMPTY_HEADER_REGEX = /^@@\s*@@$/;
// `diff --git ` is git's own marker, not part of the apply-patch envelope, so it is
// added here rather than kept in the shared marker list.
const MULTI_FILE_MARKERS = [...FILE_OP_MARKERS, "diff --git "];
const DIFF_METADATA_PREFIXES = [
	...FILE_OP_MARKERS,
	"diff --git ",
	"index ",
	"--- ",
	"+++ ",
	"new file mode ",
	"deleted file mode ",
	"rename from ",
	"rename to ",
	"similarity index ",
	"dissimilarity index ",
	"old mode ",
	"new mode ",
];
const PATCH_WRAPPER_PREFIXES = PATCH_WRAPPER_MARKERS;
const MAX_OCCURRENCE_PREVIEWS = 5;

function isDiffContentLine(line: string): boolean {
	const firstChar = line[0];
	if (firstChar === " ") return true;
	if (firstChar === "+") {
		return !line.startsWith("+++ ");
	}
	if (firstChar === "-") {
		return !line.startsWith("--- ");
	}
	return false;
}

// `readonly` because this only reads: the shared marker lists are frozen tuples, and a
// mutable parameter type would have forced a copy at every call site to satisfy it.
function matchesTrimmedPrefix(line: string, prefixes: readonly string[]): boolean {
	return prefixes.some(prefix => line.startsWith(prefix));
}

function isPatchWrapperLine(line: string): boolean {
	return line === "***" || matchesTrimmedPrefix(line, PATCH_WRAPPER_PREFIXES);
}

function formatOccurrenceMatchError(
	occurrences: number,
	occurrencePreviews: string[] | undefined,
	path?: string,
): string {
	const previews = occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		occurrences > MAX_OCCURRENCE_PREVIEWS ? ` (showing first ${MAX_OCCURRENCE_PREVIEWS} of ${occurrences})` : "";
	const pathSuffix = path ? ` in ${path}` : "";
	return `Found ${occurrences} occurrences${pathSuffix}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

export function normalizeDiff(diff: string): string {
	let lines = diff.split("\n");

	while (lines.length > 0) {
		const lastLine = lines[lines.length - 1];
		if (lastLine === "" || (lastLine?.trim() === "" && !isDiffContentLine(lastLine ?? ""))) {
			lines = lines.slice(0, -1);
		} else {
			break;
		}
	}

	if (lines[0] && isPatchWrapperLine(lines[0].trim())) {
		lines = lines.slice(1);
	}
	if (lines.length > 0 && isPatchWrapperLine(lines[lines.length - 1]?.trim() ?? "")) {
		lines = lines.slice(0, -1);
	}

	lines = lines.filter(line => {
		if (isDiffContentLine(line)) {
			return true;
		}

		return !matchesTrimmedPrefix(line.trim(), DIFF_METADATA_PREFIXES);
	});

	return lines.join("\n");
}

export function normalizeCreateContent(content: string): string {
	const lines = content.split("\n");
	const nonEmptyLines = lines.filter(line => line.length > 0);

	if (nonEmptyLines.length > 0 && nonEmptyLines.every(line => line.startsWith("+ ") || line.startsWith("+"))) {
		return lines
			.map(line => {
				if (line.startsWith("+ ")) return line.slice(2);
				if (line.startsWith("+")) return line.slice(1);
				return line;
			})
			.join("\n");
	}

	return content;
}

function isUnifiedDiffMetadataLine(line: string): boolean {
	return matchesTrimmedPrefix(
		line,
		DIFF_METADATA_PREFIXES.filter(prefix => !prefix.startsWith("*** ")),
	);
}

interface ParseHunkResult {
	hunk: DiffHunk;
	linesConsumed: number;
}

/** A hunk's leading `@@` line: the change contexts and start lines it states. */
interface HunkHeader {
	changeContexts: string[];
	oldStartLine?: number;
	newStartLine?: number;
}

/**
 * Read a hunk's leading line: an empty `@@` marker, a unified `@@ -a,b +c,d @@` header, an `@@ ` line
 * hint, top-of-file marker or change context, or a bare `@@context`. Undefined for a line that does not
 * start with `@@`, which is the hunk's first body line.
 */
function parseHunkHeader(headerLine: string, lineNumber: number): HunkHeader | undefined {
	if (!headerLine.startsWith("@@")) return undefined;
	const headerTrimmed = headerLine.trimEnd();
	if (EMPTY_HEADER_REGEX.test(headerTrimmed)) {
		return { changeContexts: [] };
	}
	const unifiedHeader = parseUnifiedHunkHeader(headerTrimmed);
	if (unifiedHeader) {
		if (unifiedHeader.oldStart < 1 || unifiedHeader.newStart < 1) {
			throw new ParseError("Line numbers in @@ header must be >= 1", lineNumber);
		}
		return {
			changeContexts: unifiedHeader.changeContext ? [unifiedHeader.changeContext] : [],
			oldStartLine: unifiedHeader.oldStart,
			newStartLine: unifiedHeader.newStart,
		};
	}
	if (headerTrimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
		return parseChangeContextHeader(headerTrimmed.slice(CHANGE_CONTEXT_MARKER.length), lineNumber);
	}
	const contextValue = headerTrimmed.slice(2).trim();
	return { changeContexts: contextValue.length > 0 ? [contextValue] : [] };
}

/**
 * The text after an `@@ ` header: a `line N` hint, a top-of-file marker, or a change context. The text
 * follows `@@ ` on a right-trimmed line, so it is never blank.
 */
function parseChangeContextHeader(contextValue: string, lineNumber: number): HunkHeader {
	const trimmedContextValue = contextValue.trim();
	const normalizedContextValue = trimmedContextValue.replace(/^@@\s*/u, "");
	const lineHintMatch = normalizedContextValue.match(LINE_HINT_REGEX);
	if (lineHintMatch) {
		const startLine = Number(lineHintMatch[1]);
		if (startLine < 1) {
			throw new ParseError("Line hint must be >= 1", lineNumber);
		}
		return { changeContexts: [], oldStartLine: startLine, newStartLine: startLine };
	}
	if (TOP_OF_FILE_REGEX.test(normalizedContextValue)) {
		return { changeContexts: [], oldStartLine: 1, newStartLine: 1 };
	}
	return { changeContexts: [contextValue] };
}

/**
 * Skip the `@@ context` and bare `@@` lines after a header, collecting each context they state. Each line
 * is right-trimmed before the `@@ ` test, so a context it collects is never blank.
 */
function skipNestedContextMarkers(lines: string[], start: number, changeContexts: string[]): number {
	let index = start;
	while (index < lines.length && lines[index].startsWith("@@")) {
		const trimmed = lines[index].trimEnd();
		if (trimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
			changeContexts.push(trimmed.slice(CHANGE_CONTEXT_MARKER.length));
		} else if (trimmed !== EMPTY_CHANGE_CONTEXT_MARKER) {
			break;
		}
		index++;
	}
	return index;
}

/**
 * Add one body line to the hunk: an elision (`...`, `…`), a blank or ` ` context line, a `+` addition,
 * a `-` removal, or any other line as context. False for an `@@` line, which ends the hunk.
 */
function appendHunkLine(hunk: DiffHunk, line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "..." || trimmed === "…") {
		hunk.hasContextLines = true;
		return true;
	}
	switch (line.charAt(0)) {
		case "":
			hunk.hasContextLines = true;
			hunk.oldLines.push("");
			hunk.newLines.push("");
			return true;
		case " ":
			hunk.hasContextLines = true;
			hunk.oldLines.push(line.slice(1));
			hunk.newLines.push(line.slice(1));
			return true;
		case "+":
			hunk.newLines.push(line.slice(1));
			return true;
		case "-":
			hunk.oldLines.push(line.slice(1));
			return true;
		default:
			if (line.startsWith("@@")) return false;
			hunk.hasContextLines = true;
			hunk.oldLines.push(line);
			hunk.newLines.push(line);
			return true;
	}
}

/** Parse the hunk body that starts at `lines[start]`; returns how many lines it consumed. */
function parseHunkBody(hunk: DiffHunk, lines: string[], start: number, lineNumber: number): number {
	let parsedLines = 0;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		if (line === "" && parsedLines > 0 && lines[i + 1]?.trimStart().startsWith("@@")) {
			break;
		}
		if (line.startsWith(EOF_MARKER) && line.trimEnd() === EOF_MARKER) {
			if (parsedLines === 0) {
				throw new ParseError("Hunk does not contain any lines", lineNumber + 1);
			}
			hunk.isEndOfFile = true;
			return parsedLines + 1;
		}
		if (!appendHunkLine(hunk, line)) {
			if (parsedLines === 0) {
				throw new ParseError(
					`Unexpected line in hunk: '${line}'. Lines must start with ' ' (context), '+' (add), or '-' (remove)`,
					lineNumber + 1,
				);
			}
			break;
		}
		parsedLines++;
	}
	return parsedLines;
}

/**
 * Parse the hunk that starts at `lines[start]`. A hunk with no `@@` line starts at its first body line;
 * each line after the header up to the next hunk, the end-of-file marker or the end of the diff is body.
 */
function parseOneHunk(lines: string[], start: number): ParseHunkResult {
	const lineNumber = start + 1;
	const header = parseHunkHeader(lines[start], lineNumber);
	const changeContexts = header?.changeContexts ?? [];
	const bodyStart = skipNestedContextMarkers(lines, header ? start + 1 : start, changeContexts);
	if (bodyStart >= lines.length) {
		throw new ParseError("Hunk does not contain any lines", lineNumber + 1);
	}
	const hunk: DiffHunk = {
		changeContext: changeContexts.length > 0 ? changeContexts.join("\n") : undefined,
		oldStartLine: header?.oldStartLine,
		newStartLine: header?.newStartLine,
		hasContextLines: false,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
	};
	const parsedLines = parseHunkBody(hunk, lines, bodyStart, lineNumber);
	stripLineNumberPrefixes(hunk);
	return { hunk, linesConsumed: bodyStart + parsedLines - start };
}

function stripLineNumberPrefixes(hunk: DiffHunk): void {
	const allLines = hunk.oldLines.concat(hunk.newLines).filter(line => line.trim().length > 0);
	if (allLines.length < 2) return;

	const numberMatches = allLines
		.map(line => line.match(/^\s*(\d{1,6})\s+(.+)$/u))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (numberMatches.length < Math.max(2, Math.ceil(allLines.length * 0.6))) {
		return;
	}

	const numbers = numberMatches.map(match => Number(match[1]));
	let sequential = 0;
	for (let i = 1; i < numbers.length; i++) {
		if (numbers[i] === numbers[i - 1] + 1) {
			sequential++;
		}
	}

	if (numbers.length >= 3 && sequential < Math.max(1, numbers.length - 2)) {
		return;
	}

	const strip = (line: string): string => {
		const match = line.match(/^\s*\d{1,6}\s+(.+)$/u);
		return match ? match[1] : line;
	};

	hunk.oldLines = hunk.oldLines.map(strip);
	hunk.newLines = hunk.newLines.map(strip);
}

function countMultiFileMarkers(diff: string): number {
	const counts = new Map<string, number>();
	const paths = new Set<string>();
	const lines = diff.split("\n");
	for (const line of lines) {
		if (isDiffContentLine(line)) {
			continue;
		}
		const trimmed = line.trim();
		for (const marker of MULTI_FILE_MARKERS) {
			if (trimmed.startsWith(marker)) {
				const filePath = extractMarkerPath(trimmed);
				if (filePath) {
					paths.add(filePath);
				}
				counts.set(marker, (counts.get(marker) ?? 0) + 1);
				break;
			}
		}
	}
	if (paths.size > 0) {
		return paths.size;
	}
	let maxCount = 0;
	for (const count of counts.values()) {
		if (count > maxCount) {
			maxCount = count;
		}
	}
	return maxCount;
}

function extractMarkerPath(line: string): string | undefined {
	if (line.startsWith("diff --git ")) {
		const parts = line.split(/\s+/);
		const candidate = parts[3] ?? parts[2];
		if (!candidate) return undefined;
		return candidate.replace(/^(a|b)\//, "");
	}
	for (const marker of FILE_OP_MARKERS) {
		if (line.startsWith(marker)) return line.slice(marker.length).trim();
	}
	return undefined;
}

export function parseDiffHunks(diff: string): DiffHunk[] {
	const multiFileCount = countMultiFileMarkers(diff);
	if (multiFileCount > 1) {
		throw new ApplyPatchError(
			`Diff contains ${multiFileCount} file markers. Single-file patches cannot contain multi-file markers.`,
		);
	}

	const normalizedDiff = normalizeDiff(diff);
	const lines = normalizedDiff.split("\n");
	// The last non-blank line. An `@@` line there is a header with no body, which ends the diff.
	let lastContent = lines.length - 1;
	while (lastContent >= 0 && lines[lastContent].trim() === "") lastContent--;
	const hunks: DiffHunk[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "") {
			i++;
			continue;
		}

		const firstChar = line[0];
		const isDiffContent = firstChar === " " || firstChar === "+" || firstChar === "-";
		if (!isDiffContent && isUnifiedDiffMetadataLine(trimmed)) {
			i++;
			continue;
		}

		if (i === lastContent && trimmed.startsWith("@@")) {
			break;
		}

		const { hunk, linesConsumed } = parseOneHunk(lines, i);
		hunks.push(hunk);
		i += linesConsumed;
	}

	return hunks;
}

/**
 * Find and replace text in content using fuzzy matching.
 */
export function replaceText(content: string, oldText: string, newText: string, options: ReplaceOptions): ReplaceResult {
	if (oldText.length === 0) {
		throw new Error("oldText must not be empty.");
	}
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	let normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(oldText);
	const normalizedNewText = normalizeToLF(newText);
	let count = 0;

	if (options.all) {
		// Check for exact matches first
		const exactCount = normalizedContent.split(normalizedOldText).length - 1;
		if (exactCount > 0) {
			return {
				content: normalizedContent.split(normalizedOldText).join(normalizedNewText),
				count: exactCount,
			};
		}

		// No exact matches - try fuzzy matching iteratively
		let matchOutcome: MatchOutcome;
		while (true) {
			matchOutcome = findMatch(normalizedContent, normalizedOldText, {
				allowFuzzy: options.fuzzy,
				threshold,
			});

			const shouldUseClosest =
				options.fuzzy &&
				matchOutcome.closest &&
				matchOutcome.closest.confidence >= threshold &&
				(matchOutcome.fuzzyMatches === undefined || matchOutcome.fuzzyMatches <= 1);
			const match = matchOutcome.match || (shouldUseClosest ? matchOutcome.closest : undefined);
			if (!match) {
				break;
			}

			const adjustedNewText = adjustIndentation(normalizedOldText, match.actualText, normalizedNewText);
			if (adjustedNewText === match.actualText) {
				break;
			}
			normalizedContent =
				normalizedContent.substring(0, match.startIndex) +
				adjustedNewText +
				normalizedContent.substring(match.startIndex + match.actualText.length);
			count++;
		}

		return count === 0
			? { content: normalizedContent, count, unmatched: matchOutcome }
			: { content: normalizedContent, count };
	}

	// Single replacement mode
	const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
		allowFuzzy: options.fuzzy,
		threshold,
	});

	if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
		throw new Error(formatOccurrenceMatchError(matchOutcome.occurrences, matchOutcome.occurrencePreviews));
	}

	if (!matchOutcome.match) {
		return { content: normalizedContent, count: 0, unmatched: matchOutcome };
	}

	const match = matchOutcome.match;
	const adjustedNewText = adjustIndentation(normalizedOldText, match.actualText, normalizedNewText);
	normalizedContent =
		normalizedContent.substring(0, match.startIndex) +
		adjustedNewText +
		normalizedContent.substring(match.startIndex + match.actualText.length);

	return { content: normalizedContent, count: 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Preview/Diff Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the diff for an edit operation without applying it.
 * Used for preview rendering in the TUI before the tool executes.
 *
 * `options.streaming` marks a pass computed while the tool's arguments are
 * still arriving: the target file is then read through the preview cache, so a
 * stream of chunks against one large file reads it once instead of once per
 * chunk. The args-complete pass leaves it unset and reads fresh.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	options: { fuzzy?: boolean; all?: boolean; threshold?: number; streaming?: boolean } = {},
): Promise<DiffResult | DiffError> {
	const { fuzzy = true, all = false, threshold, streaming } = options;
	if (oldText.length === 0) {
		return { error: "oldText must not be empty." };
	}

	try {
		const absolutePath = resolveToCwd(path, cwd);
		let rawContent: string;
		try {
			rawContent = await readPreviewText(absolutePath, path, streaming);
		} catch (error) {
			const message = errorMessage(error);
			return { error: message || `Unable to read ${path}` };
		}
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(oldText);
		const normalizedNewText = normalizeToLF(newText);

		const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
			fuzzy,
			all,
			threshold,
		});

		if (result.unmatched) {
			const matchOutcome = result.unmatched;

			if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
				return {
					error: formatOccurrenceMatchError(matchOutcome.occurrences, matchOutcome.occurrencePreviews, path),
				};
			}

			return {
				error: EditMatchError.formatMessage(path, normalizedOldText, matchOutcome.closest, {
					allowFuzzy: fuzzy,
					threshold: threshold ?? DEFAULT_FUZZY_THRESHOLD,
					fuzzyMatches: matchOutcome.fuzzyMatches,
				}),
			};
		}

		if (normalizedContent === result.content) {
			return {
				error: `No changes would be made to ${path}. The replacement produces identical content.`,
			};
		}

		return await generateDiffString(normalizedContent, result.content, undefined, { path });
	} catch (err) {
		return { error: errorMessage(err) };
	}
}
