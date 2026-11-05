import { errorMessage } from "@veyyon/utils";
import { runTodoCommand, type TodoEditorResult } from "../../../slash-commands/helpers/todo";
import { copyToClipboard } from "../../../utils/clipboard";
import { editInTerminal, getEditorCommand, NO_EDITOR_CONFIGURED } from "../../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 8 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type TodoCommandControllerContext = Pick<
	InteractiveModeContext,
	"agent" | "session" | "sessionManager" | "setTodos" | "showError" | "showStatus" | "showWarning" | "ui"
>;

/** `/todo` in the TUI: {@link runTodoCommand} with the todo panel, the clipboard and `$EDITOR`. */
export class TodoCommandController {
	constructor(private readonly ctx: TodoCommandControllerContext) {}

	async handleTodoCommand(args: string): Promise<void> {
		const outcome = await runTodoCommand(args, {
			session: this.ctx.session,
			agent: this.ctx.agent,
			sessionManager: this.ctx.sessionManager,
			showTodos: phases => this.ctx.setTodos(phases),
			copy: copyToClipboard,
			editMarkdown: markdown => this.#editMarkdown(markdown),
		});
		if (outcome.level === "error") this.ctx.showError(outcome.message);
		else if (outcome.level === "warning") this.ctx.showWarning(outcome.message);
		else this.ctx.showStatus(outcome.message);
	}

	async #editMarkdown(markdown: string): Promise<TodoEditorResult> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) return { notice: NO_EDITOR_CONFIGURED };
		try {
			const saved = await editInTerminal(this.ctx.ui, editorCmd, markdown, { extension: ".todo.md" });
			return saved === null ? { notice: "Editor exited without saving; todos unchanged." } : { saved };
		} catch (error) {
			return { notice: `Failed to open external editor: ${errorMessage(error)}` };
		}
	}
}
