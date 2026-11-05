/**
 * `/fast` and `/browser` accept the same words and print the same sentence on every surface.
 *
 * WHY THIS SUITE EXISTS. Each command held two copies of its logic, one per surface, and they had
 * drifted. The text handlers did not trim their argument, so `/fast on ` reached them as `on ` and
 * was answered with the usage line wherever the prompt was not trimmed before dispatch (print mode
 * is one such place), while the terminal turned the tier on. A browser restart that failed after the
 * mode was saved read "Failed to restart browser" in the terminal and "Browser mode set to ..., but
 * restart failed" over ACP.
 *
 * THE CLASS. Every subcommand each command declares (read from its declaration, so a new one fails
 * here until a case covers it), case and whitespace variants, the bare form, an unknown word, and for
 * `/browser` the disabled tool and a failed restart. Each case runs through the text dispatcher and
 * the terminal dispatcher against equal starting state, and both must leave the same state and print
 * the expected sentence.
 *
 * WHAT IT DOES NOT CATCH. Other builtins with a handler per surface are not swept here. The colour
 * the terminal gives a sentence is not compared.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PRIORITY_TIER_COMMAND_LABEL } from "@veyyon/coding-agent/config/service-tier";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { setSettingsInstance, settingsOrNull } from "@veyyon/coding-agent/config/settings-instance";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/** The state one command reads and writes, created fresh for each surface. */
interface World<State> {
	session: object;
	settings: Settings;
	state: () => State;
}

/** What one surface printed, and the state it left. */
interface Run<State> {
	said: string[];
	state: State;
}

async function runText<State>(text: string, world: World<State>): Promise<Run<State>> {
	const said: string[] = [];
	const runtime = {
		session: world.session,
		settings: world.settings,
		output: (line: string) => {
			said.push(line);
		},
	} as unknown as SlashCommandRuntime;
	await executeAcpBuiltinSlashCommand(text, runtime);
	return { said, state: world.state() };
}

async function runTerminal<State>(text: string, world: World<State>): Promise<Run<State>> {
	const said: string[] = [];
	// The terminal handlers read the process settings instance, which this world stands in for.
	setSettingsInstance(world.settings);
	const runtime = {
		ctx: {
			collabGuest: undefined,
			session: world.session,
			settings: world.settings,
			editor: { setText: () => {} },
			statusLine: { invalidate: () => {} },
			ui: { requestRender: () => {} },
			showStatus: (line: string) => said.push(line),
			showWarning: (line: string) => said.push(line),
			showError: (line: string) => said.push(line),
		},
	} as unknown as TuiSlashCommandRuntime;
	await executeBuiltinSlashCommand(text, runtime);
	return { said, state: world.state() };
}

const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

function declaredSubcommands(name: string): string[] {
	const declaration = DECLARATIONS.find(candidate => candidate.name === name);
	return (declaration?.subcommands ?? []).map(sub => sub.name);
}

interface Case<State> {
	args: string;
	world: () => World<State>;
	said: string;
	state: State;
}

/** A session whose priority tier starts off and that the current model either serves or does not. */
function fastWorld(supported: boolean): World<boolean> {
	let fast = false;
	const session = {
		isFastModeEnabled: () => fast,
		toggleFastMode: () => {
			fast = supported ? !fast : false;
			return fast;
		},
		setFastMode: (enabled: boolean) => {
			fast = supported && enabled;
			return supported;
		},
	};
	return { session, settings: Settings.isolated(), state: () => fast };
}

const ENABLED = `${PRIORITY_TIER_COMMAND_LABEL} enabled.`;
const DISABLED = `${PRIORITY_TIER_COMMAND_LABEL} disabled.`;
const FAST_USAGE = "Usage: /fast [on|off|status]";

const FAST_CASES: Case<boolean>[] = [
	{ args: "", world: () => fastWorld(true), said: ENABLED, state: true },
	{ args: "toggle", world: () => fastWorld(true), said: ENABLED, state: true },
	{ args: "on", world: () => fastWorld(true), said: ENABLED, state: true },
	{ args: "ON", world: () => fastWorld(true), said: ENABLED, state: true },
	{ args: "on ", world: () => fastWorld(true), said: ENABLED, state: true },
	{
		args: "on",
		world: () => fastWorld(false),
		said: `${PRIORITY_TIER_COMMAND_LABEL} is unavailable for the current model.`,
		state: false,
	},
	{ args: "off", world: () => fastWorld(true), said: DISABLED, state: false },
	{ args: "  off\t", world: () => fastWorld(true), said: DISABLED, state: false },
	{ args: "status", world: () => fastWorld(true), said: `${PRIORITY_TIER_COMMAND_LABEL} is off.`, state: false },
	{ args: "Status ", world: () => fastWorld(true), said: `${PRIORITY_TIER_COMMAND_LABEL} is off.`, state: false },
	{ args: "turbo", world: () => fastWorld(true), said: FAST_USAGE, state: false },
];

interface BrowserState {
	headless: boolean;
	restarts: number;
}

/** A visible browser, enabled or not, whose running tool restarts cleanly or fails with `failure`. */
function browserWorld(enabled: boolean, failure?: string): World<BrowserState> {
	// Stored rather than passed to `isolated`, which installs an override that outranks the write.
	const settings = Settings.isolated({ "browser.enabled": enabled });
	settings.set("browser.headless", false);
	let restarts = 0;
	const tool = {
		restartForModeChange: async () => {
			restarts += 1;
			if (failure !== undefined) throw new Error(failure);
		},
	};
	const session = { getToolByName: (name: string) => (name === "browser" ? tool : undefined) };
	return { session, settings, state: () => ({ headless: settings.get("browser.headless"), restarts }) };
}

const BROWSER_USAGE = "Usage: /browser [headless|visible]";
const HEADLESS = "Browser mode: headless";
const VISIBLE = "Browser mode: visible";

const BROWSER_CASES: Case<BrowserState>[] = [
	{ args: "", world: () => browserWorld(true), said: HEADLESS, state: { headless: true, restarts: 1 } },
	{ args: "headless", world: () => browserWorld(true), said: HEADLESS, state: { headless: true, restarts: 1 } },
	{ args: "HIDDEN ", world: () => browserWorld(true), said: HEADLESS, state: { headless: true, restarts: 1 } },
	{ args: "visible", world: () => browserWorld(true), said: VISIBLE, state: { headless: false, restarts: 1 } },
	{ args: "visible ", world: () => browserWorld(true), said: VISIBLE, state: { headless: false, restarts: 1 } },
	{ args: "show", world: () => browserWorld(true), said: VISIBLE, state: { headless: false, restarts: 1 } },
	{ args: "Headful", world: () => browserWorld(true), said: VISIBLE, state: { headless: false, restarts: 1 } },
	{
		args: "fullscreen",
		world: () => browserWorld(true),
		said: BROWSER_USAGE,
		state: { headless: false, restarts: 0 },
	},
	{
		args: "headless",
		world: () => browserWorld(false),
		said: "Browser tool is disabled (enable in settings).",
		state: { headless: false, restarts: 0 },
	},
	{
		args: "headless",
		world: () => browserWorld(true, "no display"),
		said: "Browser mode set to headless, but restart failed: no display",
		state: { headless: true, restarts: 1 },
	},
];

/** Registers one command's cases: a declaration-coverage check, then one test per case. */
function sweep<State>(name: string, cases: readonly Case<State>[]): void {
	it(`/${name} has a case for every subcommand it declares`, () => {
		const covered = new Set(cases.map(c => c.args.trim().toLowerCase()));
		expect(declaredSubcommands(name).filter(sub => !covered.has(sub))).toEqual([]);
	});

	for (const testCase of cases) {
		const text = `/${name} ${testCase.args}`;
		it(`${JSON.stringify(text)} prints ${JSON.stringify(testCase.said)} on the text and terminal surfaces`, async () => {
			const viaText = await runText(text, testCase.world());
			const viaTerminal = await runTerminal(text, testCase.world());

			expect(viaText).toEqual({ said: [testCase.said], state: testCase.state });
			expect(viaTerminal).toEqual({ said: [testCase.said], state: testCase.state });
		});
	}
}

describe("/fast and /browser say the same on every surface", () => {
	let previousSettings: Settings | null = null;

	beforeEach(() => {
		previousSettings = settingsOrNull();
	});

	afterEach(() => {
		setSettingsInstance(previousSettings);
	});

	sweep("fast", FAST_CASES);
	sweep("browser", BROWSER_CASES);
});
