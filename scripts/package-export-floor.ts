/**
 * The public-export floor `a-package-exports-its-public-surface.test.ts` reads and
 * `gen-package-exports-baseline.ts` regenerates: one sorted name list per published specifier.
 * The floor only grows. The generator refuses a current surface that drops a specifier or a name.
 */

import { assertObject, isStringArray, sortRecordArrays } from "./ledger-schema";

export const EXPORT_FLOOR_SCHEMA_VERSION = 3;
export const BASELINE_FILE_PATH = "scripts/package-exports-baseline.json";

export interface ExportFloorLedger {
	readonly schemaVersion: number;
	readonly exports: Readonly<Record<string, string[]>>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function readExportFloor(raw: unknown): Record<string, string[]> {
	const ledger = assertObject(raw, "Export floor schema is stale or invalid; regenerate the export baseline");
	if (ledger.schemaVersion !== EXPORT_FLOOR_SCHEMA_VERSION) {
		throw new Error(
			`Export floor schema is stale or invalid (expected version ${EXPORT_FLOOR_SCHEMA_VERSION}, got ${ledger.schemaVersion ?? "unversioned"}); regenerate the export baseline`,
		);
	}
	const entries = assertObject(ledger.exports, "Export floors must be an object");
	for (const [specifier, names] of Object.entries(entries)) {
		if (!isStringArray(names) || names.some(name => !IDENTIFIER.test(name))) {
			throw new Error(`Export floor for ${specifier} must be a list of distinct identifier names`);
		}
	}
	return sortRecordArrays(entries as Record<string, string[]>);
}

export function computeExportFloorLedger(
	floor: Readonly<Record<string, readonly string[]>>,
	currentSurface: Readonly<Record<string, readonly string[]>>,
): ExportFloorLedger {
	const removedSpecifiers: string[] = [];
	const missingNames: string[] = [];
	for (const [specifier, names] of Object.entries(floor)) {
		const currentNames = currentSurface[specifier];
		if (!currentNames) {
			removedSpecifiers.push(specifier);
			continue;
		}
		const currentSet = new Set(currentNames);
		for (const name of names) {
			if (!currentSet.has(name)) missingNames.push(`${specifier}: missing approved export "${name}"`);
		}
	}
	if (removedSpecifiers.length > 0 || missingNames.length > 0) {
		throw new Error(
			`Refusing to generate baseline: removing approved exports shrinks the public surface floor.\n` +
				(removedSpecifiers.length > 0
					? `  Removed specifiers:\n${removedSpecifiers.map(s => `    - ${s}`).join("\n")}\n`
					: "") +
				(missingNames.length > 0
					? `  Missing exported names:\n${missingNames.map(m => `    - ${m}`).join("\n")}\n`
					: ""),
		);
	}
	const merged: Record<string, string[]> = {};
	for (const [specifier, currentNames] of Object.entries(currentSurface)) {
		merged[specifier] = [...new Set([...(floor[specifier] ?? []), ...currentNames])];
	}
	return { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: sortRecordArrays(merged) };
}
