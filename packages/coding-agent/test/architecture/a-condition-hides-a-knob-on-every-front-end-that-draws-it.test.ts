/**
 * A setting's `ui.condition` hides its knob on every front end that draws it.
 *
 * WHY THIS SUITE EXISTS. `ui.condition` names a predicate, and the name used to
 * be resolved twice: a table in the terminal selector and a second copy in the
 * desktop host's settings dump. The copy answered 27 of the 29 declared names.
 * It had no `autoThinkingActive`, so the desktop drew the auto-thinking knob
 * while auto thinking was off, and no `hasImageProtocol`, and an unknown name
 * resolves to "show the row". The terminal hid the rows and the desktop drew
 * them, which is the defect `an-off-feature-hides-its-knobs.test.ts` closes for
 * one front end and could not see on the other.
 *
 * WHAT IT ASSERTS, AND WHY AS PARITY. The declared names and the desktop
 * vocabulary are compared by exact equality, so a condition added to the schema
 * with no predicate behind it is red, and so is a predicate no setting declares.
 * Visibility itself is asserted as parity with the terminal, in both the all-off
 * and the all-on state: the sibling suite already proves the terminal hides a
 * knob whose feature is off and brings it back when the feature is on, and
 * parity carries that proof to the desktop instead of restating it. A divergence
 * is legal only as a pinned row here, which is how a front end whose window
 * genuinely answers a capability differently records the decision.
 *
 * WHAT IT DOES NOT CATCH. Nothing about which predicate a setting SHOULD
 * declare, and nothing about layout: a row can be correctly conditioned and
 * still sit in the wrong group on either front end. It also cannot see a
 * third front end that grows its own table without reading the shared one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SETTING_CONDITIONS } from "../../src/config/setting-conditions";
import { Settings } from "../../src/config/settings";
import { getDefault, getType, getUi, SETTINGS_SCHEMA, type SettingPath } from "../../src/config/settings-schema";
import { DESKTOP_SETTING_CONDITIONS, dumpSettings } from "../../src/gui-host/actions/settings";
import { getSettingDef } from "../../src/modes/terminal/components/selectors/settings-defs";

/** Every setting that declares a condition, in schema order. */
function conditionedPaths(): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(key => getUi(key)?.condition !== undefined);
}

function declaredConditions(): string[] {
	const names = new Set<string>();
	for (const key of conditionedPaths()) {
		const name = getUi(key)?.condition;
		if (name) names.add(name);
	}
	return [...names].sort();
}

const touched = new Set<SettingPath>();

/**
 * The gates that are not booleans, with the value that turns the feature off
 * and the value that turns it on. Same three the sibling suite names, for the
 * same reason: a memory backend is chosen from four names and the two session
 * budgets are amounts where zero means unmetered, so flipping booleans alone
 * would leave their knobs off in the on state.
 */
const FEATURE_GATES: { key: SettingPath; off: string | number; on: string | number }[] = [
	{ key: "memory.backend" as SettingPath, off: "off", on: "mnemopi" },
	{ key: "session.cpuLimitCores" as SettingPath, off: 0, on: 1 },
	{ key: "session.writeBudgetGb" as SettingPath, off: 0, on: 1 },
];

function turnEveryFeature(on: boolean): void {
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		if (getType(key) !== "boolean" || getDefault(key) !== false) continue;
		Settings.instance.override(key, on);
		touched.add(key);
	}
	for (const gate of FEATURE_GATES) {
		Settings.instance.override(gate.key, on ? gate.on : gate.off);
		touched.add(gate.key);
	}
}

/** Whether the terminal selector would draw the row right now. */
function visibleInTerminal(key: SettingPath): boolean {
	const def = getSettingDef(key);
	if (!def) return false;
	return def.condition === undefined || def.condition() === true;
}

/** Whether the desktop settings page would draw the row right now. */
function visibleOnDesktop(dumped: Record<string, { hidden: boolean }>, key: SettingPath): boolean {
	return dumped[key]?.hidden === false;
}

/**
 * The conditions a front end answers from its own window rather than from a
 * setting, and so the only ones the two may disagree about.
 *
 * `hasImageProtocol` is the whole set: it asks whether the client puts a
 * picture on screen, a terminal answers from its graphics protocol, and the
 * desktop decodes the payload and draws it in the window. Its row —
 * `terminal.showImages` — reaches behavior on both, since it is what tells the
 * model whether the user saw the picture, so neither front end may drop it for
 * the other's reason. Compared rows exclude it because a terminal's answer
 * depends on the terminal the suite runs under.
 */
const FRONT_END_CAPABILITIES: string[] = ["hasImageProtocol"];

/** The conditioned rows both front ends must agree about. */
function comparedPaths(): SettingPath[] {
	return conditionedPaths().filter(key => {
		const name = getUi(key)?.condition;
		return name !== undefined && !FRONT_END_CAPABILITIES.includes(name);
	});
}

/** The conditioned rows the desktop page draws right now. */
function drawnOnDesktop(): SettingPath[] {
	const dumped = dumpSettings(Settings.instance) as Record<string, { hidden: boolean }>;
	return comparedPaths().filter(key => visibleOnDesktop(dumped, key));
}

function divergence(): SettingPath[] {
	const dumped = dumpSettings(Settings.instance) as Record<string, { hidden: boolean }>;
	return comparedPaths().filter(key => visibleInTerminal(key) !== visibleOnDesktop(dumped, key));
}

beforeAll(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-condition-parity-"));
	await Settings.init({ cwd: dir, agentDir: dir });
});

afterAll(() => {
	for (const key of touched) Settings.instance.clearOverride(key);
});

describe("a declared condition is resolved by every front end", () => {
	/**
	 * NON-VACUITY AND THE CLOSED VOCABULARY. Exact equality both ways: a new
	 * `ui.condition` with no predicate behind it is red on arrival, and so is a
	 * predicate every setting stopped declaring.
	 */
	it("resolves exactly the names the schema declares, and no others", () => {
		const declared = declaredConditions();
		expect(declared.length).toBeGreaterThanOrEqual(29);
		expect(Object.keys(DESKTOP_SETTING_CONDITIONS).sort()).toEqual(declared);
	});

	/**
	 * The desktop adds one predicate of its own and inherits the rest, so a
	 * condition declared for the terminal reaches it without a second edit.
	 */
	it("inherits every settings-backed predicate and answers the capability itself", () => {
		expect(Object.keys(SETTING_CONDITIONS)).not.toContain("hasImageProtocol");
		for (const name of Object.keys(SETTING_CONDITIONS)) {
			expect(DESKTOP_SETTING_CONDITIONS[name], `${name} is not resolved on the desktop`).toBe(
				SETTING_CONDITIONS[name],
			);
		}
		expect(Object.keys(DESKTOP_SETTING_CONDITIONS).filter(name => !(name in SETTING_CONDITIONS))).toEqual(
			FRONT_END_CAPABILITIES,
		);
		expect(DESKTOP_SETTING_CONDITIONS.hasImageProtocol?.(Settings.instance)).toBe(true);
	});

	/**
	 * Resolved through each front end's own path rather than by reading
	 * `ui.condition`, because a name that resolves to no predicate reads as
	 * "draw the row" on both, which is the failure this suite exists for.
	 */
	it("draws the same conditioned rows as the terminal while every feature is off", () => {
		turnEveryFeature(false);
		expect(Settings.instance.get("lsp.enabled")).toBe(false);
		expect(comparedPaths().length).toBeGreaterThanOrEqual(70);

		expect(divergence(), "these rows are drawn on one front end and hidden on the other").toEqual([]);
	});

	/**
	 * And with every feature on, so the parity above cannot be satisfied by a
	 * desktop predicate that answers false forever. The two states are counted
	 * against each other rather than against a floor, because what a row's
	 * condition answers is the schema's business and the count moves with it;
	 * what this suite holds is that turning the features on brings rows back.
	 */
	it("draws the same conditioned rows as the terminal once every feature is on", () => {
		turnEveryFeature(false);
		const whileOff = drawnOnDesktop();

		turnEveryFeature(true);
		expect(Settings.instance.get("memory.backend")).toBe("mnemopi");
		const whileOn = drawnOnDesktop();

		expect(whileOn.length, "turning every feature on drew no rows the off state hid").toBeGreaterThan(
			whileOff.length + 20,
		);
		expect(divergence(), "these rows are drawn on one front end and hidden on the other").toEqual([]);
	});
});
