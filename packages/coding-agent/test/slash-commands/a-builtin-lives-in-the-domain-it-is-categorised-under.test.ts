/**
 * WHY THIS EXISTS. The builtin handlers were one 1,806-line object literal holding every command in
 * the product. They are now eight domain modules, and the domain a command belongs to is stated in
 * `builtin-categories.ts`, which existed before the split and drove it. That creates a way for the two to
 * disagree: a command can be categorised as `session` and have its handler written into
 * `builtin-share.ts`, and nothing at run time would care, because the registry spreads all eight
 * maps together and the result is the same object either way. The taxonomy would rot into a comment.
 *
 * WHAT IT CLOSES. Not "the eight files we have today are consistent" — that is the incident. The
 * class is "a command's declared domain and the module its handler lives in can drift". So the
 * domain list is derived from the category map at run time rather than typed out, every declared
 * command is swept, and both directions are asserted: no command missing from the modules, and no
 * name in a module that is not declared. A ninth category, a renamed domain, a command whose handler
 * moves file, or a command declared and never implemented each turn this red without an edit here.
 *
 * WHAT IT DOES NOT CATCH. Whether a domain is the RIGHT one for a command. `builtin-categories.ts` is the
 * authority, and if a command is filed under the wrong heading there, this suite agrees with it.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_CATEGORIES } from "@veyyon/coding-agent/slash-commands/builtin-categories";
import { CONTEXT_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-context";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { INFO_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-info";
import { MODEL_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-model";
import { MODES_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-modes";
import { SESSION_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-session";
import { SETUP_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-setup";
import { SHARE_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-share";
import { WORKSPACE_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-workspace";
import type { BuiltinSlashCommandHandlers } from "@veyyon/coding-agent/slash-commands/handler-types";

/** The eight domain modules, keyed by the category name each one answers for. */
const DOMAIN_MODULES: Readonly<Record<string, Partial<BuiltinSlashCommandHandlers>>> = {
	context: CONTEXT_HANDLERS,
	info: INFO_HANDLERS,
	model: MODEL_HANDLERS,
	modes: MODES_HANDLERS,
	session: SESSION_HANDLERS,
	setup: SETUP_HANDLERS,
	share: SHARE_HANDLERS,
	workspace: WORKSPACE_HANDLERS,
};

/** Which domain module holds each command, read from the modules rather than from the map. */
function domainOfEachHandler(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const [domain, handlers] of Object.entries(DOMAIN_MODULES)) {
		for (const name of Object.keys(handlers)) {
			found.set(name, [...(found.get(name) ?? []), domain]);
		}
	}
	return found;
}

describe("a builtin lives in the domain it is categorised under", () => {
	const declared: string[] = BUILTIN_SLASH_COMMAND_DECLARATIONS.map(command => command.name).sort();
	const placed = domainOfEachHandler();

	/**
	 * Non-vacuity, both halves. An empty declaration array or an empty domain module would make every
	 * sweep below pass over nothing, which is the way a gate like this stops guarding without failing.
	 */
	it("sweeps a real corpus, and no domain module is empty", () => {
		expect(declared.length).toBeGreaterThanOrEqual(75);
		for (const [domain, handlers] of Object.entries(DOMAIN_MODULES)) {
			expect(Object.keys(handlers).length, `${domain} holds no commands`).toBeGreaterThan(0);
		}
	});

	/**
	 * The domain list is the category map's, not this file's. A ninth category with no module behind
	 * it, or a module for a domain nothing is categorised under, fails here rather than being carried
	 * silently by the spread in the registry.
	 */
	it("has exactly one module per domain the category map uses", () => {
		const categorised = [...new Set(Object.values(BUILTIN_SLASH_COMMAND_CATEGORIES))].sort();

		expect(Object.keys(DOMAIN_MODULES).sort()).toEqual(categorised);
	});

	it("implements every declared command in exactly one domain module", () => {
		const unimplemented = declared.filter(name => !placed.has(name));
		const duplicated = declared.filter(name => (placed.get(name) ?? []).length > 1);

		expect(unimplemented, "declared with no handler in any domain module").toEqual([]);
		expect(duplicated, "the same command is implemented in two domain modules").toEqual([]);
	});

	it("puts each command in the module its category names", () => {
		const misfiled = declared
			.filter(name => placed.has(name))
			.map(name => ({ name, filed: placed.get(name)?.[0], categorised: BUILTIN_SLASH_COMMAND_CATEGORIES[name] }))
			.filter(row => row.filed !== row.categorised);

		expect(misfiled, "the handler lives in one domain and categories.ts says another").toEqual([]);
	});

	it("holds no handler for a command that is not declared", () => {
		const undeclared = [...placed.keys()].filter(name => !declared.includes(name)).sort();

		expect(undeclared, "a domain module implements a command nothing declares").toEqual([]);
	});
});
