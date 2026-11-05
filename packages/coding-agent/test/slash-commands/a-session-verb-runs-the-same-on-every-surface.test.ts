/**
 * A word written after `/session` runs the same verb on the text and terminal surfaces.
 *
 * WHY THIS SUITE EXISTS. The two handlers read the argument differently. The text handler compared it
 * to `info` and `delete` byte for byte, so `/session Info` or `/session info ` (a trailing space
 * survives the parser) got the usage line over ACP and in print mode, while the terminal lowercased
 * and trimmed and ran it. The terminal in turn treated EVERY other word as `info`, so a mistyped
 * `/session dleete` showed the session info without saying the word was not understood.
 *
 * THE CLASS. Every subcommand the declaration lists (read from it, so a new one fails here until a
 * case covers it), case and whitespace variants, an unknown word, and a verb followed by stray words.
 * Each case runs through the text dispatcher and the terminal dispatcher, and both must run the same
 * verb, or both must answer with the usage line.
 *
 * WHAT IT DOES NOT CATCH. Bare `/session` is excluded: the terminal dispatcher opens the subcommand
 * picker for it, which is a deliberate surface difference. The sentences each verb prints are
 * surface-specific and are not compared beyond which verb ran.
 */
import { describe, expect, it } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const USAGE = "Usage: /session [info|delete]";
const SESSION_FILE = "/repo/.sessions/current.jsonl";

type Outcome = "info" | "delete" | "usage";

/** Which verb the text surface ran, read from what it printed and whether the file was dropped. */
async function runText(text: string): Promise<Outcome | string> {
	const said: string[] = [];
	const dropped: string[] = [];
	const runtime = {
		cwd: "/repo",
		session: { sessionId: "s-1", sessionName: "probe", isStreaming: false },
		sessionManager: {
			getSessionFile: () => SESSION_FILE,
			dropSession: async (file: string) => {
				dropped.push(file);
			},
		},
		output: (line: string) => {
			said.push(line);
		},
	} as unknown as SlashCommandRuntime;
	await executeAcpBuiltinSlashCommand(text, runtime);
	const line = said.join("\n");
	if (said.length === 1 && line === USAGE && dropped.length === 0) return "usage";
	if (line.startsWith("Session: s-1\n") && dropped.length === 0) return "info";
	if (line.startsWith(`Session deleted: ${SESSION_FILE}.`) && dropped.join() === SESSION_FILE) return "delete";
	return `unrecognised: ${JSON.stringify({ said, dropped })}`;
}

/** Which verb the terminal surface ran, read from the controller entry it reached or the warning it showed. */
async function runTerminal(text: string): Promise<Outcome | string> {
	const reached: string[] = [];
	const runtime = {
		ctx: {
			collabGuest: undefined,
			editor: { setText: () => {} },
			ui: { requestRender: () => {} },
			handleSessionCommand: async () => {
				reached.push("info");
			},
			handleSessionDeleteCommand: async () => {
				reached.push("delete");
			},
			showSubcommandPicker: () => reached.push("picker"),
			showStatus: (line: string) => reached.push(`status: ${line}`),
			showWarning: (line: string) => reached.push(line === USAGE ? "usage" : `warning: ${line}`),
			showError: (line: string) => reached.push(`error: ${line}`),
		},
	} as unknown as TuiSlashCommandRuntime;
	await executeBuiltinSlashCommand(text, runtime);
	const [only, ...more] = reached;
	if (more.length === 0 && (only === "info" || only === "delete" || only === "usage")) return only;
	return `unrecognised: ${JSON.stringify(reached)}`;
}

const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

const CASES: readonly { args: string; runs: Outcome }[] = [
	{ args: "info", runs: "info" },
	{ args: "INFO", runs: "info" },
	{ args: "Info ", runs: "info" },
	{ args: "info\t", runs: "info" },
	{ args: "delete", runs: "delete" },
	{ args: "Delete", runs: "delete" },
	{ args: "delete ", runs: "delete" },
	{ args: "dleete", runs: "usage" },
	{ args: "info now", runs: "usage" },
	{ args: "delete everything", runs: "usage" },
];

describe("a /session verb runs the same on every surface", () => {
	it("has a case for every subcommand /session declares", () => {
		const declared = DECLARATIONS.find(candidate => candidate.name === "session")?.subcommands ?? [];
		expect(declared).not.toEqual([]);
		const covered = new Set(CASES.map(c => c.args.trim().toLowerCase()));
		expect(declared.map(sub => sub.name).filter(name => !covered.has(name))).toEqual([]);
	});

	for (const { args, runs } of CASES) {
		const text = `/session ${args}`;
		it(`${JSON.stringify(text)} runs ${runs} on the text and terminal surfaces`, async () => {
			expect({ text: await runText(text), terminal: await runTerminal(text) }).toEqual({
				text: runs,
				terminal: runs,
			});
		});
	}
});
