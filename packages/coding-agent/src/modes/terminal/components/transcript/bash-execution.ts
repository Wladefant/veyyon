/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, ImageProtocol, type Loader, TERMINAL, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { theme } from "../../../../theme/theme-binding";
import type { TruncationMeta } from "../../../../tools/core/output-notice";
import {
	getSixelLineMask,
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
} from "../../../../utils/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	clampExecutionDisplayLine,
	createCollapsedPreview,
	EXECUTION_PREVIEW_LINES,
	type ExecutionStatus,
	resolveExecutionStatus,
	StreamedOutputLines,
} from "./execution-shared";

export class BashExecutionComponent extends Container {
	#output = new StreamedOutputLines(clampLinesPreservingSixel);
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#signal?: string;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#displayDirty = false;
	#contentContainer: Container;
	#headerText: Text;

	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		super();

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		// Command header
		this.#headerText = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 2, 0);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the command completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
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

		// Stop loader
		this.#loader.stop();

		this.#updateDisplay();
	}

	setOutput(output: string): void {
		this.#setOutput(output);
		this.#updateDisplay();
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

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-EXECUTION_PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;
		const sixelLineMask =
			TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;

		// Rebuild content container
		this.#contentContainer.clear();

		// Command header
		this.#contentContainer.addChild(this.#headerText);

		// Output
		if (availableLines.length > 0) {
			if (this.#expanded || hasSixelOutput) {
				const displayText = availableLines
					.map((line, index) => (sixelLineMask?.[index] ? line : theme.fg("muted", line)))
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 2, 0));
			} else {
				// Use shared visual truncation utility, recomputed per render width
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, EXECUTION_PREVIEW_LINES));
			}
		}

		// Loader or status
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
				suppressHiddenCount: hasSixelOutput,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		// The authoritative output replaces whatever streaming kept, so nothing is missing any more.
		this.#output.replace(clean ? clampLinesPreservingSixel(clean.split("\n")) : []);
	}

	/** The output kept for display: the streamed tail while running, all of it once the final output arrives. */
	getOutput(): string {
		return this.#output.lines().join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}

function clampLinesPreservingSixel(lines: string[]): string[] {
	if (lines.length === 0) return [];
	const sixelLineMask = getSixelLineMask(lines);
	if (!sixelLineMask.some(Boolean)) {
		return lines.map(line => clampExecutionDisplayLine(line));
	}
	return lines.map((line, index) => (sixelLineMask[index] ? line : clampExecutionDisplayLine(line)));
}
