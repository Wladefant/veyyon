/**
 * Shared rendering primitives for bash/eval execution components.
 *
 * Each helper isolates a piece of structure both components share verbatim
 * (frame layout, collapsed preview, post-run status line). Differences in
 * how each component prepares its header, output lines, or sixel masking
 * stay in their respective files.
 */

import { Ellipsis } from "@veyyon/natives";
import { type Component, Container, Loader, Text, type TUI } from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { getSymbolTheme } from "../../../../theme/symbol-theme";
import { theme } from "../../../../theme/theme-binding";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../../../tools/core/output-notice";
import { expandHintSuffix } from "../../utils/key-hint";
import { truncateToVisualLines } from "./visual-truncate";

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error";

/**
 * Output rows an execution block shows before it is expanded.
 *
 * Deliberately not one of `PREVIEW_LIMITS.OUTPUT_*` and not `DEFAULT_TERMINAL_PREVIEW_LINES`. Those describe how
 * a FINISHED tool result is summarised in the transcript, three rows collapsed and ten expanded. This is a live
 * block a user is watching run, so it keeps a screenful: the point of watching is to see the output scroll, and
 * three rows of a build log is not watching anything. Both components declared it as their own `PREVIEW_LINES`.
 */
export const EXECUTION_PREVIEW_LINES = 20;

/**
 * Widest single output line an execution block draws, in terminal COLUMNS.
 *
 * The unit is the whole point and it is where the two copies of this had diverged. Both declared
 * `MAX_DISPLAY_LINE_CHARS = 4000`, but bash measured `visibleWidth` and eval measured `line.length`, so the
 * same named limit meant two different things:
 *
 * - `line.length` counts ANSI escape bytes. Eval output is syntax-highlighted, so a styled line was charged for
 *   invisible colour codes and truncated while it still displayed far short of the limit.
 * - `line.length` counts a wide character as one. Two thousand CJK characters occupy 4000 columns and would
 *   overflow, yet measured 2000 and passed through untouched.
 * - `line.slice(4000)` cuts wherever 4000 code units land, which can be the middle of an escape sequence or of a
 *   surrogate pair, so the fragment reaches the terminal and the styling of everything after it is undefined.
 *
 * The column measurement is the correct one, so it is the one that survives here.
 */
export const EXECUTION_MAX_DISPLAY_COLUMNS = 4_000;

/**
 * Retained output lines during streaming, after which the oldest are dropped.
 *
 * Five screenfuls, so expanding a block that is still running still shows more than the collapsed view had. The
 * bound exists because a build or a test run emits tens of thousands of lines and a component that kept them all
 * would grow without limit while the user watched.
 *
 * `bash-execution.ts` had this and `eval-execution.ts` did not, so a long-running eval cell grew unbounded.
 */
export const EXECUTION_STREAMING_LINE_CAP = EXECUTION_PREVIEW_LINES * 5;

/**
 * Streamed text an execution block holds before folding it, in UTF-16 units. A fold runs when the lines are
 * read; a stream that outpaces the reads folds once it holds this much, so held text stays bounded.
 */
const PENDING_FOLD_LENGTH = 1 << 20;

/**
 * The streamed output an execution block keeps: the last {@link EXECUTION_STREAMING_LINE_CAP} lines, and a
 * count of every line before them.
 *
 * Chunks are held as they arrive and folded when the lines are read, so a burst costs one fold and no chunk is
 * skipped. A fold splits and clamps only the lines the cap keeps and counts the newlines of the rest, so its
 * cost does not grow with lines that are about to be dropped. The count is reported separately from the
 * hidden-line hint: hidden lines are still held, dropped lines are gone.
 */
export class StreamedOutputLines {
	#lines: string[] = [];
	#dropped = 0;
	/** Chunks not yet folded into `#lines`, oldest first. */
	#pending: string[] = [];
	#pendingLength = 0;
	readonly #clampLines: (lines: string[]) => string[];

	/** `clampLines` clamps freshly split lines for display, returning one line for each it receives. */
	constructor(clampLines: (lines: string[]) => string[]) {
		this.#clampLines = clampLines;
	}

	push(chunk: string): void {
		if (!chunk) return;
		this.#pending.push(chunk);
		this.#pendingLength += chunk.length;
		if (this.#pendingLength > PENDING_FOLD_LENGTH) this.#fold();
	}

	/** The kept lines, oldest first. */
	lines(): readonly string[] {
		this.#fold();
		return this.#lines;
	}

	/** Lines streamed before the kept ones. */
	dropped(): number {
		this.#fold();
		return this.#dropped;
	}

	/** Replace the stream with the authoritative output: held chunks are discarded and nothing is dropped. */
	replace(lines: string[]): void {
		this.#pending = [];
		this.#pendingLength = 0;
		this.#lines = lines;
		this.#dropped = 0;
	}

	#fold(): void {
		const chunks = this.#pending;
		if (chunks.length === 0) return;
		this.#pending = [];
		this.#pendingLength = 0;

		// Find the newline that opens the last EXECUTION_STREAMING_LINE_CAP lines, walking back from the end.
		let need = EXECUTION_STREAMING_LINE_CAP;
		let chunkIndex = chunks.length;
		let cut = -1;
		while (need > 0 && chunkIndex > 0) {
			const chunk = chunks[--chunkIndex];
			let from = chunk.length - 1;
			while (need > 0 && from >= 0) {
				const at = chunk.lastIndexOf("\n", from);
				if (at === -1) break;
				if (--need === 0) cut = at;
				from = at - 1;
			}
		}

		if (cut === -1) {
			this.#appendLines(chunks.join("").split("\n"));
			return;
		}

		// Every line before the cut, and every line already kept, falls to the cap: count them, never split them.
		let newlinesBefore = countNewlines(chunks[chunkIndex], cut);
		for (let index = 0; index < chunkIndex; index++) {
			const chunk = chunks[index];
			newlinesBefore += countNewlines(chunk, chunk.length);
		}
		// The kept partial line merges with the first streamed line, so it falls with the lines before the cut.
		const linesBefore = this.#lines.length === 0 ? 0 : this.#lines.length - 1;
		this.#dropped += linesBefore + newlinesBefore + 1;
		const kept = chunks[chunkIndex].slice(cut + 1) + chunks.slice(chunkIndex + 1).join("");
		this.#lines = this.#clampLines(kept.split("\n"));
	}

	/** Append fewer than EXECUTION_STREAMING_LINE_CAP + 1 lines, the first continuing the kept partial line. */
	#appendLines(incoming: string[]): void {
		const lines = this.#lines;
		const merged = lines.length > 0 ? [lines.pop() + incoming[0], ...incoming.slice(1)] : incoming;
		for (const line of this.#clampLines(merged)) lines.push(line);
		if (lines.length > EXECUTION_STREAMING_LINE_CAP) {
			const dropped = lines.length - EXECUTION_STREAMING_LINE_CAP;
			lines.splice(0, dropped);
			this.#dropped += dropped;
		}
	}
}

/** Newlines in `text` before `end`. */
function countNewlines(text: string, end: number): number {
	let count = 0;
	for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

/**
 * Clamp one output line to {@link EXECUTION_MAX_DISPLAY_COLUMNS} display columns, with a note saying how much
 * was dropped.
 *
 * The count in the note is columns, matching what was measured, so a user comparing it against a wrapped
 * terminal sees a number that corresponds to what they are looking at.
 */
export function clampExecutionDisplayLine(line: string): string {
	const visible = visibleWidth(line);
	if (visible <= EXECUTION_MAX_DISPLAY_COLUMNS) return line;
	const omitted = visible - EXECUTION_MAX_DISPLAY_COLUMNS;
	return `${truncateToWidth(line, EXECUTION_MAX_DISPLAY_COLUMNS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
}

/** Theme color keys valid for an execution frame. */
export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

/**
 * Build the content container + loader scaffold that bash and eval execution
 * components share. The caller appends the header (command vs `>>>` prompt) and
 * the returned loader to `contentContainer` so per-mode order is preserved. No
 * full-width border rules: the V1 aligned-quiet merge sits execution blocks on
 * the transcript's shared left rail — the mode color lives on the `$`/`>>>`
 * header, and two full-bleed rules around two short lines read as chrome
 * shouting over content.
 */
export function buildExecutionFrame(
	parent: Container,
	ui: TUI,
	colorKey: ExecutionColorKey,
): { contentContainer: Container; loader: Loader } {
	const contentContainer = new Container();
	parent.addChild(contentContainer);

	const loader = new Loader(
		ui,
		spinner => theme.fg(colorKey, spinner),
		text => theme.fg("muted", text),
		`Running… (esc to cancel)`,
		getSymbolTheme().spinnerFrames,
	);

	return { contentContainer, loader };
}

/**
 * Wrap a styled preview block in a render-time visual-line truncator.
 * Recomputed per render width so wrapping stays in sync with terminal size.
 */
export function createCollapsedPreview(previewText: string, previewLines: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, 2).visualLines,
		invalidate: () => {},
	};
}

/**
 * Build the post-run status block (hidden-line hint, exit/cancel marker,
 * truncation notice). Returns undefined when there is nothing to display so
 * callers can skip appending a stray Text child.
 */
export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	signal?: string | undefined;
	truncation: TruncationMeta | undefined;
	hiddenLineCount: number;
	/**
	 * Lines dropped from the front of the buffer by {@link capExecutionOutputLines}.
	 *
	 * Reported separately from `hiddenLineCount` and in a warning colour, because the two are different facts and
	 * conflating them would be a lie. Hidden lines are still held and expanding reveals them; dropped lines are
	 * gone, and a hint that says "ctrl+o to expand" would promise something that cannot happen.
	 */
	droppedLineCount?: number;
	/** Suppress the "… N more lines" hint (used when sixel passthrough renders the full output). */
	suppressHiddenCount?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if ((opts.droppedLineCount ?? 0) > 0) {
		parts.push(theme.fg("warning", `… ${opts.droppedLineCount} earlier lines dropped while streaming`));
	}
	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		// The gesture is `app.tools.expand`, which is remappable, so the hint is read
		// rather than written out. The COUNT is stated either way: a block that hid
		// eighty lines silently reads as a block that had none.
		parts.push(theme.fg("dim", `… ${formatMoreLines(opts.hiddenLineCount)}${expandHintSuffix()}`));
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.signal !== undefined) {
		parts.push(theme.fg("error", `(killed by signal ${opts.signal})`));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	}
	if (opts.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.truncation)));
	}

	if (parts.length === 0) return undefined;
	return new Text(`\n${parts.join("\n")}`, 2, 0);
}

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
