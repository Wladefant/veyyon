/**
 * A word written after `/yolo` leaves the permission bypass in the same state on every surface.
 *
 * WHY THIS SUITE EXISTS. The text and terminal handlers each parsed the argument. The terminal sent
 * every word it did not recognise down the enabling path, so `/yolo disable` raised the "Turn OFF all
 * permission prompts?" confirmation, and one more Enter turned the bypass ON, where the text surface
 * printed the usage line.
 * Bare `/yolo` toggled on the text surface, as its declaration states, but always enabled in the
 * terminal, so with the bypass already on it answered "already on" and left prompts off.
 *
 * THE CLASS. Every subcommand the declaration lists (read from it, so a new one fails here until a
 * case covers it), `toggle`, the bare form, case and whitespace variants, an unknown word, and stray
 * trailing words, each from the bypass off and on. Each case runs through the text dispatcher and
 * the terminal dispatcher, with the terminal's danger confirmation accepted, and both must leave
 * the bypass in the expected state. A word that is not understood must print the usage line on both
 * surfaces and must never raise the confirmation.
 *
 * WHAT IT DOES NOT CATCH. The confirmation being declined is covered by `yolo.test.ts`. The
 * sentences each surface prints on success differ by design and are not compared.
 */
import { describe, expect, it } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const USAGE = "Usage: /yolo [on|off|status]";

/** A session whose bypass is a real boolean. */
function bypassSession(initial: boolean) {
	let bypassed = initial;
	return {
		session: {
			isApprovalBypassed: () => bypassed,
			setApprovalBypass: (value: boolean) => {
				bypassed = value;
				return bypassed;
			},
		},
		bypassed: () => bypassed,
	};
}

/** The bypass the text surface left, and whether it answered with the usage line. */
async function runText(text: string, initial: boolean): Promise<{ bypassed: boolean; usage: boolean }> {
	const world = bypassSession(initial);
	const said: string[] = [];
	const runtime = {
		session: world.session,
		output: (line: string) => {
			said.push(line);
		},
	} as unknown as SlashCommandRuntime;
	await executeAcpBuiltinSlashCommand(text, runtime);
	return { bypassed: world.bypassed(), usage: said.includes(USAGE) };
}

/** The bypass the terminal left, whether it warned with the usage line, and whether it asked to confirm. */
async function runTerminal(
	text: string,
	initial: boolean,
): Promise<{ bypassed: boolean; usage: boolean; confirmed: boolean }> {
	const world = bypassSession(initial);
	const warned: string[] = [];
	let confirmed = false;
	const runtime = {
		ctx: {
			collabGuest: undefined,
			session: world.session,
			editor: { setText: () => {} },
			statusLine: { invalidate: () => {} },
			ui: { requestRender: () => {} },
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showWarning: (line: string) => warned.push(line),
			showHookConfirm: async () => {
				confirmed = true;
				return true;
			},
		},
	} as unknown as TuiSlashCommandRuntime;
	await executeBuiltinSlashCommand(text, runtime);
	return { bypassed: world.bypassed(), usage: warned.includes(USAGE), confirmed };
}

const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

interface Case {
	args: string;
	from: boolean;
	/** The bypass state both surfaces must leave, or `"usage"` when the word is not understood. */
	to: boolean | "usage";
}

const CASES: readonly Case[] = [
	{ args: "on", from: false, to: true },
	{ args: "on", from: true, to: true },
	{ args: "ON ", from: false, to: true },
	{ args: "off", from: true, to: false },
	{ args: "off", from: false, to: false },
	{ args: " Off\t", from: true, to: false },
	{ args: "status", from: false, to: false },
	{ args: "status", from: true, to: true },
	{ args: "toggle", from: false, to: true },
	{ args: "toggle", from: true, to: false },
	{ args: "", from: false, to: true },
	{ args: "", from: true, to: false },
	{ args: "of", from: false, to: "usage" },
	{ args: "of", from: true, to: "usage" },
	{ args: "on now", from: false, to: "usage" },
	// A word meaning "off" that is not the declared one: it used to raise the enable confirmation.
	{ args: "disable", from: false, to: "usage" },
	{ args: "disable", from: true, to: "usage" },
];

describe("a /yolo word does the same on every surface", () => {
	it("has a case for every subcommand /yolo declares", () => {
		const declared = DECLARATIONS.find(candidate => candidate.name === "yolo")?.subcommands ?? [];
		expect(declared).not.toEqual([]);
		const covered = new Set(CASES.map(c => c.args.trim().toLowerCase()));
		expect(declared.map(sub => sub.name).filter(name => !covered.has(name))).toEqual([]);
	});

	for (const { args, from, to } of CASES) {
		const text = args ? `/yolo ${args}` : "/yolo";
		const expected = to === "usage" ? { bypassed: from, usage: true } : { bypassed: to, usage: false };
		it(`${JSON.stringify(text)} from ${from ? "on" : "off"} ${to === "usage" ? "prints the usage line" : `leaves the bypass ${to ? "on" : "off"}`} on both surfaces`, async () => {
			const viaText = await runText(text, from);
			const viaTerminal = await runTerminal(text, from);
			expect(viaText).toEqual(expected);
			expect({ bypassed: viaTerminal.bypassed, usage: viaTerminal.usage }).toEqual(expected);
			// Only a request that turns the bypass on from off may raise the danger confirmation.
			expect(viaTerminal.confirmed).toBe(to === true && !from);
		});
	}
});
