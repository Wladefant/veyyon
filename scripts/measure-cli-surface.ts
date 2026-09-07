/**
 * Measures and derives the static CLI argument, command, and worker-selector surface.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { ensureBaselineAvailable, PINNED_BASELINE_COMMIT, REPO_ROOT, readGitFileText } from "./git-baseline";
import {
	assertObject,
	assertStringArray,
	loadLedgerFixture,
	sortRecord,
	validateLedgerHeader,
	writeJsonFixture,
} from "./ledger-schema";

export { REPO_ROOT };
export const CLI_SURFACE_SCHEMA_VERSION = 2;
export const DEFAULT_CLI_SURFACE_FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "cli-surface.json");

export const CLI_SURFACE_SOURCE_PATHS = [
	"packages/coding-agent/src/cli-commands.ts",
	"packages/coding-agent/src/cli/flag-tables.ts",
	"packages/coding-agent/src/cli/profile-bootstrap.ts",
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/worker-args.ts",
	"packages/coding-agent/src/launch/protocol.ts",
] as const;

export interface FlagSpec {
	takesValue: boolean;
}

export interface CliSurface {
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
}

export interface CliSurfaceAdditions {
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
}

export interface CliSurfaceApprovalLedger {
	schemaVersion: number;
	generatedFrom: string;
	additions: CliSurfaceAdditions;
}

export interface CliSurfaceLedger {
	schemaVersion: number;
	generatedFrom: string;
	commands: string[];
	flags: Record<string, FlagSpec>;
	workerSelectors: string[];
	additions: CliSurfaceAdditions;
}

export interface CliSurfaceSources {
	commandsSource: string;
	flagTablesSource: string;
	profileBootstrapSource: string;
	cliSource: string;
	workerArgsSource: string;
	protocolSource: string;
}

export function extractCommandsFromSource(source: string): string[] {
	const commands = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const stmt of ast.program.body) {
			const decl =
				stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
					? stmt.declaration
					: null;
			if (decl) {
				for (const d of decl.declarations) {
					if (d.id.type === "Identifier" && d.id.name === "commands" && d.init?.type === "ArrayExpression") {
						for (const el of d.init.elements) {
							if (el?.type === "ObjectExpression") {
								for (const p of el.properties) {
									if (
										p.type === "ObjectProperty" &&
										(p.key.type === "Identifier"
											? p.key.name
											: p.key.type === "StringLiteral"
												? p.key.value
												: "") === "name" &&
										p.value.type === "StringLiteral"
									) {
										commands.add(p.value.value);
									}
								}
							}
						}
					}
				}
			}
		}
	} catch {}
	return [...commands].sort();
}

export function extractFlagTablesFromSource(source: string): {
	stringFlags: string[];
	optionalFlags: string[];
	valuelessFlags: string[];
} {
	const stringFlags = new Set<string>();
	const optionalFlags = new Set<string>();
	const valuelessFlags = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const stmt of ast.program.body) {
			const decl =
				stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
					? stmt.declaration
					: null;
			if (decl) {
				for (const d of decl.declarations) {
					if (d.id.type === "Identifier") {
						const name = d.id.name;
						if ((name === "STRING_SETTERS" || name === "OPTIONAL_FLAGS") && d.init?.type === "ObjectExpression") {
							const target = name === "STRING_SETTERS" ? stringFlags : optionalFlags;
							for (const p of d.init.properties) {
								if (p.type === "ObjectProperty") {
									const key =
										p.key.type === "StringLiteral"
											? p.key.value
											: p.key.type === "Identifier"
												? p.key.name
												: null;
									if (key) target.add(key);
								}
							}
						} else if (name === "VALUELESS_FLAGS") {
							const arr =
								d.init?.type === "NewExpression" && d.init.arguments[0]?.type === "ArrayExpression"
									? d.init.arguments[0]
									: d.init?.type === "ArrayExpression"
										? d.init
										: null;
							if (arr) {
								for (const el of arr.elements) {
									if (el?.type === "StringLiteral") valuelessFlags.add(el.value);
								}
							}
						}
					}
				}
			}
		}
	} catch {}
	return {
		stringFlags: [...stringFlags].sort(),
		optionalFlags: [...optionalFlags].sort(),
		valuelessFlags: [...valuelessFlags].sort(),
	};
}

export function extractProfileFlagsFromSource(source: string): string[] {
	const flags = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const walk = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			const n = node as Record<string, unknown>;
			if (n.type === "BinaryExpression" && (n.operator === "===" || n.operator === "==")) {
				const left = n.left as Record<string, unknown> | undefined;
				const right = n.right as Record<string, unknown> | undefined;
				if (
					left?.type === "Identifier" &&
					left.name === "arg" &&
					right?.type === "StringLiteral" &&
					typeof right.value === "string" &&
					right.value.startsWith("-")
				) {
					flags.add(right.value);
				} else if (
					right?.type === "Identifier" &&
					right.name === "arg" &&
					left?.type === "StringLiteral" &&
					typeof left.value === "string" &&
					left.value.startsWith("-")
				) {
					flags.add(left.value);
				}
			}
			for (const key of Object.keys(n)) {
				const child = n[key];
				if (Array.isArray(child)) {
					for (const item of child) walk(item);
				} else if (
					child &&
					typeof child === "object" &&
					typeof (child as Record<string, unknown>).type === "string"
				) {
					walk(child);
				}
			}
		};
		walk(ast.program);
	} catch {}
	flags.add("--profile");
	flags.add("--alias");
	return [...flags].sort();
}

export function extractCliFlagsFromSource(source: string): string[] {
	const flags = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const walk = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			const n = node as Record<string, unknown>;
			if (n.type === "BinaryExpression" && (n.operator === "===" || n.operator === "==")) {
				const left = n.left as Record<string, unknown> | undefined;
				const right = n.right as Record<string, unknown> | undefined;
				if (
					(left?.type === "MemberExpression" || left?.type === "OptionalMemberExpression") &&
					right?.type === "StringLiteral" &&
					typeof right.value === "string" &&
					right.value.startsWith("-")
				) {
					flags.add(right.value);
				} else if (
					(right?.type === "MemberExpression" || right?.type === "OptionalMemberExpression") &&
					left?.type === "StringLiteral" &&
					typeof left.value === "string" &&
					left.value.startsWith("-")
				) {
					flags.add(left.value);
				}
			}
			for (const key of Object.keys(n)) {
				const child = n[key];
				if (Array.isArray(child)) {
					for (const item of child) walk(item);
				} else if (
					child &&
					typeof child === "object" &&
					typeof (child as Record<string, unknown>).type === "string"
				) {
					walk(child);
				}
			}
		};
		walk(ast.program);
	} catch {}
	return [...flags].sort();
}

export function extractWorkerArgsFromSource(source: string): string[] {
	const selectors = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const stmt of ast.program.body) {
			const decl =
				stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
					? stmt.declaration
					: null;
			if (decl) {
				for (const d of decl.declarations) {
					if (d.init?.type === "StringLiteral" && d.init.value.startsWith("__")) selectors.add(d.init.value);
				}
			}
		}
	} catch {}
	return [...selectors].sort();
}

export function extractProtocolWorkerArgsFromSource(source: string): string[] {
	const selectors = new Set<string>();
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const stmt of ast.program.body) {
			const decl =
				stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
					? stmt.declaration
					: null;
			if (decl) {
				for (const d of decl.declarations) {
					if (
						d.id.type === "Identifier" &&
						d.id.name === "DAEMON_BROKER_WORKER_ARG" &&
						d.init?.type === "StringLiteral"
					)
						selectors.add(d.init.value);
				}
			}
		}
	} catch {}
	return [...selectors].sort();
}

export function deriveCliSurfaceFromSources(sources: CliSurfaceSources): CliSurface {
	const commands = extractCommandsFromSource(sources.commandsSource);
	const { stringFlags, optionalFlags, valuelessFlags } = extractFlagTablesFromSource(sources.flagTablesSource);
	const profileFlags = extractProfileFlagsFromSource(sources.profileBootstrapSource);
	const cliFlags = extractCliFlagsFromSource(sources.cliSource);
	const flags: Record<string, FlagSpec> = {};
	for (const flag of stringFlags) flags[flag] = { takesValue: true };
	for (const flag of optionalFlags) flags[flag] = { takesValue: true };
	for (const flag of profileFlags) flags[flag] = { takesValue: true };
	for (const flag of valuelessFlags) flags[flag] = { takesValue: false };
	for (const flag of cliFlags) {
		if (!(flag in flags)) flags[flag] = { takesValue: false };
	}
	const workerArgs = extractWorkerArgsFromSource(sources.workerArgsSource);
	const protocolWorkerArgs = extractProtocolWorkerArgsFromSource(sources.protocolSource);
	const workerSelectors = [...new Set([...workerArgs, ...protocolWorkerArgs])].sort();
	return { commands, flags: sortRecord(flags), workerSelectors };
}

export function deriveCliSurface(root = REPO_ROOT): CliSurface {
	const read = (rel: string) => {
		const p = join(root, rel);
		return existsSync(p) ? readFileSync(p, "utf-8") : "";
	};
	return deriveCliSurfaceFromSources({
		commandsSource: read(CLI_SURFACE_SOURCE_PATHS[0]),
		flagTablesSource: read(CLI_SURFACE_SOURCE_PATHS[1]),
		profileBootstrapSource: read(CLI_SURFACE_SOURCE_PATHS[2]),
		cliSource: read(CLI_SURFACE_SOURCE_PATHS[3]),
		workerArgsSource: read(CLI_SURFACE_SOURCE_PATHS[4]),
		protocolSource: read(CLI_SURFACE_SOURCE_PATHS[5]),
	});
}

export function measureCliSurfaceFromGit(commit = PINNED_BASELINE_COMMIT, repoRoot = REPO_ROOT): CliSurface {
	ensureBaselineAvailable(repoRoot, commit);
	const readSource = (relativePath: string): string => {
		const source = readGitFileText(relativePath, commit, repoRoot);
		if (source === null)
			throw new Error(`Required CLI surface source file ${relativePath} is missing in git commit ${commit}`);
		return source;
	};
	return deriveCliSurfaceFromSources({
		commandsSource: readSource(CLI_SURFACE_SOURCE_PATHS[0]),
		flagTablesSource: readSource(CLI_SURFACE_SOURCE_PATHS[1]),
		profileBootstrapSource: readSource(CLI_SURFACE_SOURCE_PATHS[2]),
		cliSource: readSource(CLI_SURFACE_SOURCE_PATHS[3]),
		workerArgsSource: readSource(CLI_SURFACE_SOURCE_PATHS[4]),
		protocolSource: readSource(CLI_SURFACE_SOURCE_PATHS[5]),
	});
}

export function validateCliSurfaceApprovalLedger(raw: unknown): CliSurfaceApprovalLedger {
	const ledger = validateLedgerHeader(raw, CLI_SURFACE_SCHEMA_VERSION, PINNED_BASELINE_COMMIT, "CLI surface ledger");
	const additions = assertObject(ledger.additions, "CLI surface ledger is missing additions record");
	assertStringArray(additions.commands, "CLI surface ledger additions.commands must be an array");
	const flags = assertObject(additions.flags, "CLI surface ledger additions.flags must be an object");
	for (const [flag, spec] of Object.entries(flags)) {
		if (!spec || typeof spec !== "object" || typeof (spec as FlagSpec).takesValue !== "boolean") {
			throw new Error(`CLI surface ledger flag spec for "${flag}" must have boolean takesValue`);
		}
	}
	assertStringArray(additions.workerSelectors, "CLI surface ledger additions.workerSelectors must be an array");
	return raw as CliSurfaceApprovalLedger;
}

export function loadCliSurfaceLedger(
	fixturePath = DEFAULT_CLI_SURFACE_FIXTURE_PATH,
	repoRoot = REPO_ROOT,
): CliSurfaceLedger {
	const approval = loadLedgerFixture(fixturePath, validateCliSurfaceApprovalLedger, "CLI surface ledger");
	const baseSurface = measureCliSurfaceFromGit(approval.generatedFrom, repoRoot);
	return {
		schemaVersion: approval.schemaVersion,
		generatedFrom: approval.generatedFrom,
		commands: baseSurface.commands,
		flags: baseSurface.flags,
		workerSelectors: baseSurface.workerSelectors,
		additions: approval.additions,
	};
}

export function buildLedger(
	baseSurface: CliSurface,
	currentSurface: CliSurface,
	generatedFrom: string = PINNED_BASELINE_COMMIT,
): CliSurfaceLedger {
	const baseCommandSet = new Set(baseSurface.commands);
	const addedCommands = currentSurface.commands.filter(c => !baseCommandSet.has(c));
	const addedFlags: Record<string, FlagSpec> = {};
	for (const [flag, spec] of Object.entries(currentSurface.flags)) {
		if (!(flag in baseSurface.flags)) addedFlags[flag] = spec;
	}
	const baseWorkerSet = new Set(baseSurface.workerSelectors);
	const addedWorkerSelectors = currentSurface.workerSelectors.filter(w => !baseWorkerSet.has(w));
	return {
		schemaVersion: CLI_SURFACE_SCHEMA_VERSION,
		generatedFrom,
		commands: baseSurface.commands,
		flags: baseSurface.flags,
		workerSelectors: baseSurface.workerSelectors,
		additions: {
			commands: addedCommands,
			flags: sortRecord(addedFlags),
			workerSelectors: addedWorkerSelectors,
		},
	};
}

export function buildApprovalLedger(
	baseSurface: CliSurface,
	currentSurface: CliSurface,
	generatedFrom: string = PINNED_BASELINE_COMMIT,
): CliSurfaceApprovalLedger {
	const full = buildLedger(baseSurface, currentSurface, generatedFrom);
	return {
		schemaVersion: full.schemaVersion,
		generatedFrom: full.generatedFrom,
		additions: full.additions,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const baseFlag = args.indexOf("--base");
	const shaFlag = args.indexOf("--from");
	const fullFlag = args.includes("--full");
	const generatedFrom = shaFlag === -1 ? PINNED_BASELINE_COMMIT : (args[shaFlag + 1] ?? "");
	if (generatedFrom === "") {
		process.stderr.write("--from needs a sha\n");
		process.exit(2);
	}
	const baseSurface =
		baseFlag !== -1 && args[baseFlag + 1] !== undefined
			? deriveCliSurface(resolve(args[baseFlag + 1]))
			: measureCliSurfaceFromGit(generatedFrom, REPO_ROOT);
	const currentSurface = deriveCliSurface(REPO_ROOT);
	const outPath = DEFAULT_CLI_SURFACE_FIXTURE_PATH;
	if (fullFlag) {
		const fullLedger = buildLedger(baseSurface, currentSurface, generatedFrom);
		writeJsonFixture(outPath, fullLedger);
		process.stdout.write(`Wrote full CLI surface ledger to ${outPath}\n`);
	} else {
		const approvalLedger = buildApprovalLedger(baseSurface, currentSurface, generatedFrom);
		writeJsonFixture(outPath, approvalLedger);
		process.stdout.write(`Wrote sparse CLI surface approval fixture to ${outPath}\n`);
	}
}
