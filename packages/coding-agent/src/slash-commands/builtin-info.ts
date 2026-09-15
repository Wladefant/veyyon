/**
 * Handlers for the `info` builtin slash commands.
 *
 * Split out of `builtin-registry.ts`, which is now the composition root: it imports the eight
 * domain maps and assembles them. The domain a command belongs to is decided in one place,
 * `categories.ts`, and `test/slash-commands/a-builtin-lives-in-the-domain-it-is-categorised-under.test.ts`
 * fails when this file and that map disagree, so the two cannot drift.
 */
import { CHANGELOG_URL } from "@veyyon/utils";
import { argumentHandlerTui } from "./builtin-shared";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import { commandConsumed } from "./helpers/parse";

/** What the info builtins DO, keyed by the name each is declared under. */
export const INFO_HANDLERS = {
	changelog: {
		handle: async (_command, runtime) => {
			await runtime.output(`Release notes: ${CHANGELOG_URL}`);
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleChangelogCommand();
			runtime.ctx.editor.setText("");
		},
	},
	hotkeys: {
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	omfg: { handleTui: argumentHandlerTui((ctx, complaint) => ctx.handleOmfgCommand(complaint)) },
	debug: {
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
