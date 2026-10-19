/**
 * WHY: the load migrations read a settings group such as `tools`, `providers`, `argot`, `hindsight`
 * or `statusLine.segmentOptions` through a cast to a record, then tested it with `in`. A config file
 * is hand-editable, so `tools: on` puts a scalar where the group belongs; `in` on a scalar throws,
 * and a throw during migration quarantines the whole file. Every setting in it was moved aside to
 * `config.yml.corrupt` because of one line.
 *
 * The class this closes: a migration that assumes a group node is a mapping. The suite derives every
 * group node and every record setting from the paths `SETTINGS_SCHEMA` declares, so a group or a
 * record a new setting introduces joins with no edit here, and loads a real `config.yml` holding a scalar at that node beside a valid
 * setting elsewhere. The file must stay where it is and the valid setting must read back.
 *
 * Not caught: a migration that reads a group the schema no longer declares (a retired section),
 * which this sweep cannot name. The cast that made the class reachable is gone from the migration
 * file, so such a migration reads through the same `recordAt` check unless it adds a cast back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GLOBAL_SETTING_BINDINGS } from "@veyyon/coding-agent/config/settings-domains/global";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import type { SettingPath } from "@veyyon/kernel/settings/schema";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const DECLARED = SETTINGS_SCHEMA as Record<string, { type: string; default: unknown }>;
const PATHS = Object.keys(DECLARED);

/**
 * Every node that holds a mapping: a dotted prefix of a declared path that is not itself a setting,
 * and a setting declared as a record.
 */
const GROUPS = [
	...new Set(
		PATHS.flatMap(settingPath => {
			const segments = settingPath.split(".");
			return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("."));
		}),
	),
]
	.filter(group => !(group in DECLARED))
	.concat(PATHS.filter(settingPath => DECLARED[settingPath]!.type === "record"))
	.sort();

/** File-backed boolean settings, read back at their non-default value to prove the file loaded. */
const SENTINELS = PATHS.filter(
	settingPath => DECLARED[settingPath]!.type === "boolean" && !(settingPath in GLOBAL_SETTING_BINDINGS),
) as SettingPath[];

/** A sentinel that neither sits inside `group` nor holds it. */
function sentinelBeside(group: string): SettingPath {
	const sentinel = SENTINELS.find(
		settingPath => !settingPath.startsWith(`${group}.`) && !group.startsWith(`${settingPath}.`),
	);
	if (!sentinel) throw new Error(`no sentinel setting beside ${group}`);
	return sentinel;
}

function setAt(tree: Record<string, unknown>, dotted: string, value: unknown): void {
	const segments = dotted.split(".");
	let node = tree;
	for (const segment of segments.slice(0, -1)) {
		node[segment] ??= {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments.at(-1)!] = value;
}

describe("a scalar where a settings group belongs keeps the rest of the file", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-scalar-group-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	it("sweeps the groups the schema declares", () => {
		expect(GROUPS).toContain("tools");
		expect(GROUPS).toContain("statusLine.segmentOptions");
		expect(SENTINELS.length, "anti-vacuity: a file-backed boolean setting exists").toBeGreaterThan(1);
	});

	for (const scalar of ["on", 5, true]) {
		it(`a group holding ${JSON.stringify(scalar)} leaves the file in place and its other settings read`, async () => {
			const lost: string[] = [];
			for (const group of GROUPS) {
				const sentinel = sentinelBeside(group);
				const changed = !DECLARED[sentinel]!.default;
				const raw: Record<string, unknown> = {};
				setAt(raw, sentinel, changed);
				setAt(raw, group, scalar);
				const configPath = path.join(agentDir, "config.yml");
				fs.writeFileSync(configPath, YAML.stringify(raw, null, 2));
				resetSettingsForTest();
				const settings = await Settings.init({ cwd: projectDir, agentDir });
				if (settings.quarantinedFiles.length > 0 || settings.get(sentinel) !== changed) lost.push(group);
				fs.rmSync(`${configPath}.corrupt`, { force: true });
			}
			expect(lost).toEqual([]);
		});
	}
});
