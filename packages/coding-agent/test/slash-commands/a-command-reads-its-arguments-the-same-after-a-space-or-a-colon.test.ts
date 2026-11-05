/**
 * A slash command reads its arguments the same whether a space or a colon follows its name.
 *
 * WHAT WENT WRONG. `parseSlashCommand` accepts `/memory stats` and `/memory:stats` and hands every handler the same
 * `args`. The terminal handlers for `/memory`, `/mcp`, `/ssh`, `/btw`, `/tan` and `/omfg` re-read the typed text
 * instead, slicing off the command name or matching `^/mcp\s+`. Typed with a colon, the action reached them as
 * `:stats`, so the terminal printed usage where print mode and ACP ran the action.
 *
 * THE CLASS. Any handler, on either surface, that reads the typed text where it should read the parsed arguments.
 * Every builtin that accepts arguments runs through the real terminal dispatcher and the real ACP dispatcher, once
 * per spelling, against a runtime that records every call made on it, and the two recordings must be equal. A command
 * added to the registry is swept without being named here.
 *
 * The composer history keeps what was typed, so it is the one place the spellings may differ: every history entry
 * must equal the typed text, and everything else recorded must match.
 *
 * GAP. Only what a handler does through its runtime is observed; a handler that reads the typed text and acts on it
 * without touching the runtime is not seen. A handler that stops before reading its arguments under the recording
 * runtime (`/collab` and `/join` stop at the session check) is compared on that early outcome only. One probe
 * argument is used, so a parse that diverges only on another argument shape is not seen.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

const PROBE = "zzprobe";
const HISTORY_CALL = "ctx.editor.addToHistory(";

function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "function") return "<fn>";
	if (typeof value !== "object" || value === null) return String(value);
	try {
		return JSON.stringify(value) ?? "<object>";
	} catch {
		return "<object>";
	}
}

/**
 * A runtime that answers every property with another recorder and records every call with its arguments. `fixed`
 * answers named top-level properties; `getAgentDir` and `getCwd` answer with paths, so a handler that joins them
 * still reaches its arguments.
 */
function recorder(calls: string[], path: string, fixed: Readonly<Record<string, unknown>> = {}): unknown {
	return new Proxy(() => {}, {
		get(_target, property) {
			if (typeof property === "string" && Object.hasOwn(fixed, property)) return fixed[property];
			if (property === Symbol.toPrimitive) return () => "";
			if (property === Symbol.iterator) return function* () {};
			// Not a thenable, so an awaited call settles on the recorder it returned.
			if (property === "then" || typeof property === "symbol") return undefined;
			return recorder(calls, `${path}.${property}`);
		},
		apply(_target, _this, args: unknown[]) {
			calls.push(`${path}(${args.map(describeValue).join(", ")})`);
			const method = path.slice(path.lastIndexOf(".") + 1);
			if (method === "getAgentDir") return "/agent";
			if (method === "getCwd") return "/repo";
			return recorder(calls, `${path}()`);
		},
	});
}

interface Recording {
	calls: string[];
	/** Set when the recording runtime could not stand in for a real one, so the handler never ran to its outcome. */
	harnessFailure?: string;
}

async function record(dispatch: (calls: string[]) => Promise<unknown>): Promise<Recording> {
	const calls: string[] = [];
	try {
		calls.push(`returned ${describeValue(await dispatch(calls))}`);
	} catch (error) {
		if (error instanceof TypeError) return { calls, harnessFailure: error.message };
		calls.push(`threw ${error instanceof Error ? error.message : String(error)}`);
	}
	return { calls };
}

type Surface = "terminal" | "acp";

const DISPATCH: Record<Surface, (text: string) => Promise<Recording>> = {
	terminal: text =>
		record(calls =>
			executeBuiltinSlashCommand(text, {
				ctx: recorder(calls, "ctx", { collabGuest: false }),
			} as unknown as BuiltinSlashCommandRuntime),
		),
	acp: text =>
		record(calls =>
			executeAcpBuiltinSlashCommand(text, recorder(calls, "runtime", { cwd: "/repo" }) as SlashCommandRuntime),
		),
};

const CASES: [Surface, string][] = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(command => command.allowArgs).flatMap(
	command => [
		...(command.handleTui || command.handle ? [["terminal", command.name] as [Surface, string]] : []),
		...(command.handle ? [["acp", command.name] as [Surface, string]] : []),
	],
);

const isHistory = (call: string) => call.startsWith(HISTORY_CALL);

describe("a command reads its arguments the same after a space or a colon", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
	});

	it("sweeps the commands whose terminal handlers once read the typed text", () => {
		const terminal = new Set(CASES.filter(([surface]) => surface === "terminal").map(([, name]) => name));
		expect(["memory", "mcp", "ssh", "btw", "tan", "omfg"].filter(name => !terminal.has(name))).toEqual([]);
	});

	it.each(CASES)("%s /%s", async (surface, name) => {
		const spacedText = `/${name} ${PROBE}`;
		const colonText = `/${name}:${PROBE}`;
		const spaced = await DISPATCH[surface](spacedText);
		const colon = await DISPATCH[surface](colonText);

		expect([spaced.harnessFailure, colon.harnessFailure]).toEqual([undefined, undefined]);
		const typed = (text: string) => `${HISTORY_CALL}${JSON.stringify(text)})`;
		expect(spaced.calls.filter(isHistory).filter(call => call !== typed(spacedText))).toEqual([]);
		expect(colon.calls.filter(isHistory).filter(call => call !== typed(colonText))).toEqual([]);
		expect(colon.calls.filter(call => !isHistory(call))).toEqual(spaced.calls.filter(call => !isHistory(call)));
	});
});
