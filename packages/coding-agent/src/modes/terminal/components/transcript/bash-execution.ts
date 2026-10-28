/**
 * Component for displaying bash command execution with streaming output.
 */

import { ImageProtocol, TERMINAL, Text, type TUI } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { theme } from "../../../../theme/theme-binding";
import {
	getSixelLineMask,
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
} from "../../../../utils/sixel";
import { clampExecutionDisplayLine, ExecutionBlockComponent } from "./execution-shared";

export class BashExecutionComponent extends ExecutionBlockComponent {
	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		// Dim header for excluded-from-context commands (`!!` prefix).
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		super({
			ui,
			colorKey,
			header: () => new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 2, 0),
			sanitize: output => sanitizeWithOptionalSixelPassthrough(output, sanitizeText),
			clampLines: clampLinesPreservingSixel,
			rawLineMask: lines =>
				TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled()
					? getSixelLineMask(lines)
					: undefined,
		});
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
