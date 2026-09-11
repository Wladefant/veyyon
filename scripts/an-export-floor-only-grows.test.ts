/**
 * WHY: `scripts/package-exports-baseline.json` is the floor `a-package-exports-its-public-surface`
 * holds every published specifier to. The floor may only grow: the generator refuses a surface
 * that dropped a specifier or a name, and the reader refuses a file it cannot trust.
 *
 * WHAT THIS CLOSES: a regenerated baseline that silently lowered the floor, and a stale or
 * malformed baseline read as an empty floor (which would make the runtime gate pass vacuously).
 *
 * WHAT IT DOES NOT CATCH: whether the committed floor matches the current surface; the runtime
 * gate imports every specifier for that.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BASELINE_FILE_PATH,
	computeExportFloorLedger,
	EXPORT_FLOOR_SCHEMA_VERSION,
	readExportFloor,
} from "./package-export-floor";
import { REPO_ROOT } from "./workspace-layout";

const FLOOR = { "@veyyon/x": ["alpha", "beta"], "@veyyon/x/sub": ["gamma"] };

describe("an export floor only grows", () => {
	it("reads the committed floor as sorted name lists, keeping a type-only specifier's empty row", () => {
		const floor = readExportFloor(JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_FILE_PATH), "utf8")));
		expect(Object.keys(floor).length).toBeGreaterThan(50);
		for (const [specifier, names] of Object.entries(floor)) {
			expect(names, specifier).toEqual([...names].sort());
		}
		// A contract package exports only types, so its row is empty and its entry point still swept.
		expect(floor["@veyyon/view"]).toEqual([]);
	});

	it("refuses a surface that drops a specifier", () => {
		expect(() => computeExportFloorLedger(FLOOR, { "@veyyon/x": ["alpha", "beta"] })).toThrow(
			/Removed specifiers:\n {4}- @veyyon\/x\/sub/,
		);
	});

	it("refuses a surface that drops a name", () => {
		expect(() => computeExportFloorLedger(FLOOR, { "@veyyon/x": ["beta"], "@veyyon/x/sub": ["gamma"] })).toThrow(
			/@veyyon\/x: missing approved export "alpha"/,
		);
	});

	it("raises the floor to the union of the old floor and the current surface, sorted", () => {
		const next = computeExportFloorLedger(FLOOR, {
			"@veyyon/x/sub": ["gamma", "delta"],
			"@veyyon/x": ["beta", "alpha", "zeta"],
			"@veyyon/y": ["one"],
		});
		expect(next).toEqual({
			schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
			exports: {
				"@veyyon/x": ["alpha", "beta", "zeta"],
				"@veyyon/x/sub": ["delta", "gamma"],
				"@veyyon/y": ["one"],
			},
		});
		expect(readExportFloor(next)).toEqual(next.exports);
	});

	it.each([
		["unversioned", { exports: FLOOR }],
		["stale version", { schemaVersion: 2, exports: FLOOR }],
		["git-referenced ledger", { schemaVersion: 2, generatedFrom: "de0ccbf5", additions: {} }],
		["array table", { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: [] }],
		["duplicate name", { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { "@veyyon/x": ["a", "a"] } }],
		["non-identifier", { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { "@veyyon/x": ["not a name"] } }],
		["non-string name", { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: { "@veyyon/x": [1] } }],
	])("rejects a %s baseline instead of reading an empty floor", (_label, raw) => {
		expect(() => readExportFloor(raw)).toThrow();
	});
});
