/**
 * WHY: a value written into `config.yml` by hand was checked against its declared type at load, and
 * the mismatch was reported, but the read path served it anyway for every setting that is not an
 * enum. `compaction.enabled: "no"` read as a truthy string and left compaction on, and an empty
 * `disabledExtensions:` read as `null` under a `string[]` type, which the extension dashboard
 * called `.slice()` on. The defect class is any declared setting whose read returns a value of a
 * kind the declaration does not name. The store's read path now answers such a value with the
 * default and reports it once per path.
 *
 * The suite sweeps every non-enum setting in `SETTINGS_SCHEMA` at run time, so a new setting joins
 * with no edit here, and a new kind of setting fails the first cell until it gets a wrong-kind
 * sample. It loads each variant from a real `config.yml` through `Settings.init`, and the
 * global-scoped settings, which read through their binding rather than the profile file, through
 * runtime overrides, which take the same read path.
 *
 * Not caught: an entry of the wrong kind inside a record or a model chain, which is reported at load
 * and served, because the entries that are fine keep working (the model-chain suite covers that).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GLOBAL_SETTING_BINDINGS } from "@veyyon/coding-agent/config/settings-domains/global";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import type { SettingPath } from "@veyyon/kernel/settings/schema";
import { getProjectAgentDir, logger, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/** A value of the wrong kind for each kind of setting, and one of the right kind. */
const SAMPLES: Record<string, { wrong: unknown; right: unknown }> = {
	boolean: { wrong: "no", right: true },
	number: { wrong: "4", right: 7 },
	string: { wrong: 42, right: "probe" },
	array: { wrong: "a,b", right: ["probe"] },
	record: { wrong: "probe", right: {} },
	modelChain: { wrong: 42, right: "probe/model" },
};

interface KindedSetting {
	path: SettingPath;
	type: string;
	default: unknown;
	global: boolean;
}

const SETTINGS: KindedSetting[] = Object.entries(SETTINGS_SCHEMA as Record<string, { type: string; default: unknown }>)
	.filter(([, def]) => def.type !== "enum")
	.map(([settingPath, def]) => ({
		path: settingPath as SettingPath,
		type: def.type,
		default: def.default,
		global: settingPath in GLOBAL_SETTING_BINDINGS,
	}));

/**
 * Paths whose load migration rewrites a non-null value before the read path sees it, pinned by
 * exact equality: the retired compaction thresholds fold into `compaction.threshold` and leave their
 * own keys unset. The migration reads `null` as absent and leaves it for the read path.
 */
const MIGRATED_AT_LOAD: string[] = ["compaction.thresholdPercent", "compaction.thresholdTokens"];

const WRONG_KIND_WARNING = "Settings: configured value is not of its declared kind; using its default";

/** A nested config tree holding `pick(setting)` at each path in `settings`. */
function configWith(settings: KindedSetting[], pick: (setting: KindedSetting) => unknown): Record<string, unknown> {
	const tree: Record<string, unknown> = {};
	for (const setting of settings) {
		const segments = setting.path.split(".");
		let node = tree;
		for (const segment of segments.slice(0, -1)) {
			node[segment] ??= {};
			node = node[segment] as Record<string, unknown>;
		}
		node[segments.at(-1)!] = pick(setting);
	}
	return tree;
}

describe("a setting of the wrong kind reads as its default", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let warnings: { message: string; context: Record<string, unknown> | undefined }[];

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-kind-read-validation-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			warnings.push({ message, context });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	const globalScoped = SETTINGS.filter(setting => setting.global);
	/**
	 * A file-backed setting whose path is the parent of another declared path. One config file cannot
	 * hold a scalar there and the child beneath it, so these are swept in a file of their own.
	 */
	const parents = SETTINGS.filter(
		setting => !setting.global && SETTINGS.some(other => other.path.startsWith(`${setting.path}.`)),
	);
	const fileBacked = SETTINGS.filter(setting => !setting.global && !parents.includes(setting));

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	function readAll(settings: Settings, swept: KindedSetting[]): Record<string, unknown> {
		return Object.fromEntries(swept.map(setting => [setting.path, settings.get(setting.path)]));
	}

	function defaults(swept: KindedSetting[]): Record<string, unknown> {
		return Object.fromEntries(swept.map(setting => [setting.path, setting.default]));
	}

	it("has a wrong-kind sample for every kind the schema declares", () => {
		expect([...new Set(SETTINGS.map(setting => setting.type))].sort()).toEqual(Object.keys(SAMPLES).sort());
		expect(fileBacked.map(setting => setting.path)).toContain("disabledExtensions");
		expect(globalScoped.length, "anti-vacuity: some setting is global-scoped").toBeGreaterThan(0);
		expect(parents.map(setting => setting.path)).toEqual(["todo.reminders"]);
	});

	for (const [name, pick, migratedAtLoad] of [
		["a value of the wrong kind", (setting: KindedSetting) => SAMPLES[setting.type]!.wrong, MIGRATED_AT_LOAD],
		[
			"a non-finite number",
			(setting: KindedSetting) =>
				setting.type === "number" ? Number.POSITIVE_INFINITY : SAMPLES[setting.type]!.wrong,
			MIGRATED_AT_LOAD,
		],
		["null", () => null, []],
	] as const) {
		it(`${name} in config.yml reads as the default, reported once per path across a rebuild`, async () => {
			const settings = await loadWith(configWith(fileBacked, pick));
			expect(readAll(settings, fileBacked)).toEqual(defaults(fileBacked));
			settings.rebuildMerged();
			expect(readAll(settings, fileBacked)).toEqual(defaults(fileBacked));
			const reported = warnings
				.filter(warning => warning.message === WRONG_KIND_WARNING)
				.map(warning => String(warning.context?.reason).split(":")[0]);
			expect(reported.sort()).toEqual(
				fileBacked
					.map(setting => setting.path as string)
					.filter(settingPath => !(migratedAtLoad as readonly string[]).includes(settingPath))
					.sort(),
			);
		});

		it(`${name} at a path that parents another setting reads as the default`, async () => {
			const settings = await loadWith(configWith(parents, pick));
			expect(readAll(settings, parents)).toEqual(defaults(parents));
		});

		it(`${name} for a global-scoped setting reads as the default`, () => {
			const overrides = Object.fromEntries(globalScoped.map(setting => [setting.path, pick(setting)]));
			const settings = Settings.isolated(overrides);
			expect(readAll(settings, globalScoped)).toEqual(defaults(globalScoped));
		});
	}

	it("a value of the declared kind reads back unchanged, with nothing reported", async () => {
		const right = (setting: KindedSetting) => SAMPLES[setting.type]!.right;
		const settings = await loadWith(configWith(fileBacked, right));
		const read = readAll(settings, fileBacked);
		const rewritten = fileBacked
			.filter(setting => JSON.stringify(read[setting.path]) !== JSON.stringify(right(setting)))
			.map((setting): string => setting.path)
			.sort();
		expect(rewritten).toEqual(MIGRATED_AT_LOAD);
		expect(warnings.filter(warning => warning.message === WRONG_KIND_WARNING)).toEqual([]);
	});
});
