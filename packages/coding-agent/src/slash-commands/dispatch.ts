/**
 * Reaching a builtin slash command without loading every builtin to find out whether there is one.
 *
 * Most keystrokes that arrive here are not a builtin at all: ordinary prompt text, an extension
 * command, a plugin namespace. Deciding that took the whole registry, because the decision was
 * `BUILTIN_SLASH_COMMAND_LOOKUP.get(name)` and the lookup is built from every handler body in the
 * product. Importing it from the two hot callers cost the launch graph 98 modules and the editable
 * input path 240.
 *
 * The declarations answer the same question for free. `BUILTIN_SLASH_COMMAND_RESERVED_NAMES` is
 * built from the same array the registry keys its lookup by, over `command.name` plus
 * `command.aliases`, so the set of names that reach a handler here and the set that reached one
 * before are the same set: a miss returns `false` exactly as the registry's own miss did. The
 * registry loads only once a name has already matched, which is the case where its cost was going
 * to be paid anyway.
 */
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "./builtin-declarations";
import type { BuiltinSlashCommandRuntime } from "./handler-types";
import { parseSlashCommand } from "./helpers/parse";

/**
 * Run `text` as a builtin slash command if it names one.
 *
 * Returns `false` when no builtin matched, `true` when the command consumed the input entirely, and
 * a `string` when the command was handled but the remaining text should be sent as a prompt — the
 * contract `executeBuiltinSlashCommand` has, because on a match this is that function.
 */
export async function dispatchBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	if (!BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(parsed.name)) return false;
	// Lazy by design, and the reason this module exists: a static import here would pull every
	// handler body into the caller, which is the cost the name check above was written to avoid.
	const { executeBuiltinSlashCommand } = await import("./builtin-registry");
	return await executeBuiltinSlashCommand(text, runtime);
}
