/**
 * Measure the published surface area (manifest identity, entrypoints, subpath exports,
 * and barrel exports) across git revisions and workspace members.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type {
	ArrayPattern,
	Declaration,
	ExportNamedDeclaration,
	ExportSpecifier,
	Identifier,
	Node,
	ObjectPattern,
	RestElement,
} from "@babel/types";
import { existingOnly } from "./check-doc-links";
import {
	batchReadGitBlobs,
	ensureBaselineAvailable,
	PINNED_BASELINE_COMMIT,
	REPO_ROOT,
	readGitTree,
} from "./git-baseline";
import {
	assertObject,
	assertStringArray,
	expandAliasRecords,
	expandPairedList,
	loadLedgerFixture,
	normalizeAliasRecords,
	normalizePairedList,
	resolveModuleSpecifierOnDisk,
	validateLedgerHeader,
	writeJsonFixture,
} from "./ledger-schema";
import { typeScriptMembersOf } from "./workspace-layout";

export const PUBLISHED_SURFACE_SCHEMA_VERSION = 2;
export const FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "published-surface.json");

export interface PackageManifestRecord {
	readonly name: string;
	readonly directory: string;
	readonly private: boolean;
	readonly version: string | null;
	readonly main: string | null;
	readonly module: string | null;
	readonly types: string | null;
	readonly binKeys: readonly string[];
	readonly exportsKeys: readonly string[];
	readonly resolvedSubpaths: readonly string[];
	readonly entrypoint: string | null;
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
}

export interface PackageAddedResolvedSubpaths {
	readonly subpaths?: readonly string[];
	readonly pairedJsSubpaths?: readonly string[];
}

export type RawPackageAddedResolvedSubpaths = readonly string[] | PackageAddedResolvedSubpaths;

export interface AdditionsRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly resolvedSubpaths: Readonly<Record<string, readonly string[]>>;
	readonly namedExports: Readonly<Record<string, readonly string[]>>;
	readonly starEdges: Readonly<Record<string, readonly string[]>>;
	readonly binKeys: Readonly<Record<string, readonly string[]>>;
}

export interface AdditionsApprovalRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly resolvedSubpaths: Readonly<Record<string, RawPackageAddedResolvedSubpaths>>;
	readonly namedExports: Readonly<Record<string, readonly string[]>>;
	readonly starEdges: Readonly<Record<string, readonly string[]>>;
	readonly binKeys: Readonly<Record<string, readonly string[]>>;
}

export interface RelocationNote {
	readonly to: string;
	readonly why: string;
}

export interface PackageResolvedSubpathsRelocations {
	readonly records: Readonly<Record<string, RelocationNote>>;
	readonly jsAliases?: {
		readonly suffixReason?: readonly string[];
		readonly sameReason?: readonly string[];
	};
}

export type RawPackageResolvedSubpathsRelocations =
	| Readonly<Record<string, RelocationNote>>
	| PackageResolvedSubpathsRelocations;

export interface RelocationsRecord {
	readonly exportsKeys: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly resolvedSubpaths: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly starEdges: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface RelocationsApprovalRecord {
	readonly exportsKeys: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly resolvedSubpaths: Readonly<Record<string, RawPackageResolvedSubpathsRelocations>>;
	readonly starEdges: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface PublishedSurfaceLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly packages: Readonly<Record<string, PackageManifestRecord>>;
	readonly additions: AdditionsRecord;
	readonly relocations: RelocationsRecord;
}

export interface PublishedSurfaceApprovalLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly additions: AdditionsApprovalRecord;
	readonly relocations: RelocationsApprovalRecord;
}

export interface WorkspacePackageSnapshot extends PackageManifestRecord {
	readonly entrypointFilePath: string | null;
}

export function filesUnderMember(member: string, repoRoot: string = REPO_ROOT): string[] {
	let stdout: Buffer;
	try {
		stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", member], {
			cwd: repoRoot,
			encoding: "buffer",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		throw new Error(
			`Failed to enumerate files under "${member}" via git ls-files at ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const raw = stdout.toString("utf-8");
	if (raw.length === 0) return [];
	return existingOnly(
		repoRoot,
		raw.split("\0").filter(entry => entry.length > 0),
	).filter(entry => {
		const full = join(repoRoot, entry);
		return statSync(full).isFile();
	});
}

export function exportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const key of ["import", "default", "node", "types", "require"]) {
		const candidate = record[key];
		if (typeof candidate === "string") return candidate;
		if (candidate !== null && typeof candidate === "object") {
			const nested = exportTarget(candidate);
			if (nested !== null) return nested;
		}
	}
	return null;
}

export function expandExportsToFileMap(
	exportsField: unknown,
	packageDir: string,
	files: readonly string[],
): Map<string, string> {
	const resolved = new Map<string, string>();
	if (typeof exportsField === "string") {
		resolved.set(".", posix.join(packageDir, exportsField.replace(/^\.\//, "")));
		return resolved;
	}
	if (exportsField === null || typeof exportsField !== "object") return resolved;
	const prefix = `${packageDir}/`;
	const inPackage = files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length));

	for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
		const target = exportTarget(value);
		if (target === null) continue;
		const cleaned = target.replace(/^\.\//, "");
		if (!key.includes("*")) {
			if (!cleaned.includes("*") && inPackage.includes(cleaned)) resolved.set(key, prefix + cleaned);
			continue;
		}
		const star = cleaned.indexOf("*");
		if (star < 0) continue;
		const head = cleaned.slice(0, star);
		const tail = cleaned.slice(star + 1);
		for (const file of inPackage) {
			if (!file.startsWith(head) || !file.endsWith(tail)) continue;
			const middle = file.slice(head.length, file.length - tail.length);
			if (middle.length === 0) continue;
			resolved.set(key.replace("*", middle), prefix + file);
		}
	}

	return resolved;
}

export function expandExportsToSubpaths(exportsField: unknown, packageDir: string, files: readonly string[]): string[] {
	return [...expandExportsToFileMap(exportsField, packageDir, files).keys()].sort();
}

export function resolveEntrypoint(pkgData: { exports?: unknown; main?: string; module?: string }): string | null {
	const exp = pkgData.exports;
	if (typeof exp === "string") return exp;
	if (exp && typeof exp === "object" && "." in exp) {
		const dot = (exp as Record<string, unknown>)["."];
		if (typeof dot === "string") return dot;
		if (dot && typeof dot === "object") {
			const record = dot as Record<string, unknown>;
			const candidate = record.import ?? record.default ?? record.types;
			if (typeof candidate === "string") return candidate;
		}
	}
	if (typeof pkgData.main === "string") return pkgData.main;
	if (typeof pkgData.module === "string") return pkgData.module;
	return null;
}

export function extractPatternIdentifiers(patternNode: Node | null | undefined, names: Set<string>): void {
	if (!patternNode) return;
	if (patternNode.type === "Identifier") {
		names.add((patternNode as Identifier).name);
	} else if (patternNode.type === "ObjectPattern") {
		const obj = patternNode as ObjectPattern;
		for (const prop of obj.properties) {
			if (prop.type === "ObjectProperty") {
				extractPatternIdentifiers(prop.value, names);
			} else if (prop.type === "RestElement") {
				extractPatternIdentifiers((prop as RestElement).argument, names);
			}
		}
	} else if (patternNode.type === "ArrayPattern") {
		const arr = patternNode as ArrayPattern;
		for (const el of arr.elements) {
			if (el) extractPatternIdentifiers(el, names);
		}
	} else if (patternNode.type === "RestElement") {
		extractPatternIdentifiers((patternNode as RestElement).argument, names);
	} else if (patternNode.type === "AssignmentPattern") {
		extractPatternIdentifiers(patternNode.left, names);
	}
}

export function parseBarrelSource(code: string): {
	namedExports: string[];
	starEdges: string[];
} {
	const ast = parseBabel(code, {
		sourceType: "module",
		plugins: ["typescript", "jsx"],
	});

	const namedExports = new Set<string>();
	const starEdges = new Set<string>();

	for (const node of ast.program.body) {
		if (node.type === "ExportNamedDeclaration") {
			const named = node as ExportNamedDeclaration;
			if (named.declaration) {
				const decl = named.declaration as Declaration;
				if (decl.type === "VariableDeclaration") {
					for (const d of decl.declarations) {
						extractPatternIdentifiers(d.id, namedExports);
					}
				} else if (
					decl.type === "FunctionDeclaration" ||
					decl.type === "ClassDeclaration" ||
					decl.type === "TSTypeAliasDeclaration" ||
					decl.type === "TSInterfaceDeclaration" ||
					decl.type === "TSEnumDeclaration" ||
					decl.type === "TSModuleDeclaration"
				) {
					if (decl.id && "name" in decl.id && typeof decl.id.name === "string") {
						namedExports.add(decl.id.name);
					}
				}
			}
			if (named.specifiers) {
				for (const spec of named.specifiers) {
					if (spec.type === "ExportSpecifier") {
						const exportSpec = spec as ExportSpecifier;
						const name =
							exportSpec.exported.type === "Identifier" ? exportSpec.exported.name : exportSpec.exported.value;
						namedExports.add(name);
					} else if (spec.type === "ExportNamespaceSpecifier") {
						namedExports.add(spec.exported.name);
					}
				}
			}
		} else if (node.type === "ExportAllDeclaration") {
			starEdges.add(node.source.value);
		}
	}

	return {
		namedExports: [...namedExports].sort(),
		starEdges: [...starEdges].sort(),
	};
}

let workspaceDirectoriesByRepo: Map<string, Map<string, string>> | undefined;

export function memberDirectoryOf(packageName: string, repoRoot: string = REPO_ROOT): string | undefined {
	if (workspaceDirectoriesByRepo === undefined) {
		workspaceDirectoriesByRepo = new Map();
	}
	let dirs = workspaceDirectoriesByRepo.get(repoRoot);
	if (dirs === undefined) {
		dirs = new Map();
		for (const member of typeScriptMembersOf(repoRoot)) {
			const manifestPath = join(repoRoot, member, "package.json");
			if (!existsSync(manifestPath)) continue;
			const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
			if (typeof data.name === "string") dirs.set(data.name, join(repoRoot, member));
		}
		workspaceDirectoriesByRepo.set(repoRoot, dirs);
	}
	return dirs.get(packageName);
}

export function resolveStarSpecifierToDisk(
	fromFile: string,
	specifier: string,
	repoRoot: string = REPO_ROOT,
): string | null {
	return resolveModuleSpecifierOnDisk(fromFile, specifier, pkg => memberDirectoryOf(pkg, repoRoot));
}

export function expandResolvedSubpathsRecord(raw: unknown, pkgName: string): Record<string, RelocationNote> {
	return expandAliasRecords(raw, pkgName);
}

export function normalizeResolvedSubpathsRecord(
	rawMap: Record<string, RelocationNote>,
): PackageResolvedSubpathsRelocations | Record<string, RelocationNote> {
	return normalizeAliasRecords(rawMap);
}

export function expandAddedResolvedSubpaths(rawAdded: unknown, pkgName: string): string[] {
	return expandPairedList(rawAdded, pkgName);
}

export function normalizeAddedResolvedSubpaths(rawList: readonly string[]): RawPackageAddedResolvedSubpaths {
	return normalizePairedList(rawList);
}

export function validatePublishedSurfaceLedger(raw: unknown): PublishedSurfaceApprovalLedger {
	const ledger = validateLedgerHeader(
		raw,
		PUBLISHED_SURFACE_SCHEMA_VERSION,
		PINNED_BASELINE_COMMIT,
		"Published surface ledger",
	);
	const additions = assertObject(ledger.additions, "Published surface ledger is missing additions record");
	assertStringArray(
		additions.packages,
		"Published surface ledger additions.packages must be an array",
		"Published surface ledger additions.packages elements must be strings",
	);
	for (const field of ["exportsKeys", "resolvedSubpaths", "namedExports", "starEdges", "binKeys"] as const) {
		const groups = assertObject(additions[field], `Published surface ledger additions.${field} must be an object`);
		for (const [pkg, keys] of Object.entries(groups)) {
			if (field === "resolvedSubpaths") {
				expandAddedResolvedSubpaths(keys as RawPackageAddedResolvedSubpaths, pkg);
			} else {
				assertStringArray(
					keys,
					`Published surface ledger additions.${field}["${pkg}"] must be an array`,
					`Published surface ledger additions.${field}["${pkg}"] elements must be strings`,
				);
			}
		}
	}
	const relocations = assertObject(ledger.relocations, "Published surface ledger is missing relocations record");
	const expKeys = assertObject(
		relocations.exportsKeys,
		"Published surface ledger relocations.exportsKeys must be an object",
	);
	for (const [pkg, map] of Object.entries(expKeys)) {
		const mapObj = assertObject(map, `Published surface ledger relocations.exportsKeys["${pkg}"] must be an object`);
		for (const [subpath, note] of Object.entries(mapObj)) {
			const noteObj = assertObject(
				note,
				`Invalid relocation note for "${subpath}" in relocations.exportsKeys["${pkg}"]: must have string "to" and "why"`,
			);
			if (typeof noteObj.to !== "string" || typeof noteObj.why !== "string") {
				throw new Error(
					`Invalid relocation note for "${subpath}" in relocations.exportsKeys["${pkg}"]: must have string "to" and "why"`,
				);
			}
		}
	}
	const resSub = assertObject(
		relocations.resolvedSubpaths,
		"Published surface ledger relocations.resolvedSubpaths must be an object",
	);
	for (const [pkgName, pkgRel] of Object.entries(resSub)) {
		expandResolvedSubpathsRecord(pkgRel as RawPackageResolvedSubpathsRelocations, pkgName);
	}
	const starEd = assertObject(
		relocations.starEdges,
		"Published surface ledger relocations.starEdges must be an object",
	);
	for (const [pkg, map] of Object.entries(starEd)) {
		const mapObj = assertObject(map, `Published surface ledger relocations.starEdges["${pkg}"] must be an object`);
		for (const [fromEdge, toEdge] of Object.entries(mapObj)) {
			if (typeof toEdge !== "string") {
				throw new Error(
					`Invalid starEdge relocation for "${fromEdge}" in relocations.starEdges["${pkg}"]: target must be a string`,
				);
			}
		}
	}
	for (const key of Object.keys(ledger)) {
		if (key !== "schemaVersion" && key !== "generatedFrom" && key !== "additions" && key !== "relocations") {
			throw new Error(`Unknown top-level property "${key}" in published surface ledger`);
		}
	}
	return raw as PublishedSurfaceApprovalLedger;
}

export interface BuildPackageManifestOptions {
	directory: string;
	manifestData: Record<string, unknown>;
	files: readonly string[];
	entrypointSource?: string | null;
}

export function buildPackageManifestRecord(options: BuildPackageManifestOptions): PackageManifestRecord {
	const { directory, manifestData, files, entrypointSource } = options;
	const name = typeof manifestData.name === "string" ? manifestData.name : directory;
	const priv = Boolean(manifestData.private);
	const version = typeof manifestData.version === "string" ? manifestData.version : null;
	const main = typeof manifestData.main === "string" ? manifestData.main : null;
	const module = typeof manifestData.module === "string" ? manifestData.module : null;
	const types = typeof manifestData.types === "string" ? manifestData.types : null;

	const binKeys =
		typeof manifestData.bin === "object" && manifestData.bin !== null && !Array.isArray(manifestData.bin)
			? Object.keys(manifestData.bin as Record<string, unknown>).sort()
			: typeof manifestData.bin === "string"
				? [name.split("/").pop() ?? name]
				: [];

	const exportsKeys =
		typeof manifestData.exports === "object" && manifestData.exports !== null && !Array.isArray(manifestData.exports)
			? Object.keys(manifestData.exports as Record<string, unknown>).sort()
			: typeof manifestData.exports === "string"
				? ["."]
				: [];

	const resolvedSubpaths = expandExportsToSubpaths(manifestData.exports, directory, files);
	const entrypoint = resolveEntrypoint(manifestData);

	let namedExports: string[] = [];
	let starEdges: string[] = [];
	if (entrypoint && entrypointSource) {
		const parsed = parseBarrelSource(entrypointSource);
		namedExports = parsed.namedExports;
		starEdges = parsed.starEdges;
	}

	return {
		name,
		directory,
		private: priv,
		version,
		main,
		module,
		types,
		binKeys,
		exportsKeys,
		resolvedSubpaths,
		entrypoint,
		namedExports,
		starEdges,
	};
}

export async function measurePublishedSurface(
	ref: string = PINNED_BASELINE_COMMIT,
	repoRoot: string = REPO_ROOT,
): Promise<Record<string, PackageManifestRecord>> {
	ensureBaselineAvailable(repoRoot, ref);
	const tree = readGitTree(ref, repoRoot);
	const allFiles = [...tree.keys()];

	const candidateManifestPaths = allFiles.filter(f => f.endsWith("/package.json") && f !== "package.json");

	const manifestSpecs = ["package.json", ...candidateManifestPaths].map(p => `${ref}:${p}`);
	const manifestBlobs = await batchReadGitBlobs(manifestSpecs, repoRoot);

	const rootManifestBuffer = manifestBlobs.get(`${ref}:package.json`);
	if (!rootManifestBuffer) {
		throw new Error(`Could not read root package.json at ${ref}`);
	}
	const rootManifest = JSON.parse(rootManifestBuffer.toString("utf-8")) as {
		workspaces?: { packages?: string[] } | string[];
	};
	const globs = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: (rootManifest.workspaces?.packages ?? []);

	const matchedManifests: Array<{ dir: string; manifestPath: string; data: Record<string, unknown> }> = [];
	for (const f of candidateManifestPaths) {
		const d = f.slice(0, -"/package.json".length);
		let matched = false;
		for (const g of globs) {
			if (g.endsWith("/*")) {
				const prefix = g.slice(0, -2);
				if (d.startsWith(`${prefix}/`) && !d.slice(prefix.length + 1).includes("/")) {
					matched = true;
					break;
				}
			} else if (g === d) {
				matched = true;
				break;
			}
		}
		if (matched) {
			const buf = manifestBlobs.get(`${ref}:${f}`);
			if (buf) {
				matchedManifests.push({
					dir: d,
					manifestPath: f,
					data: JSON.parse(buf.toString("utf-8")) as Record<string, unknown>,
				});
			}
		}
	}
	matchedManifests.sort((a, b) => a.dir.localeCompare(b.dir));

	const entrypointSpecs: string[] = [];
	const memberEntrypoints: Map<string, string> = new Map();
	for (const member of matchedManifests) {
		const entry = resolveEntrypoint(member.data);
		if (entry) {
			const entryRelative = entry.replace(/^\.\//, "");
			const entryFilePath = posix.join(member.dir, entryRelative);
			entrypointSpecs.push(`${ref}:${entryFilePath}`);
			memberEntrypoints.set(member.dir, entryFilePath);
		}
	}

	const entrypointBlobs = entrypointSpecs.length > 0 ? await batchReadGitBlobs(entrypointSpecs, repoRoot) : new Map();

	const packages: Record<string, PackageManifestRecord> = {};
	for (const member of matchedManifests) {
		const name = typeof member.data.name === "string" ? member.data.name : member.dir;
		const entryFilePath = memberEntrypoints.get(member.dir);
		let entrypointSource: string | null = null;
		if (entryFilePath) {
			const buf = entrypointBlobs.get(`${ref}:${entryFilePath}`);
			if (buf) entrypointSource = buf.toString("utf-8");
		}

		packages[name] = buildPackageManifestRecord({
			directory: member.dir,
			manifestData: member.data,
			files: allFiles,
			entrypointSource,
		});
	}

	return packages;
}

export function loadHeadPackages(repoRoot: string = REPO_ROOT): Map<string, WorkspacePackageSnapshot> {
	const members = typeScriptMembersOf(repoRoot);
	const packages = new Map<string, WorkspacePackageSnapshot>();

	for (const member of members) {
		const manifestPath = join(repoRoot, member, "package.json");
		if (!existsSync(manifestPath)) continue;

		const raw = readFileSync(manifestPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const name = typeof data.name === "string" ? data.name : member;
		const priv = Boolean(data.private);
		const version = typeof data.version === "string" ? data.version : null;
		const main = typeof data.main === "string" ? data.main : null;
		const module = typeof data.module === "string" ? data.module : null;
		const types = typeof data.types === "string" ? data.types : null;

		const binKeys =
			typeof data.bin === "object" && data.bin !== null && !Array.isArray(data.bin)
				? Object.keys(data.bin as Record<string, unknown>).sort()
				: typeof data.bin === "string"
					? [name.split("/").pop() ?? name]
					: [];

		const exportsKeys =
			typeof data.exports === "object" && data.exports !== null && !Array.isArray(data.exports)
				? Object.keys(data.exports as Record<string, unknown>).sort()
				: typeof data.exports === "string"
					? ["."]
					: [];

		const resolvedSubpaths = expandExportsToSubpaths(data.exports, member, filesUnderMember(member, repoRoot));

		const entrypoint = resolveEntrypoint(data);
		let namedExports: string[] = [];
		let starEdges: string[] = [];
		let entrypointFilePath: string | null = null;

		if (entrypoint) {
			const entryRelative = entrypoint.replace(/^\.\//, "");
			const resolvedPath = resolve(repoRoot, member, entryRelative);
			if (existsSync(resolvedPath)) {
				entrypointFilePath = resolvedPath;
				const source = readFileSync(resolvedPath, "utf-8");
				const parsed = parseBarrelSource(source);
				namedExports = parsed.namedExports;
				starEdges = parsed.starEdges;
			}
		}

		packages.set(name, {
			name,
			directory: member,
			private: priv,
			version,
			main,
			module,
			types,
			binKeys,
			exportsKeys,
			resolvedSubpaths,
			entrypoint,
			entrypointFilePath,
			namedExports,
			starEdges,
		});
	}

	return packages;
}

export async function loadPublishedSurfaceLedger(
	fixturePath: string = FIXTURE_PATH,
	repoRoot: string = REPO_ROOT,
): Promise<PublishedSurfaceLedger> {
	const approval = loadLedgerFixture(fixturePath, validatePublishedSurfaceLedger, "Published surface ledger");
	const packages = await measurePublishedSurface(approval.generatedFrom, repoRoot);

	const expandedResolvedSubpaths: Record<string, string[]> = {};
	for (const [pkg, rawAdded] of Object.entries(approval.additions.resolvedSubpaths)) {
		expandedResolvedSubpaths[pkg] = expandAddedResolvedSubpaths(rawAdded, pkg);
	}

	const additions: AdditionsRecord = {
		packages: [...approval.additions.packages].sort(),
		exportsKeys: approval.additions.exportsKeys as Record<string, string[]>,
		resolvedSubpaths: expandedResolvedSubpaths,
		namedExports: approval.additions.namedExports as Record<string, string[]>,
		starEdges: approval.additions.starEdges as Record<string, string[]>,
		binKeys: approval.additions.binKeys as Record<string, string[]>,
	};

	const expandedRelocationsResolved: Record<string, Record<string, RelocationNote>> = {};
	for (const [pkg, rawRel] of Object.entries(approval.relocations.resolvedSubpaths)) {
		expandedRelocationsResolved[pkg] = expandResolvedSubpathsRecord(rawRel, pkg);
	}

	const relocations: RelocationsRecord = {
		exportsKeys: approval.relocations.exportsKeys as Record<string, Record<string, RelocationNote>>,
		resolvedSubpaths: expandedRelocationsResolved,
		starEdges: approval.relocations.starEdges as Record<string, Record<string, string>>,
	};

	return {
		schemaVersion: approval.schemaVersion,
		generatedFrom: approval.generatedFrom,
		packages,
		additions,
		relocations,
	};
}

export async function generateLedger(
	baseRef: string = PINNED_BASELINE_COMMIT,
	headRef: string = "HEAD",
	repoRoot: string = REPO_ROOT,
): Promise<PublishedSurfaceLedger> {
	const fixturePath = join(repoRoot, "scripts", "fixtures", "published-surface.json");
	const previous = existsSync(fixturePath) ? await loadPublishedSurfaceLedger(fixturePath, repoRoot) : undefined;
	const basePackages =
		previous?.generatedFrom === baseRef ? previous.packages : await measurePublishedSurface(baseRef, repoRoot);
	const headPackages =
		headRef === "HEAD"
			? loadHeadPackages(repoRoot)
			: new Map<string, WorkspacePackageSnapshot | PackageManifestRecord>(
					Object.entries(await measurePublishedSurface(headRef, repoRoot)),
				);
	const addedPackageNames = [...headPackages.keys()].filter(name => !(name in basePackages)).sort();

	const addedExportsKeys: Record<string, string[]> = {};
	const addedNamedExports: Record<string, string[]> = {};
	const addedStarEdges: Record<string, string[]> = {};
	const addedBinKeys: Record<string, string[]> = {};
	const addedResolvedSubpaths: Record<string, string[]> = {};

	for (const [name, headPkg] of headPackages.entries()) {
		const basePkg = basePackages[name];
		if (!basePkg) continue;
		const expDiff = headPkg.exportsKeys.filter(k => !basePkg.exportsKeys.includes(k)).sort();
		if (expDiff.length > 0) addedExportsKeys[name] = expDiff;
		const namedDiff = headPkg.namedExports.filter(k => !basePkg.namedExports.includes(k)).sort();
		if (namedDiff.length > 0) addedNamedExports[name] = namedDiff;
		const starDiff = headPkg.starEdges.filter(k => !basePkg.starEdges.includes(k)).sort();
		if (starDiff.length > 0) addedStarEdges[name] = starDiff;
		const binDiff = headPkg.binKeys.filter(k => !basePkg.binKeys.includes(k)).sort();
		if (binDiff.length > 0) addedBinKeys[name] = binDiff;
		const resDiff = headPkg.resolvedSubpaths.filter(k => !basePkg.resolvedSubpaths.includes(k)).sort();
		if (resDiff.length > 0) addedResolvedSubpaths[name] = resDiff;
	}

	const additions: AdditionsRecord = {
		packages: addedPackageNames,
		exportsKeys: addedExportsKeys,
		resolvedSubpaths: addedResolvedSubpaths,
		namedExports: addedNamedExports,
		starEdges: addedStarEdges,
		binKeys: addedBinKeys,
	};

	const approvalAdditions: AdditionsApprovalRecord = {
		packages: addedPackageNames,
		exportsKeys: addedExportsKeys,
		resolvedSubpaths: Object.fromEntries(
			Object.entries(addedResolvedSubpaths).map(([k, v]) => [k, normalizeAddedResolvedSubpaths(v)]),
		),
		namedExports: addedNamedExports,
		starEdges: addedStarEdges,
		binKeys: addedBinKeys,
	};

	const approvalRelocations: RelocationsApprovalRecord = previous?.relocations
		? {
				exportsKeys: previous.relocations.exportsKeys,
				resolvedSubpaths: Object.fromEntries(
					Object.entries(previous.relocations.resolvedSubpaths).map(([k, v]) => [
						k,
						normalizeResolvedSubpathsRecord(v),
					]),
				),
				starEdges: previous.relocations.starEdges,
			}
		: { exportsKeys: {}, resolvedSubpaths: {}, starEdges: {} };

	const approvalFixture: PublishedSurfaceApprovalLedger = {
		schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
		generatedFrom: baseRef,
		additions: approvalAdditions,
		relocations: approvalRelocations,
	};

	writeJsonFixture(fixturePath, approvalFixture);

	return {
		schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
		generatedFrom: baseRef,
		packages: basePackages,
		additions,
		relocations: previous?.relocations ?? { exportsKeys: {}, resolvedSubpaths: {}, starEdges: {} },
	};
}
if (import.meta.main) {
	const ledger = await generateLedger();
	process.stdout.write(
		`verified published surface against ${ledger.generatedFrom}: ${Object.keys(ledger.packages).length} packages\n`,
	);
}
