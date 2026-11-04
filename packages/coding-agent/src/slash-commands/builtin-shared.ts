/**
 * The builtin-command helpers more than one domain uses.
 *
 * A helper used by exactly one domain lives in that domain's file; only these two are shared, so
 * this file stays small by construction rather than by discipline.
 */
import type { InteractiveModeContext } from "../modes/terminal/types";
import type { ParsedSlashCommand, TuiSlashCommandHostContext, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: Pick<InteractiveModeContext, "statusLine" | "ui">): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/** A TUI handler that clears the composer and hands the trimmed text after the command name to `dispatch`. */
export function argumentHandlerTui(
	dispatch: (ctx: TuiSlashCommandHostContext, text: string) => Promise<void>,
): (command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime) => Promise<void> {
	return async (command, runtime) => {
		const text = command.text.slice(`/${command.name}`.length).trim();
		runtime.ctx.editor.setText("");
		await dispatch(runtime.ctx, text);
	};
}
