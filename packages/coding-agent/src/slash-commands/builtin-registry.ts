/**
 * The builtin slash commands, assembled.
 *
 * This module owns no handler body. Each domain declares its own in `builtin-<domain>.ts`, and the
 * domain a command belongs to is stated once, in `builtin-categories.ts`. What is left here is the
 * assembly and the lookups built from it, so adding a command touches its domain file and the
 * declarations, not a two-thousand-line object every command in the product shares.
 */
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest-commands";

import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { bareInvocationShowsSubcommands } from "./bare-subcommand";
import { BUILTIN_SLASH_COMMAND_CATEGORIES } from "./builtin-categories";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildProfileArgumentCompletions,
	buildSecretInlineHint,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
	secretArgumentCompletions,
} from "./builtin-completions";
import { CONTEXT_HANDLERS } from "./builtin-context";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
	type BuiltinSlashCommandName,
} from "./builtin-declarations";
import { INFO_HANDLERS } from "./builtin-info";
import { MODEL_HANDLERS } from "./builtin-model";
import { MODES_HANDLERS } from "./builtin-modes";
import { SESSION_HANDLERS } from "./builtin-session";
import { looksLikeOAuthCallback, SETUP_HANDLERS } from "./builtin-setup";
import { SHARE_HANDLERS } from "./builtin-share";
import { WORKSPACE_HANDLERS } from "./builtin-workspace";
import type { BuiltinSlashCommandHandlers, BuiltinSlashCommandRuntime, TuiBuiltinSlashCommand } from "./handler-types";
import { parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export { BUILTIN_SLASH_COMMAND_CATEGORIES } from "./builtin-categories";
export type { BuiltinSlashCommandRuntime, TuiBuiltinSlashCommand } from "./handler-types";
export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** Every builtin handler set, assembled from the eight domain modules. */
const BUILTIN_SLASH_COMMAND_HANDLERS: BuiltinSlashCommandHandlers = {
	...SETUP_HANDLERS,
	...MODES_HANDLERS,
	...SESSION_HANDLERS,
	...CONTEXT_HANDLERS,
	...SHARE_HANDLERS,
	...WORKSPACE_HANDLERS,
	...MODEL_HANDLERS,
	...INFO_HANDLERS,
};

/**
 * One command's declared surface joined to its handler.
 *
 * Written out property by property rather than spread, because the declarations are `as const` and
 * therefore deeply readonly, while `SlashCommandSpec` declares `aliases` and `subcommands` as mutable
 * arrays. Copying them is also the honest thing: a consumer that mutated a spec would otherwise be
 * mutating the shared declaration every other consumer reads.
 */
function toSlashCommandSpec(declaration: BuiltinSlashCommandDeclaration): SlashCommandSpec {
	const spec: SlashCommandSpec = {
		name: declaration.name,
		description: declaration.description,
		...BUILTIN_SLASH_COMMAND_HANDLERS[declaration.name as BuiltinSlashCommandName],
	};
	if (declaration.aliases) spec.aliases = Array.from(declaration.aliases);
	if (declaration.allowArgs !== undefined) spec.allowArgs = declaration.allowArgs;
	if (declaration.inlineHint !== undefined) spec.inlineHint = declaration.inlineHint;
	if (declaration.acpDescription !== undefined) spec.acpDescription = declaration.acpDescription;
	if (declaration.acpInputHint !== undefined) spec.acpInputHint = declaration.acpInputHint;
	if (declaration.bareAction !== undefined) spec.bareAction = declaration.bareAction;
	if (declaration.subcommands) spec.subcommands = declaration.subcommands.map(sub => ({ ...sub }));
	return spec;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> =
	BUILTIN_SLASH_COMMAND_DECLARATIONS.map(toSlashCommandSpec);

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

// Re-exported for the consumers that already take it from here. `extensibility` takes it from the
// declarations module directly, which is the point of the split: it wants the names, not the app.
export { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "./builtin-declarations";

/**
 * The browse order, owned by `./category-order.ts` and re-exported here because this is the name callers
 * already import. It moved because it is eight strings about presentation, and reaching it through this
 * module means importing every command implementation: the autocomplete paid 1,149 marginal modules for it.
 */
export { BUILTIN_SLASH_COMMAND_CATEGORY_ORDER } from "./category-order";

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
		category: BUILTIN_SLASH_COMMAND_CATEGORIES[command.name],
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	// `secret` completes the TERMINAL grammar, which is not the declaration's: `add` takes no name
	// here and `manager` is not declared at all, because the declared list is also what an ACP
	// client is told it may run and that client has no screen to open.
	if (cmd.name === "secret") {
		materialized.getArgumentCompletions = secretArgumentCompletions;
		materialized.getInlineHint = buildSecretInlineHint(cmd.inlineHint);
	} else if (cmd.subcommands) {
		materialized.getArgumentCompletions = buildArgumentCompletions(cmd.subcommands);
		// A command may declare both, and until this fell back it declared the static hint into a
		// void: the subcommand hint is null on an empty line, which is the one moment an operator
		// who has typed `/collab ` and nothing else needs to be told what may follow.
		const subcommandHint = buildSubcommandInlineHint(cmd.subcommands);
		const staticHint = cmd.inlineHint === undefined ? undefined : buildStaticInlineHint(cmd.inlineHint);
		materialized.getInlineHint = (argumentText: string) =>
			subcommandHint(argumentText) ?? staticHint?.(argumentText) ?? null;
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "profile") {
		materialized.getArgumentCompletions = buildProfileArgumentCompletions();
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		// A pasted OAuth redirect is swallowed rather than sent to the model: it carries a code, and
		// `?code=...` reaching a provider as a prompt is the one case where passing the text through
		// is worse than dropping it. Anything else with unexpected arguments is ordinary prose that
		// happens to start with a slash, so it goes on as a prompt.
		return looksLikeOAuthCallback(text);
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	// A bare `/cmd` with subcommands opens the picker instead of running the handler, unless the
	// declaration claimed the toggle exception. This sits in the DISPATCHER rather than in each
	// handler because the defect it prevents is invisible from inside one: `if (!verb || verb ===
	// "status")` reads as ordinary code, and only the declaration says `status` is a subcommand.
	if (command.subcommands && bareInvocationShowsSubcommands(command, parsed.args)) {
		const subcommands = command.subcommands;
		runtime.ctx.editor.setText("");
		runtime.ctx.showSubcommandPicker(command.name, subcommands, subcommand => {
			// A subcommand that declares a `usage` wants an argument, and running it with an empty
			// one is not what was picked. Prefill the editor instead and leave the cursor after the
			// space: the operator finishes the line and presses enter, which is the same keystroke
			// they would have made had they known the subcommand existed.
			if (subcommand.usage && subcommand.usage.trim().length > 0) {
				runtime.ctx.editor.setText(`/${command.name} ${subcommand.name} `);
				runtime.ctx.ui.requestRender();
				return;
			}
			// Dispatched as TEXT through this same function, so the picker runs exactly what typing
			// the subcommand runs. Resolving to a handler here would be a second implementation.
			void executeBuiltinSlashCommand(`/${command.name} ${subcommand.name}`, runtime);
		});
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await ctx.refreshSlashCommandState();
				await ctx.session.refreshSshTool({ activateIfAvailable: true });
			},
		};
		try {
			const result = await command.handle(parsed, adapted);
			ctx.editor.setText("");
			if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		} catch (error) {
			// Text transports must observe rejection, but the TUI owns the
			// diagnostic: follow-up and picker callbacks do not await dispatch.
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
