/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { Container, type Loader, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { highlightCode } from "../../../../theme/highlight";
import { theme } from "../../../../theme/theme-binding";
import type { OutputMeta } from "../../../../tools/core/output-notice";
import {
	buildExecutionFrame,
	buildStatusFooter,
	clampExecutionDisplayLine,
	createCollapsedPreview,
	EXECUTION_PREVIEW_LINES,
	type ExecutionColorKey,
	type ExecutionStatus,
	resolveExecutionStatus,
	StreamedOutputLines,
} from "./execution-shared";

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#output = new StreamedOutputLines(clampLines);
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#meta?: OutputMeta;
	#expanded = false;
	#contentContainer: Container;

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: ExecutionColorKey): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 2, 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		this.#contentContainer.addChild(this.#formatHeader(colorKey));
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the cell completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		this.#output.push(chunk);
		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; meta?: OutputMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#meta = options?.meta;
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
	#updateDisplay(): void {
		const availableLines = this.#output.lines();
		const previewLogicalLines = availableLines.slice(-EXECUTION_PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		const colorKey: ExecutionColorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 2, 0));
			} else {
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
				meta: this.#meta,
				hiddenLineCount,
				droppedLineCount: this.#output.dropped(),
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		// The authoritative output replaces whatever streaming kept, so nothing is missing any more.
		this.#output.replace(clean ? clampLines(clean.split("\n")) : []);
	}

	getOutput(): string {
		return this.#output.lines().join("\n");
	}

	getCode(): string {
		return this.code;
	}
}

function clampLines(lines: string[]): string[] {
	return lines.map(line => clampExecutionDisplayLine(line));
}
