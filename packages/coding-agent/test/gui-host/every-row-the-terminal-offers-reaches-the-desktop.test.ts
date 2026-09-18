/**
 * A setting the terminal screen offers is a setting the desktop page receives.
 *
 * WHY THIS SUITE EXISTS:
 * The desktop settings page is drawn from `dumpSettings` alone, and the dump
 * skipped any setting whose value and default were both undefined: a memory
 * database path nobody set, an agent model chain left to the session's model, a
 * browser screenshot directory. The reason was real — `JSON.stringify` drops an
 * undefined field, and an entry that arrives without `value` or `default` fails
 * to decode — but the cost was 13 rows the terminal offers and the desktop had
 * no row for, so the operator could reach the mnemopi paths from one front end
 * and not the other. They cross as null now, which decodes as `Value::Null` and
 * draws as an empty control.
 *
 * THE CLASS THIS CLOSES:
 * 1. Any row the terminal offers and the dump drops, for any reason, derived
 *    from the schema rather than from the 13 that were found.
 * 2. A new setting with no schema default, which lands in the same hole.
 * 3. A dump that carries the row and states `undefined`, which crosses the wire
 *    as an absent field and fails to decode on arrival.
 *
 * WHAT IT DOES NOT CATCH:
 * Whether the desktop draws the row well. An unset string in a text field and
 * an unset model chain in a text area are the controls the surface picks from
 * `SettingKind`, which its own suites cover.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { getDefault, getUi, SETTINGS_SCHEMA, type SettingPath } from "../../src/config/settings-schema";
import { dumpSettings } from "../../src/gui-host/actions/settings";

let root = "";

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gui-settings-reach-"));
	await Settings.init({ cwd: root, agentDir: root });
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Every row the terminal settings screen offers: a declared `ui` block, not retired, not hidden. */
function offeredRows(): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(key => {
		const ui = getUi(key);
		return ui !== undefined && ui.hidden !== true && !("retiredBy" in SETTINGS_SCHEMA[key]);
	});
}

test("the desktop receives every row the terminal offers", () => {
	const dumped = dumpSettings(Settings.instance);
	const offered = offeredRows();

	expect(offered.length).toBeGreaterThanOrEqual(200);
	expect(
		offered.filter(key => dumped[key] === undefined),
		"these rows are on the terminal screen and absent from the desktop page",
	).toEqual([]);
});

test("a row with no value and no default crosses as null", () => {
	const dumped = dumpSettings(Settings.instance);
	const unset = offeredRows().filter(key => getDefault(key as never) === undefined);

	// The floor is the count that was being dropped, so the fix cannot be
	// satisfied by a schema that stopped having unset settings.
	expect(unset.length).toBeGreaterThanOrEqual(13);
	for (const key of unset) {
		expect(dumped[key]?.default, `${key} states its absent default as`).toBeNull();
	}
});

test("no entry states undefined, which crosses the wire as an absent field", () => {
	const dumped = dumpSettings(Settings.instance);
	const undefinedFields = Object.entries(dumped)
		.filter(([, entry]) => entry.value === undefined || entry.default === undefined)
		.map(([key]) => key);

	expect(undefinedFields, "these entries lose a field to JSON.stringify and fail to decode").toEqual([]);
	expect(JSON.parse(JSON.stringify(dumped))).toEqual(dumped);
});
