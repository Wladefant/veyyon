/**
 * The types the builtin command handlers are written against.
 *
 * Types only, so a domain file and the registry share one definition of what a handler set may
 * contain without either importing the other.
 */
import type { AutocompleteItem } from "@veyyon/utils/autocomplete";
import type { BUILTIN_SLASH_COMMAND_DECLARATIONS, BuiltinSlashCommandName } from "./builtin-declarations";
import type { BuiltinSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

export type DeclarationNamed<Name extends BuiltinSlashCommandName> = Extract<
	(typeof BUILTIN_SLASH_COMMAND_DECLARATIONS)[number],
	{ readonly name: Name }
>;

/**
 * What one command's handler set may contain, decided by whether its DECLARATION says `textMode`.
 *
 * `textMode: true` means an ACP or RPC client can drive the command, and three consumers read that
 * flag to answer "which commands may a text client see": the ACP advertisement, the reserved-name set
 * that keeps an extension from shadowing a builtin, and the available-commands list. Those consumers
 * used to answer it here instead, with `command.handle !== undefined`, which cost them all 67 handler
 * bodies and the application behind them.
 *
 * Moving the question to the declaration would ordinarily create a second place to keep in sync, so
 * this type removes the choice: a declared `textMode` REQUIRES `handle`, and its absence FORBIDS
 * `handle` with `never`. Adding a text-mode handler without declaring the flag, or declaring the flag
 * without writing the handler, are both compile errors, so the flag cannot drift from the fact it
 * stands for.
 */
export type HandlerSetFor<Name extends BuiltinSlashCommandName> =
	DeclarationNamed<Name> extends { readonly textMode: true }
		? Required<Pick<SlashCommandSpec, "handle">> &
				Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription">
		: Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription"> & { readonly handle?: never };

/**
 * What each builtin command DOES, keyed by the name it is declared under.
 *
 * The declarations live in `builtin-declarations.ts`, which imports nothing; a handler body reaches
 * the whole application, which is why the two halves are separate files. The record is keyed by
 * `BuiltinSlashCommandName`, the union derived from the declaration array, so a handler for a command
 * that does not exist and a command with no handler are both COMPILE ERRORS rather than something a
 * test has to notice. Each domain file satisfies `Partial` of this type, which rejects an unknown
 * name there; `builtin-registry.ts` annotates the assembled whole with it, which rejects a missing one.
 */
export type BuiltinSlashCommandHandlers = { [Name in BuiltinSlashCommandName]: HandlerSetFor<Name> };
