/**
 * Shared ledger schema validation, module resolution, and sparse overlay primitives.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function assertObject(raw: unknown, message: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(message);
	return raw as Record<string, unknown>;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string") && new Set(value).size === value.length;
}

export function assertStringArray(value: unknown, arrayMessage: string, elementMessage?: string): string[] {
	if (!Array.isArray(value)) throw new Error(arrayMessage);
	for (const item of value) {
		if (typeof item !== "string") throw new Error(elementMessage ?? arrayMessage);
	}
	return value as string[];
}

export function validateLedgerHeader(
	raw: unknown,
	expectedSchemaVersion: number,
	expectedCommit: string,
	ledgerName: string,
): Record<string, unknown> {
	const ledger = assertObject(raw, `${ledgerName} is not an object`);
	if (ledger.schemaVersion !== expectedSchemaVersion) {
		throw new Error(
			`${ledgerName} schema is stale or unversioned (expected version ${expectedSchemaVersion}, got ${ledger.schemaVersion ?? "unversioned v1"})`,
		);
	}
	if (!ledger.generatedFrom || typeof ledger.generatedFrom !== "string") {
		throw new Error(`${ledgerName} is missing generatedFrom commit hash`);
	}
	if (ledger.generatedFrom !== expectedCommit) {
		throw new Error(
			`${ledgerName} generatedFrom commit mismatch: expected pinned baseline ${expectedCommit}, got ${ledger.generatedFrom}`,
		);
	}
	return ledger;
}

export function resolveModuleSpecifierOnDisk(
	fromFile: string,
	specifier: string,
	memberDirResolver?: (pkgName: string) => string | undefined,
): string | null {
	let base = dirname(fromFile);
	let body = specifier;
	if (!specifier.startsWith(".")) {
		if (!memberDirResolver) return null;
		const scoped = specifier.startsWith("@");
		const parts = specifier.split("/");
		const packageName = scoped ? parts.slice(0, 2).join("/") : parts[0];
		const rest = parts.slice(scoped ? 2 : 1).join("/");
		const memberDir = packageName === undefined ? undefined : memberDirResolver(packageName);
		if (memberDir === undefined) return null;
		base = existsSync(join(memberDir, "src")) ? join(memberDir, "src") : memberDir;
		body = (rest === "" ? "index" : rest).replace(/\.js$/, "");
	}
	const clean = body.replace(/\.js$/, "");
	const candidates = [
		resolve(base, body),
		resolve(base, clean),
		resolve(base, `${clean}.ts`),
		resolve(base, `${clean}.tsx`),
		resolve(base, `${clean}.d.ts`),
		resolve(base, `${clean}.js`),
		resolve(base, clean, "index.ts"),
		resolve(base, clean, "index.tsx"),
		resolve(base, clean, "index.d.ts"),
		resolve(base, clean, "index.js"),
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

const DEFAULT_ALIAS_RULES = [
	{ key: "suffixReason", transform: (why: string) => `${why}.js` },
	{ key: "sameReason", transform: (why: string) => why },
] as const;

export function expandAliasRecords<T extends { to: string; why: string }>(
	raw: unknown,
	ownerName: string,
	rules = DEFAULT_ALIAS_RULES,
): Record<string, T> {
	const rawObj = assertObject(raw, `Resolved subpaths relocations for package "${ownerName}" must be an object`);
	if ("records" in rawObj || "jsAliases" in rawObj) {
		const rawRecords = assertObject(
			rawObj.records,
			`Resolved subpaths relocations for package "${ownerName}" is missing valid "records" object`,
		);
		const expanded: Record<string, T> = {};
		for (const [key, val] of Object.entries(rawRecords)) {
			const v = assertObject(
				val,
				`Invalid relocation record for "${key}" in package "${ownerName}": must have string "to" and "why"`,
			);
			if (typeof v.to !== "string" || typeof v.why !== "string") {
				throw new Error(
					`Invalid relocation record for "${key}" in package "${ownerName}": must have string "to" and "why"`,
				);
			}
			expanded[key] = { to: v.to, why: v.why } as T;
		}
		if ("jsAliases" in rawObj) {
			const jsAliases = assertObject(rawObj.jsAliases, `jsAliases in package "${ownerName}" must be an object`);
			for (const key of Object.keys(jsAliases)) {
				if (!rules.some(r => r.key === key))
					throw new Error(`Unknown key "${key}" in jsAliases for package "${ownerName}"`);
			}
			const seenAliases = new Set<string>();
			for (const rule of rules) {
				const list = jsAliases[rule.key];
				if (list === undefined) continue;
				if (!Array.isArray(list))
					throw new Error(`jsAliases.${rule.key} in package "${ownerName}" must be an array`);
				for (const baseKey of list) {
					if (typeof baseKey !== "string")
						throw new Error(`jsAliases.${rule.key} in package "${ownerName}" must contain only strings`);
					if (seenAliases.has(baseKey))
						throw new Error(`Duplicate alias membership for "${baseKey}" in package "${ownerName}"`);
					seenAliases.add(baseKey);
					const base = expanded[baseKey];
					if (!base) throw new Error(`Missing base record for alias "${baseKey}" in package "${ownerName}"`);
					const aliasKey = `${baseKey}.js`;
					if (aliasKey in rawRecords)
						throw new Error(
							`Collision: alias "${aliasKey}" is already present in explicit records for package "${ownerName}"`,
						);
					expanded[aliasKey] = { to: `${base.to}.js`, why: rule.transform(base.why) } as T;
				}
			}
		}
		for (const key of Object.keys(rawObj)) {
			if (key !== "records" && key !== "jsAliases")
				throw new Error(`Unknown property "${key}" in resolved subpaths relocations for package "${ownerName}"`);
		}
		return expanded;
	}
	const expanded: Record<string, T> = {};
	for (const [key, val] of Object.entries(rawObj)) {
		const v = assertObject(
			val,
			`Invalid relocation record for "${key}" in package "${ownerName}": must have string "to" and "why"`,
		);
		if (typeof v.to !== "string" || typeof v.why !== "string")
			throw new Error(
				`Invalid relocation record for "${key}" in package "${ownerName}": must have string "to" and "why"`,
			);
		expanded[key] = { to: v.to, why: v.why } as T;
	}
	return expanded;
}

export function normalizeAliasRecords<T extends { to: string; why: string }>(
	rawMap: Record<string, T>,
): { records: Record<string, T>; jsAliases?: { suffixReason?: string[]; sameReason?: string[] } } | Record<string, T> {
	const records: Record<string, T> = {};
	const jsAliases = { suffixReason: [] as string[], sameReason: [] as string[] };
	const keys = Object.keys(rawMap).sort();
	const normalizedJsKeys = new Set<string>();
	for (const jsKey of keys) {
		if (!jsKey.endsWith(".js")) continue;
		const baseKey = jsKey.slice(0, -3);
		const jsRecord = rawMap[jsKey];
		const baseRecord = rawMap[baseKey];
		if (!baseRecord || !jsRecord || jsRecord.to !== `${baseRecord.to}.js`) continue;
		if (jsRecord.why === `${baseRecord.why}.js`) {
			jsAliases.suffixReason.push(baseKey);
			normalizedJsKeys.add(jsKey);
		} else if (jsRecord.why === baseRecord.why) {
			jsAliases.sameReason.push(baseKey);
			normalizedJsKeys.add(jsKey);
		}
	}
	if (normalizedJsKeys.size === 0) return rawMap;
	jsAliases.suffixReason.sort();
	jsAliases.sameReason.sort();
	for (const k of keys) {
		if (!normalizedJsKeys.has(k) && rawMap[k]) records[k] = rawMap[k]!;
	}
	return {
		records,
		...(jsAliases.suffixReason.length > 0 || jsAliases.sameReason.length > 0
			? {
					jsAliases: {
						...(jsAliases.suffixReason.length > 0 ? { suffixReason: jsAliases.suffixReason } : {}),
						...(jsAliases.sameReason.length > 0 ? { sameReason: jsAliases.sameReason } : {}),
					},
				}
			: {}),
	};
}

export function expandPairedList(rawAdded: unknown, ownerName: string): string[] {
	if (Array.isArray(rawAdded)) {
		const seen = new Set<string>();
		for (const item of rawAdded) {
			if (typeof item !== "string")
				throw new Error(`Invalid item in added resolvedSubpaths for package "${ownerName}": must be a string`);
			if (seen.has(item))
				throw new Error(`Duplicate subpath "${item}" in added resolvedSubpaths for package "${ownerName}"`);
			seen.add(item);
		}
		return [...rawAdded].sort();
	}
	if (rawAdded && typeof rawAdded === "object") {
		const obj = rawAdded as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			if (key !== "subpaths" && key !== "pairedJsSubpaths")
				throw new Error(`Unknown property "${key}" in added resolvedSubpaths for package "${ownerName}"`);
		}
		const subpaths = (obj.subpaths ?? []) as unknown[];
		const paired = (obj.pairedJsSubpaths ?? []) as unknown[];
		if (!Array.isArray(subpaths))
			throw new Error(`Added resolvedSubpaths.subpaths for package "${ownerName}" must be an array`);
		if (!Array.isArray(paired))
			throw new Error(`Added resolvedSubpaths.pairedJsSubpaths for package "${ownerName}" must be an array`);
		const seenExplicit = new Set<string>();
		for (const item of subpaths) {
			if (typeof item !== "string")
				throw new Error(`Invalid subpath in added resolvedSubpaths for package "${ownerName}": must be a string`);
			if (seenExplicit.has(item))
				throw new Error(
					`Duplicate explicit subpath "${item}" in added resolvedSubpaths for package "${ownerName}"`,
				);
			seenExplicit.add(item);
		}
		const expanded: string[] = [...(subpaths as string[])];
		const seenPaired = new Set<string>();
		for (const base of paired) {
			if (typeof base !== "string")
				throw new Error(
					`Invalid base in added resolvedSubpaths.pairedJsSubpaths for package "${ownerName}": must be a string`,
				);
			if (seenPaired.has(base))
				throw new Error(`Duplicate paired base "${base}" in added resolvedSubpaths for package "${ownerName}"`);
			seenPaired.add(base);
			const jsKey = `${base}.js`;
			if (seenExplicit.has(base))
				throw new Error(
					`Collision: base "${base}" is in both subpaths and pairedJsSubpaths for package "${ownerName}"`,
				);
			if (seenExplicit.has(jsKey))
				throw new Error(
					`Collision: alias "${jsKey}" is in explicit subpaths while base is in pairedJsSubpaths for package "${ownerName}"`,
				);
			expanded.push(base, jsKey);
		}
		return expanded.sort();
	}
	throw new Error(`Invalid added resolvedSubpaths entry for package "${ownerName}"`);
}

export function normalizePairedList(
	rawList: readonly string[],
): string[] | { subpaths?: string[]; pairedJsSubpaths?: string[] } {
	const rawSet = new Set<string>(rawList);
	const pairedJsSubpaths: string[] = [];
	const consumed = new Set<string>();
	for (const item of rawList) {
		if (item.endsWith(".js")) continue;
		const jsSibling = `${item}.js`;
		if (rawSet.has(jsSibling)) {
			pairedJsSubpaths.push(item);
			consumed.add(item);
			consumed.add(jsSibling);
		}
	}
	const subpaths = rawList.filter(item => !consumed.has(item)).sort();
	pairedJsSubpaths.sort();
	if (pairedJsSubpaths.length === 0) return subpaths;
	return {
		...(subpaths.length > 0 ? { subpaths } : {}),
		...(pairedJsSubpaths.length > 0 ? { pairedJsSubpaths } : {}),
	};
}

export function loadLedgerFixture<T>(fixturePath: string, validator: (raw: unknown) => T, name: string): T {
	if (!existsSync(fixturePath)) {
		throw new Error(
			`${name} fixture not found at ${fixturePath}.\nCorrective action: Run the generator script to create the ledger.`,
		);
	}
	return validator(JSON.parse(readFileSync(fixturePath, "utf-8")));
}

export function writeJsonFixture(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(data, null, "\t")}\n`, "utf-8");
}

export function sortRecordArrays<T extends Record<string, readonly string[]>>(record: T): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(record)
			.map(([k, v]) => [k, [...v].sort()] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

export function sortRecord<T extends Record<string, unknown>>(record: T): Record<string, T[keyof T]> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) as Record<
		string,
		T[keyof T]
	>;
}
