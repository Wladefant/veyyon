/**
 * The bash and eval execution blocks: {@link ExecutionBlockComponent} and the rendering primitives it draws with.
 *
 * Both blocks stream output, fold it on draw, preview its tail, and settle with a status footer through the one
 * class below. What differs between them is passed in: the header (`$ command` vs the highlighted `>>>` cell),
 * how output is sanitized and clamped, and which rows draw raw (sixel images in the bash block).
 */

import { Ellipsis } from "@veyyon/natives";
import { type Component, Container, Loader, Text, type TUI } from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { getSymbolTheme } from "../../../../theme/symbol-theme";
import { theme } from "../../../../theme/theme-binding";
import {
	formatColumnTruncatedNotice,
	formatTruncationMetaNotice,
	type OutputMeta,
} from "../../../../tools/core/output-notice";
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
function buildExecutionFrame(
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
function createCollapsedPreview(previewText: string, previewLines: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, 2).visualLines,
		invalidate: () => {},
	};
}

/**
 * Build the post-run status block (hidden-line hint, exit/cancel marker,
 * truncation and column-cap notices). Returns undefined when there is nothing to display so
 * callers can skip appending a stray Text child.
 */
export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	signal?: string | undefined;
	/** The run's output metadata: its window truncation and its per-line column cap. */
	meta: OutputMeta | undefined;
	hiddenLineCount: number;
	/**
	 * Lines dropped from the front of the buffer by {@link capExecutionOutputLines}.
	 *
	 * Reported separately from `hiddenLineCount` and in a warning colour, because the two are different facts and
	 * conflating them would be a lie. Hidden lines are still held and expanding reveals them; dropped lines are
	 * gone, and a hint that says "ctrl+o to expand" would promise something that cannot happen.
	 */
	droppedLineCount?: number;
}): Text | undefined {
	const parts: string[] = [];

	if ((opts.droppedLineCount ?? 0) > 0) {
		parts.push(theme.fg("warning", `… ${opts.droppedLineCount} earlier lines dropped while streaming`));
	}
	if (opts.hiddenLineCount > 0) {
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
	if (opts.meta?.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.meta.truncation)));
	}
	const columnNotice = opts.meta && formatColumnTruncatedNotice(opts.meta);
	if (columnNotice) {
		parts.push(theme.fg("warning", columnNotice));
	}

	if (parts.length === 0) return undefined;
	return new Text(`\n${parts.join("\n")}`, 2, 0);
}

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}

/** What one kind of execution block supplies to {@link ExecutionBlockComponent}. */
export interface ExecutionBlockConfig {
	ui: TUI;
	colorKey: ExecutionColorKey;
	/** The header line(s). Built with the block and again after `invalidate()`, so a theme change reaches it. */
	header: () => Text;
	/** Applied to the final output before it replaces the streamed lines. */
	sanitize: (text: string) => string;
	/** Clamps freshly split lines for display, returning one line for each it receives. */
	clampLines: (lines: string[]) => string[];
	/**
	 * Which kept lines draw as they are rather than dimmed, or undefined when none can. A block holding such a
	 * line shows its whole output, since a raw row (a sixel image) cut by the preview would draw garbage.
	 */
	rawLineMask?: (lines: readonly string[]) => boolean[] | undefined;
}

/**
 * A command or cell run from the composer, with its streamed output and post-run status.
 *
 * Streamed chunks are held until the next draw, so a burst of chunks costs one fold and one rebuild, and the
 * header is built once rather than on every chunk.
 */
export class ExecutionBlockComponent extends Container {
	readonly #config: ExecutionBlockConfig;
	readonly #output: StreamedOutputLines;
	readonly #contentContainer: Container;
	readonly #loader: Loader;
	#header: Text | undefined;
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined;
	#signal: string | undefined;
	#truncation: TruncationMeta | undefined;
	#expanded = false;
	#displayDirty = false;

	constructor(config: ExecutionBlockConfig) {
		super();
		this.#config = config;
		this.#output = new StreamedOutputLines(config.clampLines);
		const { contentContainer, loader } = buildExecutionFrame(this, config.ui, config.colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;
		this.#header = config.header();
		this.#contentContainer.addChild(this.#header);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed streaming preview rewrites its tail
	 * window every chunk, so the block stays out of native scrollback until the run completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	/** Show the full output (`true`) or the preview of its tail. */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#header = undefined;
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Held until the next draw, so a burst of chunks costs one fold.
		this.#output.push(chunk);
		this.#displayDirty = true;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta; signal?: string },
	): void {
		this.#exitCode = exitCode;
		this.#signal = options?.signal;
		this.#status = options?.signal !== undefined ? "error" : resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}
		this.#loader.stop();
		this.#updateDisplay();
	}

	setOutput(output: string): void {
		this.#setOutput(output);
		this.#updateDisplay();
	}

	/** The output kept for display: the streamed tail while running, all of it once the final output arrives. */
	getOutput(): string {
		return this.#output.lines().join("\n");
	}

	override render(width: number): readonly string[] {
		if (this.#displayDirty) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#updateDisplay(): void {
		const availableLines = this.#output.lines();
		const rawLineMask = this.#config.rawLineMask?.(availableLines);
		const hasRawLines = rawLineMask?.some(Boolean) ?? false;
		// A block holding a raw line draws all of it, as an expanded one does, and then nothing is hidden.
		const showsAll = this.#expanded || hasRawLines;
		const previewLogicalLines = showsAll ? availableLines : availableLines.slice(-EXECUTION_PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();
		this.#header ??= this.#config.header();
		this.#contentContainer.addChild(this.#header);

		if (availableLines.length > 0) {
			if (showsAll) {
				const displayText = availableLines
					.map((line, index) => (rawLineMask?.[index] ? line : theme.fg("muted", line)))
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 2, 0));
			} else {
				// Visual truncation, recomputed per render width.
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, EXECUTION_PREVIEW_LINES));
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				signal: this.#signal,
				truncation: this.#truncation,
				hiddenLineCount,
				droppedLineCount: this.#output.dropped(),
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = this.#config.sanitize(output);
		// The authoritative output replaces whatever streaming kept, so nothing is missing any more.
		this.#output.replace(clean ? this.#config.clampLines(clean.split("\n")) : []);
	}
}
