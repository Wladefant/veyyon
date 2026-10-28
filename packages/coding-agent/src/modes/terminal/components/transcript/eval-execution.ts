/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { highlightCode } from "../../../../theme/highlight";
import { theme } from "../../../../theme/theme-binding";
import { clampExecutionDisplayLine, ExecutionBlockComponent, type ExecutionColorKey } from "./execution-shared";

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends ExecutionBlockComponent {
	constructor(
		private readonly code: string,
		ui: TUI,
		excludeFromContext = false,
		language: EvalExecutionLanguage = "python",
	) {
		const colorKey: ExecutionColorKey = excludeFromContext ? "dim" : "pythonMode";
		super({
			ui,
			colorKey,
			header: () => formatHeader(code, language, colorKey),
			sanitize: sanitizeText,
			clampLines: lines => lines.map(line => clampExecutionDisplayLine(line)),
		});
	}

	getCode(): string {
		return this.code;
	}
}

/** The cell's code, highlighted, behind a `>>>` prompt and indented continuation lines. */
function formatHeader(code: string, language: EvalExecutionLanguage, colorKey: ExecutionColorKey): Text {
	const prompt = theme.fg(colorKey, theme.bold(">>>"));
	const continuation = theme.fg(colorKey, "    ");
	const codeLines = highlightCode(code, language === "js" ? "javascript" : "python");
	const headerLines = codeLines.map((line, index) => (index === 0 ? `${prompt} ${line}` : `${continuation}${line}`));
	return new Text(headerLines.join("\n"), 2, 0);
}
