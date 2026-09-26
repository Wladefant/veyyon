import { describe, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@veyyon/utils/autocomplete";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
} from "../src/slash-commands/builtin-declarations";

/**
 * WHY THIS SUITE EXISTS:
 * The newer `/queue` command is registered before `/quit`, and both share the `q`
 * prefix. Typing `/q` + Enter would sync-complete to `/queue` instead of `/quit`.
 * Adding the `q` alias to `/quit` allows quick exit, but requires exact alias
 * priority in autocomplete so `/q` resolves to `quit` rather than `queue`.
 *
 * WHAT THIS SUITE CLOSES:
 * The builtin `quit` command must declare the `q` alias, reserve it against
 * extension collision, and sync-complete `/q` to `q` rather than `/queue`.
 *
 * GAPS LEFT OPEN:
 * TUI keybindings and escape handling for quitting are tested in host-specific suites.
 */
describe("quit command alias completes cleanly", () => {
	it("declares and reserves the 'q' alias for the quit command", () => {
		const quitDecl = BUILTIN_SLASH_COMMAND_DECLARATIONS.find(cmd => cmd.name === "quit");
		expect(quitDecl).toBeDefined();
		expect(quitDecl?.aliases).toContain("q");
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("q")).toBe(true);
	});

	it("completes /q to the q alias rather than earlier-registered queue command", () => {
		const provider = new CombinedAutocompleteProvider(
			BUILTIN_SLASH_COMMAND_DECLARATIONS.map(cmd => ({
				name: cmd.name,
				aliases: cmd.aliases ? [...cmd.aliases] : undefined,
				description: cmd.description,
			})),
			"/tmp",
		);

		const result = provider.trySyncSlashCompletion("/q");
		expect(result).not.toBeNull();
		expect(result!.items[0]?.value).toBe("q");
	});
});
