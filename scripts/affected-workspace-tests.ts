import * as nodeChildProcess from "node:child_process";
import * as nodeModule from "node:module";
import * as nodePath from "node:path";
import * as tsNamespace from "typescript";
const ts = "createSourceFile" in tsNamespace
	? tsNamespace
	: ("default" in tsNamespace && tsNamespace.default && typeof tsNamespace.default === "object"
		? (tsNamespace.default as typeof tsNamespace)
		: tsNamespace);
import {
	buildWorkspaceDependencyGraph,
	resolveWorkspaceMemberDirectories,
	reverseDependencyClosure,
	type WorkspaceDependencyGraph,
	type WorkspaceGraphEntry,
	type WorkspaceGraphNode,
} from "./workspace-layout";

export const AFFECTED_SELECTOR_ID = "affected-workspace-tests-v1";
export const AFFECTED_STATIC_DEPENDENCY_POLICY =
	"Workspace graphs combine manifest dependencies with parser-resolved TypeScript/JavaScript imports. Counts are unique cross-member import edges per revision. Unresolved or undeclared targets force full coverage. Non-literal loaders in audited files add potential edges to every workspace member; any other non-literal loader forces full coverage. Non-code reader dependencies are explicit CI contract mappings, not statically discovered filesystem calls; unowned or unmapped paths force full coverage, and mapped reader targets must exist at HEAD.";
export interface AffectedDynamicImportSite {
	file: string;
	owner: string;
	maxCalls: number;
	targetPolicy: "all-workspace-members";
}

/** Each non-literal loader site has a named AST owner and call bound. */
export const AFFECTED_DYNAMIC_IMPORT_SITES: readonly AffectedDynamicImportSite[] = [
	{
		file: "packages/ai/test/usage-provider-registry.test.ts",
		owner: "test:warns once, names the missing import, and still answers honestly",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/eval/js/shared/local-module-loader.ts",
		owner: "method:#ensureExternalModule",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/eval/js/shared/runtime.ts",
		owner: "property:__veyyon_import__",
		maxCalls: 2,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/eval/js/shared/runtime.ts",
		owner: "property:__veyyon_import_from__",
		maxCalls: 2,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/export/custom-share.ts",
		owner: "function:loadCustomShare",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/export/markit/converters/pdf/extract.ts",
		owner: "function:loadMupdf",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/extensibility/custom-commands/loader.ts",
		owner: "function:loadCommandModule",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/extensibility/custom-tools/loader.ts",
		owner: "function:loadTool",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts",
		owner: "function:loadLegacyPiModule",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/extensibility/legacy-pi-ai-type-remap.test.ts",
		owner: "test:falls back to legacy-scoped subpath peers for direct plugin imports",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/extensibility/legacy-pi-inplace-load.test.ts",
		owner: "test:does not rewrite sibling files outside the loaded extension's import graph",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/fixtures/legacy-module-table.ts",
		owner: "function:bundleEntry",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/oracles/historical-loader.ts",
		owner: "function:loadHistoricalOracle",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/tools/agent/vibe-runtime-export-surface.test.ts",
		owner: "test:does not export the CLI-to-agent mapping or the turn error",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/coding-agent/test/tools/agent/vibe-runtime-export-surface.test.ts",
		owner: "test:still exports the registry the module exists for",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "packages/utils/test/runtime-install.test.ts",
		owner: "test:a sibling CommonJS require resolves after the patch is removed",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "plugins/argot/test/dict-version-round-trip.test.ts",
		owner: "test:stamps whatever the constant says, at both sites, so neither duplicates the literal",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "tests/evals/engine/member-discovery.ts",
		owner: "function:loadMembers",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "natives/bridge/bindings/test/a-source-tree-never-claims-to-be-compiled.test.ts",
		owner: "test:exports null in a source checkout",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
	{
		file: "natives/bridge/bindings/test/a-source-tree-never-claims-to-be-compiled.test.ts",
		owner: "test:is a flag that chooses the stub, and its absence the populated module",
		maxCalls: 1,
		targetPolicy: "all-workspace-members",
	},
];

export const AFFECTED_DYNAMIC_IMPORT_LOADER_FILES: readonly string[] = Array.from(
	new Set(AFFECTED_DYNAMIC_IMPORT_SITES.map(site => site.file)),
).sort();

const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface GitReadOptions {
	cwd: string;
	shell: false;
	encoding: null;
	maxBuffer: number;
}

export type GitReadCommand = (
	args: readonly string[],
	options: GitReadOptions,
	input?: Uint8Array,
) => Promise<Buffer>;

export interface ChangedPathRecord {
	status: string;
	paths: readonly string[];
}

export interface AffectedChangeMembers {
	path: string;
	selectedMembers: string[];
}

export interface AffectedWorkspaceSelection {
	mode: "affected" | "full";
	changedPaths: string[];
	selectedMembers: string[];
	importEdgeCount: number;
	changeMembers: AffectedChangeMembers[];
	fallbackReason?: string;
}

export interface AffectedWorkspaceInspection extends AffectedWorkspaceSelection {
	selectorId: string;
	baseSha: string;
	headSha: string | null;
	importEdgeCountsByRevision: { base: number; head: number };
}

export interface WorkspaceSourceFile {
	path: string;
	contents: string;
}


function readGit(
	args: readonly string[],
	options: GitReadOptions,
	input?: Uint8Array,
): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	if (input === undefined) {
		nodeChildProcess.execFile(
			"git",
			[...args],
			{
				cwd: options.cwd,
				shell: false,
				encoding: null,
				maxBuffer: options.maxBuffer,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
		return promise;
	}

	const child = nodeChildProcess.spawn("git", [...args], {
		cwd: options.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let settled = false;
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		reject(error);
		child.kill();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		if (settled) return;
		stdoutBytes += chunk.length;
		if (stdoutBytes > options.maxBuffer) {
			fail(new Error(`Git output exceeded ${options.maxBuffer} bytes`));
			return;
		}
		stdoutChunks.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (settled) return;
		stderrBytes += chunk.length;
		if (stderrBytes <= 16_384) stderrChunks.push(chunk);
	});
	child.stdin.once("error", fail);
	child.once("error", fail);
	child.once("close", code => {
		if (settled) return;
		settled = true;
		if (code !== 0) {
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			reject(new Error(stderr || `git ${args.join(" ")} exited with code ${String(code)}`));
			return;
		}
		resolve(Buffer.concat(stdoutChunks, stdoutBytes));
	});
	child.stdin.end(input);
	return promise;
}

function nulDelimitedFields(bytes: Uint8Array): string[] {
	const raw = Buffer.from(bytes);
	if (raw.length === 0) return [];
	if (raw[raw.length - 1] !== 0) {
		throw new Error("Git path output is not NUL-terminated");
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const fields: string[] = [];
	let start = 0;
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] !== 0) continue;
		fields.push(decoder.decode(raw.subarray(start, index)));
		start = index + 1;
	}
	return fields;
}

/** Parse `git diff --name-status -z`, retaining both sides of every rename or copy. */
export function parseGitNameStatus(output: Uint8Array | string): ChangedPathRecord[] {
	const fields = nulDelimitedFields(typeof output === "string" ? Buffer.from(output) : output);
	const records: ChangedPathRecord[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++];
		if (status === undefined || !/^(?:A|C\d*|D|M|R\d*|T|U|X|B)$/.test(status)) {
			throw new Error(`Unsupported Git name-status record: ${status ?? "<missing>"}`);
		}
		const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		const paths = fields.slice(index, index + pathCount);
		if (paths.length !== pathCount || paths.some(file => file.length === 0)) {
			throw new Error(`Incomplete Git name-status record: ${status}`);
		}
		index += pathCount;
		records.push({ status, paths });
	}
	return records;
}

function normalizedGitPath(file: string): string | undefined {
	if (file.length === 0 || file.startsWith("/") || file.includes("\\")) return undefined;
	const normalized = nodePath.posix.normalize(file);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	return normalized;
}

const LOCKFILE_BASENAMES: Record<string, true> = {
	"bun.lock": true,
	"bun.lockb": true,
	"package-lock.json": true,
	"npm-shrinkwrap.json": true,
	"yarn.lock": true,
	"pnpm-lock.yaml": true,
	"Cargo.lock": true,
	"go.sum": true,
};

export type CiContractTestRunner = "bun" | "node" | "python-unittest";

export interface CiContractTestTarget {
	runner: CiContractTestRunner;
	path: string;
}

interface CiContractTestRule {
	matches: (file: string) => boolean;
	targets: (file: string, headTrackedPaths: ReadonlySet<string>) => readonly CiContractTestTarget[];
	requireTrackedTargets?: boolean;
}

const ciContractTargets = (
	runner: CiContractTestRunner,
	paths: readonly string[],
): CiContractTestTarget[] => paths.map(path => ({ runner, path }));

/** Explicit readers for tracked Markdown inputs, excluding paths the real link reader excludes. */
const isTrackedMarkdownReaderInput = (file: string): boolean =>
	/\.md$/i.test(file) &&
	!file.startsWith("docs/handbook/book/") &&
	!file.includes("/vendor/") &&
	!file.includes("node_modules/") &&
	!file.endsWith("CHANGELOG.md") &&
	!file.includes("/discovery/builtin-rules/");

const CI_CONTRACT_TEST_MAP: readonly CiContractTestRule[] = [
	{
		matches: isTrackedMarkdownReaderInput,
		targets: file => {
			const readers = ["scripts/check-doc-links.test.ts", "scripts/check-doc-paths.test.ts"];
			if (file.startsWith("docs/handbook/src/")) {
				readers.push("scripts/a-generated-doc-says-so-on-its-first-line.test.ts");
			}
			if (file === "docs/README.md" || (!file.startsWith("docs/") && !file.startsWith("README."))) {
				readers.push("scripts/first-party-docs-are-indexed.test.ts");
			}
			if (file === "docs/handbook/src/reference/settings.md") {
				readers.push("scripts/settings-doc-coherence.test.ts");
			}
			if (
				file === "docs/handbook/src/reference/providers.md" ||
				file === "docs/handbook/src/reference/environment-complete.md" ||
				file === "packages/ai/README.md"
			) {
				readers.push("scripts/a-documented-provider-default-is-the-descriptor-default.test.ts");
			}
			if (file.startsWith("docs/internal/")) {
				readers.push("scripts/internal-docs-are-tracked.test.ts");
			}
			return ciContractTargets("bun", readers);
		},
		requireTrackedTargets: true,
	},
	{
		matches: file => file === "scripts/ci-test-ts.ts" || file === "scripts/affected-workspace-tests.ts",
		targets: () =>
			ciContractTargets("bun", [
				"scripts/affected-workspace-selection-keeps-safe-coverage.test.ts",
				"scripts/ci-test-concurrency-default.test.ts",
			]),
	},
	{
		matches: file => file === "scripts/workspace-layout.ts",
		targets: () => ciContractTargets("bun", ["scripts/workspace-dependency-graph.test.ts"]),
	},
	{
		matches: file => file === "scripts/gen-root-help-summaries.ts",
		targets: () =>
			ciContractTargets("bun", [
				"packages/coding-agent/test/root-help-summaries-mirror-command-statics.test.ts",
			]),
	},
	{
		matches: file => file.startsWith("scripts/test-sandbox/"),
		targets: () => ciContractTargets("bun", ["scripts/test-sandbox/rung-contract.test.ts"]),
	},
	{
		matches: file => file.startsWith("scripts/") && /\.test\.[cm]?[jt]sx?$/i.test(file),
		// A deleted or renamed-away test has no copy at HEAD, so only a tracked file becomes a target.
		targets: (file, headTrackedPaths) => (headTrackedPaths.has(file) ? ciContractTargets("bun", [file]) : []),
	},
	{
		matches: file => file.startsWith("ci/cloudflare/"),
		targets: file => [
			...ciContractTargets("bun", ["scripts/affected-workspace-selection-keeps-safe-coverage.test.ts"]),
			...ciContractTargets("node", [
				"ci/cloudflare/worker.test.mjs",
				"ci/cloudflare/lane-routing.test.mjs",
				"ci/cloudflare/native-cache.test.mjs",
			]),
			...(["ci/cloudflare/cf_ci.py", "ci/cloudflare/dispatch_nightly.py", "ci/cloudflare/test_cf_ci.py"].includes(file)
				? ciContractTargets("python-unittest", ["ci/cloudflare/test_cf_ci.py"])
				: []),
		],
	},
];

/**
 * Contract targets implied by changed paths. HEAD paths are required because reader targets must
 * exist, and deleted/renamed-away script tests must not be selected.
 */
export function ciContractTestsForPaths(
	paths: readonly string[],
	headTrackedPaths: ReadonlySet<string>,
): CiContractTestTarget[] {
	const targets = new Map<string, CiContractTestTarget>();
	for (const rawPath of paths) {
		const file = normalizedGitPath(rawPath);
		if (!file) continue;
		for (const rule of CI_CONTRACT_TEST_MAP) {
			if (!rule.matches(file)) continue;
			const ruleTargets = rule.targets(file, headTrackedPaths);
			if (rule.requireTrackedTargets) {
				const missing = ruleTargets.find(target => !headTrackedPaths.has(target.path));
				if (missing) throw new Error(`non-code reader target is not tracked at HEAD: ${missing.path}`);
			}
			for (const target of ruleTargets) {
				targets.set(`${target.runner}:${target.path}`, target);
			}
		}
	}
	return [...targets.values()];
}

function isCiContractOwnedPath(file: string): boolean {
	return CI_CONTRACT_TEST_MAP.some(rule => rule.matches(file));
}

/**
 * Return the conservative all-mode reason for a changed path, if one applies.
 *
 * Contract rule: a path owned by `CI_CONTRACT_TEST_MAP` (runner, selector, sandbox, `ci/cloudflare/`
 * and `scripts/` test files) returns no full-mode reason. Its contract tests run instead, so the
 * related selection stays narrow. Only paths with no contract owner reach the branches below, and
 * GitHub workflow files are the one runner-side surface left without a contract rule, so they keep
 * the full-coverage fallback here.
 */
export function fullTriggerReason(file: string): string | undefined {
	const normalized = normalizedGitPath(file);
	if (!normalized) return "changed path is not a safe repository-relative path";
	if (isCiContractOwnedPath(normalized)) return undefined;
	if (normalized === "package.json") return "root package.json can change workspace membership or shared dependencies";
	if (Object.hasOwn(LOCKFILE_BASENAMES, nodePath.posix.basename(normalized))) {
		return "lockfile changes affect dependency resolution across the workspace";
	}
	if (/(^|\/)tsconfig[^/]*\.json$/i.test(normalized)) return "TypeScript configuration changes affect workspace-wide resolution";
	if (normalized === "Cargo.toml" || normalized.endsWith("/Cargo.toml") || normalized.endsWith("/Cargo.lock")) {
		return "Rust manifest changes can affect cross-language consumers";
	}
	if (normalized.startsWith("contracts/")) return "contract changes affect shared boundaries";
	if (normalized.startsWith(".github/workflows/")) {
		return "workflow changes require full coverage";
	}
	if (
		normalized.startsWith("natives/") ||
		normalized.startsWith("crates/") ||
		normalized.startsWith(".cargo/") ||
		/^rust-toolchain(?:\.toml)?$/.test(normalized) ||
		normalized === "rustfmt.toml" ||
		normalized === "clippy.toml"
	) {
		return "native sources or toolchain configuration can affect cross-language consumers";
	}
	if (
		normalized === "bunfig.toml" ||
		normalized === "packages/utils/test/helpers/sandbox-gate.ts" ||
		normalized === "packages/utils/test/helpers/real-data-tripwire.ts" ||
		normalized === "packages/ai/test/helpers/provider-override-tripwire.ts"
	) {
		return "shared test configuration or preload changes affect every bucket";
	}
	if (normalized.startsWith("tests/fixtures/") || normalized.startsWith("tests/fuzz/")) {
		return "shared fixtures or fuzz inputs are outside one workspace member";
	}
	return undefined;
}
export interface WorkspaceImportGraph {
	graph: WorkspaceDependencyGraph;
	importEdgeCount: number;
	fallbackReason?: string;
}

interface ModuleReference {
	specifier: string;
}

interface ModuleScan {
	references: ModuleReference[];
	/** Set when a non-literal loader sits outside the audited list: the graph cannot prove its targets. */
	fallbackReason?: string;
	/** Set when an audited loader makes a non-literal call: its targets may be any workspace member. */
	unboundedLoader: boolean;
}

const SOURCE_MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const builtinModuleNames = new Set(
	nodeModule.builtinModules.flatMap(name => [name, name.startsWith("node:") ? name : `node:${name}`]),
);

function stringLiteralText(expression: ts.Expression | undefined): string | undefined {
	if (expression === undefined) return undefined;
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
	return undefined;
}

function dynamicImportOwner(call: ts.CallExpression, sourceFile: ts.SourceFile): string | undefined {
	let current: ts.Node = call;
	while (current.parent !== undefined) {
		const parent = current.parent;
		if (ts.isFunctionDeclaration(parent) && parent.name !== undefined) {
			return `function:${parent.name.text}`;
		}
		if (ts.isMethodDeclaration(parent)) return `method:${parent.name.getText(sourceFile)}`;
		if (
			(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
			ts.isPropertyAssignment(parent.parent)
		) {
			return `property:${parent.parent.name.getText(sourceFile)}`;
		}
		if (
			(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
			ts.isVariableDeclaration(parent.parent) &&
			ts.isIdentifier(parent.parent.name)
		) {
			return `variable:${parent.parent.name.text}`;
		}
		if (
			(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
			ts.isCallExpression(parent.parent) &&
			ts.isIdentifier(parent.parent.expression) &&
			(parent.parent.expression.text === "it" || parent.parent.expression.text === "test")
		) {
			const title = stringLiteralText(parent.parent.arguments[0]);
			if (title !== undefined) return `test:${title}`;
		}
		current = parent;
	}
	return undefined;
}

function moduleReferences(sourceFile: ts.SourceFile): ModuleScan {
	const references: ModuleReference[] = [];

	let fallbackReason: string | undefined;
	let unboundedLoader = false;
	const dynamicSiteCalls = new Map<string, number>();
	const unresolvedLoader = (call: ts.CallExpression, kind: string): void => {
		const owner = dynamicImportOwner(call, sourceFile);
		const site = AFFECTED_DYNAMIC_IMPORT_SITES.find(
			candidate => candidate.file === sourceFile.fileName && candidate.owner === owner,
		);
		if (kind === "dynamic import" && site !== undefined) {
			const key = `${site.file}\0${site.owner}`;
			const callCount = (dynamicSiteCalls.get(key) ?? 0) + 1;
			dynamicSiteCalls.set(key, callCount);
			if (callCount <= site.maxCalls) unboundedLoader = true;
			else fallbackReason ??= `non-literal dynamic import exceeded audited call bound in ${sourceFile.fileName}: ${owner}`;
			return;
		}
		fallbackReason ??= `non-literal ${kind} in ${sourceFile.fileName}: ${owner ?? "unknown owner"}`;
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			references.push({ specifier: node.moduleSpecifier.text });
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			references.push({ specifier: node.moduleSpecifier.text });
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			references.push({ specifier: node.argument.literal.text });
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const literal = stringLiteralText(node.moduleReference.expression);
			if (literal !== undefined) references.push({ specifier: literal });
			else fallbackReason ??= `non-literal import-equals require in ${sourceFile.fileName}`;
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const literal = stringLiteralText(node.arguments[0]);
			if (literal !== undefined) references.push({ specifier: literal });
			else unresolvedLoader(node, "dynamic import");
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
			const literal = stringLiteralText(node.arguments[0]);
			if (literal !== undefined) references.push({ specifier: literal });
			else unresolvedLoader(node, "require");
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { references, fallbackReason, unboundedLoader };
}

function workspacePackageName(specifier: string, packageNames: readonly string[]): string | undefined {
	return packageNames.find(name => specifier === name || specifier.startsWith(`${name}/`));
}

function packageNameFromSpecifier(specifier: string): string {
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
	const names = new Set<string>();
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const value = manifest[field];
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		for (const name of Object.keys(value)) names.add(name);
	}
	return names;
}

function absoluteWorkspacePath(repoRoot: string, fileName: string): string | undefined {
	const relative = nodePath.relative(repoRoot, nodePath.resolve(repoRoot, fileName)).replaceAll("\\", "/");
	return normalizedGitPath(relative);
}

function resolveWorkspaceModule(
	specifier: string,
	sourcePath: string,
	repoRoot: string,
	trackedPaths: ReadonlySet<string>,
	directories: ReadonlySet<string>,
	contents: ReadonlyMap<string, string>,
): string | undefined {
	if (specifier.startsWith(".")) {
		const directPath = normalizedGitPath(nodePath.posix.join(nodePath.posix.dirname(sourcePath), specifier));
		if (directPath !== undefined && trackedPaths.has(directPath)) return directPath;
	}
	const resolutionHost: ts.ModuleResolutionHost = {
		fileExists(fileName) {
			const relative = absoluteWorkspacePath(repoRoot, fileName);
			return relative !== undefined && trackedPaths.has(relative);
		},
		readFile(fileName) {
			const relative = absoluteWorkspacePath(repoRoot, fileName);
			return relative === undefined ? undefined : contents.get(relative);
		},
		directoryExists(directoryName) {
			const relative = absoluteWorkspacePath(repoRoot, directoryName);
			return relative !== undefined && directories.has(relative);
		},
		getDirectories(directoryName) {
			const relative = absoluteWorkspacePath(repoRoot, directoryName);
			if (relative === undefined) return [];
			const prefix = relative === "." ? "" : `${relative}/`;
			return [...directories]
				.filter(directory => directory !== relative && directory.startsWith(prefix))
				.map(directory => directory.slice(prefix.length).split("/")[0] ?? "")
				.filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);
		},
		getCurrentDirectory: () => repoRoot,
		useCaseSensitiveFileNames: true,
		realpath: fileName => fileName,
	};
	const resolution = ts.resolveModuleName(
		specifier,
		nodePath.resolve(repoRoot, sourcePath),
		{
			allowJs: true,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			resolveJsonModule: true,
		},
		resolutionHost,
	).resolvedModule;
	return resolution === undefined ? undefined : absoluteWorkspacePath(repoRoot, resolution.resolvedFileName);
}

function workspacePackageExportTargets(exportsValue: unknown, subpath: string): string[] {
	const resolveValue = (value: unknown, wildcard?: string): string[] => {
		if (typeof value === "string") {
			return wildcard === undefined ? [value] : [value.replaceAll("*", wildcard)];
		}
		if (Array.isArray(value)) return value.flatMap(item => resolveValue(item, wildcard));
		if (typeof value !== "object" || value === null) return [];
		const record = value as Record<string, unknown>;
		const subpathKeys = Object.keys(record).filter(key => key.startsWith("."));
		if (subpathKeys.length > 0) {
			if (Object.hasOwn(record, subpath)) return resolveValue(record[subpath], wildcard);
			for (const pattern of subpathKeys.filter(key => key.includes("*")).sort((left, right) => right.length - left.length)) {
				const star = pattern.indexOf("*");
				if (star !== pattern.lastIndexOf("*")) continue;
				const prefix = pattern.slice(0, star);
				const suffix = pattern.slice(star + 1);
				if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
				const end = subpath.length - suffix.length;
				if (end < prefix.length) continue;
				return resolveValue(record[pattern], subpath.slice(prefix.length, end));
			}
			return [];
		}
		const targets: string[] = [];
		for (const condition of ["types", "import", "node", "bun", "browser", "default", "require"]) {
			if (Object.hasOwn(record, condition)) targets.push(...resolveValue(record[condition], wildcard));
		}
		return targets;
	};

	return resolveValue(exportsValue);
}

function resolveWorkspacePackageSpecifier(
	specifier: string,
	packageName: string,
	directory: string,
	manifest: Record<string, unknown>,
	repoRoot: string,
	trackedPaths: ReadonlySet<string>,
	directories: ReadonlySet<string>,
	contents: ReadonlyMap<string, string>,
): string | undefined {
	const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
	const exportsValue = manifest.exports;
	let targets: string[];
	if (exportsValue !== undefined) {
		targets = workspacePackageExportTargets(exportsValue, subpath);
	} else if (subpath === ".") {
		const main = [manifest.types, manifest.typings, manifest.module, manifest.main].find(
			value => typeof value === "string",
		);
		targets = [typeof main === "string" ? main : "./src/index.ts"];
	} else {
		targets = [`./src/${subpath.slice(2)}`];
	}

	for (const target of targets) {
		if (!target.startsWith("./") || target.includes("*")) continue;
		const resolved = resolveWorkspaceModule(
			target,
			`${directory}/__affected_selector__.ts`,
			repoRoot,
			trackedPaths,
			directories,
			contents,
		);
		if (resolved !== undefined) return resolved;
	}
	return undefined;
}

function graphWithImportEdges(
	graph: WorkspaceDependencyGraph,
	addedDependencies: ReadonlyMap<string, ReadonlySet<string>>,
): WorkspaceDependencyGraph {
	const nodes = new Map<string, WorkspaceGraphNode>();
	const reverseDependencies = new Map<string, Set<string>>(
		[...graph.nodes.keys()].map(directory => [directory, new Set<string>()]),
	);
	for (const [directory, node] of graph.nodes) {
		const dependencies = new Set([...node.dependencies, ...(addedDependencies.get(directory) ?? [])]);
		for (const dependency of dependencies) {
			const dependents = reverseDependencies.get(dependency);
			if (dependents === undefined) {
				throw new Error(`Workspace import edge points to an unknown member: ${dependency}`);
			}
			dependents.add(directory);
		}
		nodes.set(directory, { ...node, dependencies });
	}
	return { nodes, names: new Map(graph.names), reverseDependencies };
}

/** Adds parsed import edges to manifest dependencies and reports paths the graph cannot prove. */
export function buildWorkspaceGraphWithImports(
	entries: readonly WorkspaceGraphEntry[],
	sources: readonly WorkspaceSourceFile[],
	availablePaths: readonly string[],
	repoRoot: string = nodePath.resolve(import.meta.dirname, ".."),
): WorkspaceImportGraph {
	const graph = buildWorkspaceDependencyGraph(entries);
	const trackedPaths = new Set(availablePaths);
	const directories = new Set<string>(["."]);
	const contents = new Map<string, string>();
	for (const file of trackedPaths) {
		let parent = nodePath.posix.dirname(file);
		while (parent !== "." && !directories.has(parent)) {
			directories.add(parent);
			parent = nodePath.posix.dirname(parent);
		}
	}
	for (const entry of entries) contents.set(`${entry.directory}/package.json`, JSON.stringify(entry.manifest));
	const packageNames = [...graph.names.keys()].sort((left, right) => right.length - left.length);
	const externalDependencies = new Map(
		entries.map(entry => [
			entry.directory,
			new Set([...dependencyNames(entry.manifest)].filter(name => !graph.names.has(name))),
		]),
	);
	const addedDependencies = new Map<string, Set<string>>();
	let fallbackReason: string | undefined;
	for (const source of [...sources].sort((left, right) => left.path.localeCompare(right.path))) {
		const sourcePath = normalizedGitPath(source.path);
		if (sourcePath === undefined || !trackedPaths.has(sourcePath)) {
			fallbackReason ??= `source inventory contains an invalid or untracked path: ${source.path}`;
			continue;
		}
		const sourceOwner = longestOwner(graph, sourcePath);
		if (sourceOwner === undefined) {
			fallbackReason ??= `source inventory has no workspace owner: ${sourcePath}`;
			continue;
		}
		contents.set(sourcePath, source.contents);
		const scriptKind = /\.tsx$/i.test(sourcePath)
			? (ts.ScriptKind?.TSX ?? 4)
			: /\.jsx$/i.test(sourcePath)
				? (ts.ScriptKind?.JSX ?? 2)
				: /\.(?:[cm]?js)$/i.test(sourcePath)
					? (ts.ScriptKind?.JS ?? 1)
					: (ts.ScriptKind?.TS ?? 3);
		const parsedSource = ts.createSourceFile(
			sourcePath,
			source.contents,
			ts.ScriptTarget?.Latest ?? 99,
			true,
			scriptKind,
		);
		if (parsedSource.parseDiagnostics.length > 0) {
			fallbackReason ??= `could not parse import syntax in ${sourcePath}`;
			continue;
		}
		const scanned = moduleReferences(parsedSource);
		if (scanned.fallbackReason !== undefined) fallbackReason ??= scanned.fallbackReason;
		const dependencies = addedDependencies.get(sourceOwner) ?? new Set<string>();
		addedDependencies.set(sourceOwner, dependencies);
		// An audited loader's target is not derivable, so every other member is a potential target.
		if (scanned.unboundedLoader) {
			for (const member of graph.nodes.keys()) {
				if (member !== sourceOwner) dependencies.add(member);
			}
		}
		for (const reference of scanned.references) {
			const specifier = reference.specifier;
			if (specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier.startsWith("data:")) {
				continue;
			}
			const packageName = workspacePackageName(specifier, packageNames);
			let targetMember: string | undefined;
			if (packageName !== undefined) {
				const directory = graph.names.get(packageName);
				const entry = entries.find(candidate => candidate.directory === directory);
				const resolved = entry === undefined || directory === undefined
					? undefined
					: resolveWorkspacePackageSpecifier(
						specifier,
						packageName,
						directory,
						entry.manifest,
						repoRoot,
						trackedPaths,
						directories,
						contents,
					);
				if (resolved === undefined) {
					fallbackReason ??= `workspace package import target does not resolve in ${sourcePath}: ${specifier}`;
					continue;
				}
				targetMember = longestOwner(graph, resolved);
				if (targetMember === undefined) {
					fallbackReason ??= `workspace package import from ${sourcePath} resolves outside workspace members: ${resolved}`;
					continue;
				}
			}
			if (targetMember === undefined && (specifier.startsWith(".") || specifier.startsWith("/"))) {
				const localSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
				const resolved = resolveWorkspaceModule(
					localSpecifier,
					sourcePath,
					repoRoot,
					trackedPaths,
					directories,
					contents,
				);
				if (resolved === undefined) {
					fallbackReason ??= `relative import target does not resolve in the ${sourcePath}: ${specifier}`;
					continue;
				}
				targetMember = longestOwner(graph, resolved);
				if (targetMember === undefined) {
					fallbackReason ??= `relative import from ${sourcePath} resolves outside workspace members: ${resolved}`;
					continue;
				}
			} else if (targetMember === undefined) {
				const packageRoot = packageNameFromSpecifier(specifier);
				if (builtinModuleNames.has(specifier) || builtinModuleNames.has(packageRoot)) continue;
				if (externalDependencies.get(sourceOwner)?.has(packageRoot)) continue;
				if (specifier.startsWith("@veyyon/") || specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) {
					const resolved = resolveWorkspaceModule(
						specifier,
						sourcePath,
						repoRoot,
						trackedPaths,
						directories,
						contents,
					);
					targetMember = resolved === undefined ? undefined : longestOwner(graph, resolved);
					if (targetMember === undefined) {
						fallbackReason ??= `internal import does not resolve to a workspace member in ${sourcePath}: ${specifier}`;
						continue;
					}
				} else {
					// Not a builtin, not declared by the owner, not a workspace package: it could be a
					// baseUrl-style or hoisted internal path, so the graph cannot prove the edge is external.
					fallbackReason ??= `undeclared bare import is not proven external in ${sourcePath}: ${specifier}`;
					continue;
				}
			}
			if (targetMember === sourceOwner) continue;
			dependencies.add(targetMember);
		}
	}
	const importEdgeCount = [...addedDependencies.values()].reduce((count, dependencies) => count + dependencies.size, 0);
	return {
		graph: graphWithImportEdges(graph, addedDependencies),
		importEdgeCount,
		fallbackReason,
	};
}

function graphMemberDirectories(graph: WorkspaceDependencyGraph): string[] {
	return [...graph.nodes.keys()].sort();
}

function allGraphMembers(baseGraph: WorkspaceDependencyGraph, headGraph: WorkspaceDependencyGraph): string[] {
	return [...new Set([...graphMemberDirectories(baseGraph), ...graphMemberDirectories(headGraph)])].sort();
}

function longestOwner(graph: WorkspaceDependencyGraph, file: string): string | undefined {
	let owner: string | undefined;
	for (const directory of graph.nodes.keys()) {
		if (file !== directory && !file.startsWith(`${directory}/`)) continue;
		if (owner === undefined || directory.length > owner.length) owner = directory;
	}
	return owner;
}

function isAlwaysCoveredPath(file: string): boolean {
	return isCiContractOwnedPath(file);
}

/** Select changed owners and both revisions' transitive reverse dependency closures. */
export function selectAffectedWorkspaceMembers(
	changes: readonly ChangedPathRecord[],
	baseGraph: WorkspaceDependencyGraph,
	headGraph: WorkspaceDependencyGraph,
	importEdgeCount = 0,
): AffectedWorkspaceSelection {
	const changedPaths = [...new Set(changes.flatMap(change => change.paths))].sort();
	const full = (fallbackReason: string): AffectedWorkspaceSelection => {
		const selectedMembers = allGraphMembers(baseGraph, headGraph);
		return {
			mode: "full",
			changedPaths,
			selectedMembers,
			importEdgeCount,
			changeMembers: changedPaths.map(file => ({ path: file, selectedMembers })),
			fallbackReason,
		};
	};
	const selected = new Set<string>();
	const changeMembers: AffectedChangeMembers[] = [];
	for (const rawPath of changedPaths) {
		const file = normalizedGitPath(rawPath);
		if (!file) return full("changed path is not a safe repository-relative path");
		const trigger = fullTriggerReason(file);
		if (trigger) return full(`${trigger}: ${file}`);
		const baseOwner = longestOwner(baseGraph, file);
		const headOwner = longestOwner(headGraph, file);
		if (baseOwner === undefined && headOwner === undefined && !isAlwaysCoveredPath(file)) {
			return full(`changed path has no unambiguous workspace owner: ${file}`);
		}
		try {
			const affectedByPath = new Set<string>();
			if (baseOwner !== undefined) {
				for (const member of reverseDependencyClosure(baseGraph, [baseOwner])) affectedByPath.add(member);
			}
			if (headOwner !== undefined) {
				for (const member of reverseDependencyClosure(headGraph, [headOwner])) affectedByPath.add(member);
			}
			for (const member of affectedByPath) selected.add(member);
			changeMembers.push({ path: file, selectedMembers: [...affectedByPath].sort() });
		} catch {
			return full("workspace dependency graph traversal failed");
		}
	}
	return {
		mode: "affected",
		changedPaths,
		selectedMembers: [...selected].sort(),
		importEdgeCount,
		changeMembers,
	};
}

function parseManifest(contents: Buffer, revision: string, file: string): Record<string, unknown> {
	const value: unknown = JSON.parse(contents.toString("utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${revision}:${file} is not a JSON object`);
	}
	return value as Record<string, unknown>;
}

interface WorkspaceSnapshot {
	graph: WorkspaceDependencyGraph;
	importEdgeCount: number;
	fallbackReason?: string;
}

async function readGitBlobBatch(
	revision: string,
	filePaths: readonly string[],
	options: GitReadOptions,
	git: GitReadCommand,
): Promise<Map<string, Buffer>> {
	if (filePaths.length === 0) return new Map();
	if (filePaths.some(file => file.includes("\n") || file.includes("\r"))) {
		throw new Error("source path cannot be represented in a Git batch request");
	}
	const input = Buffer.from(filePaths.map(file => `${revision}:${file}\n`).join(""));
	const output = await git(["cat-file", "--batch"], options, input);
	const blobs = new Map<string, Buffer>();
	let offset = 0;
	for (const file of filePaths) {
		const headerEnd = output.indexOf(10, offset);
		if (headerEnd < 0) throw new Error(`missing Git blob header for ${revision}:${file}`);
		const [objectId, type, sizeText] = output.toString("ascii", offset, headerEnd).split(" ");
		const size = Number(sizeText);
		if (!objectId || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
			throw new Error(`invalid Git blob header for ${revision}:${file}`);
		}
		const contentStart = headerEnd + 1;
		const contentEnd = contentStart + size;
		if (contentEnd >= output.length || output[contentEnd] !== 10) {
			throw new Error(`truncated Git blob body for ${revision}:${file}`);
		}
		blobs.set(file, output.subarray(contentStart, contentEnd));
		offset = contentEnd + 1;
	}
	if (offset !== output.length) throw new Error(`unexpected trailing output from Git blob batch at ${revision}`);
	return blobs;
}

async function readWorkspaceSnapshot(
	revision: string,
	cwd: string,
	git: GitReadCommand,
): Promise<WorkspaceSnapshot> {
	const options: GitReadOptions = { cwd, shell: false, encoding: null, maxBuffer: MAX_GIT_OUTPUT_BYTES };
	const tree = await git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", revision], options);
	const trackedPaths = nulDelimitedFields(tree);
	const rootManifestBuffer = await git(["show", `${revision}:package.json`], options);
	const rootManifest = parseManifest(rootManifestBuffer, revision, "package.json");
	const manifestPaths = trackedPaths.filter(file => file.endsWith("/package.json"));
	const directories = resolveWorkspaceMemberDirectories(rootManifest, manifestPaths);
	const entries: WorkspaceGraphEntry[] = await Promise.all(
		directories.map(async directory => ({
			directory,
			manifest: parseManifest(
				await git(["show", `${revision}:${directory}/package.json`], options),
				revision,
				`${directory}/package.json`,
			),
		})),
	);
	const manifestGraph = buildWorkspaceDependencyGraph(entries);
	const sourcePaths = trackedPaths
		.filter(file => SOURCE_MODULE_EXTENSION.test(file) && longestOwner(manifestGraph, file) !== undefined)
		.sort();
	const sourceBlobs = await readGitBlobBatch(revision, sourcePaths, options, git);
	const sources = sourcePaths.map(file => {
		const contents = sourceBlobs.get(file);
		if (contents === undefined) throw new Error(`missing Git source blob for ${revision}:${file}`);
		return { path: file, contents: contents.toString("utf8") };
	});
	const imports = buildWorkspaceGraphWithImports(entries, sources, trackedPaths, cwd);
	return {
		graph: imports.graph,
		importEdgeCount: imports.importEdgeCount,
		fallbackReason: imports.fallbackReason,
	};
}

function outputText(bytes: Buffer): string {
	return bytes.toString("utf8").trim();
}

function isCommitSha(value: string): boolean {
	return FULL_COMMIT_SHA.test(value);
}

/**
 * Paths under the given directories that the working tree differs from HEAD on: tracked files
 * changed since HEAD, and untracked test files. Ignored build output and untracked non-test
 * files are not reported, so installs and build artifacts do not block a run.
 */
export async function workingTreeDrift(
	directories: readonly string[],
	isTestFile: (file: string) => boolean,
	options: { repoRoot?: string; gitRead?: GitReadCommand } = {},
): Promise<string[]> {
	const repoRoot = options.repoRoot ?? nodePath.resolve(import.meta.dirname, "..");
	const git = options.gitRead ?? readGit;
	const commandOptions: GitReadOptions = { cwd: repoRoot, shell: false, encoding: null, maxBuffer: MAX_GIT_OUTPUT_BYTES };
	const tracked = nulDelimitedFields(
		await git(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--", ...directories], commandOptions),
	);
	const untracked = nulDelimitedFields(
		await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...directories], commandOptions),
	);
	return [...new Set([...tracked, ...untracked.filter(isTestFile)])].sort();
}

/**
 * Paths tracked at HEAD under the given directories. A changed path is a contract target only when
 * this set holds it, because a deleted or renamed-away file has no copy at HEAD to run.
 */
export async function headTrackedFiles(
	directories: readonly string[],
	options: { repoRoot?: string; gitRead?: GitReadCommand } = {},
): Promise<Set<string>> {
	const repoRoot = options.repoRoot ?? nodePath.resolve(import.meta.dirname, "..");
	const git = options.gitRead ?? readGit;
	const tracked = await git(["ls-tree", "-r", "-z", "--name-only", "HEAD", ...directories], {
		cwd: repoRoot,
		shell: false,
		encoding: null,
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
	return new Set(nulDelimitedFields(tracked));
}

/**
 * Read immutable base/head snapshots through read-only Git commands. Any failure in
 * history, manifests, member resolution or graph construction returns full mode.
 */
export async function inspectAffectedWorkspaceSelection(
	baseSha: string,
	options: { repoRoot?: string; gitRead?: GitReadCommand } = {},
): Promise<AffectedWorkspaceInspection> {
	const repoRoot = options.repoRoot ?? nodePath.resolve(import.meta.dirname, "..");
	const git = options.gitRead ?? readGit;
	const baseRef = baseSha.toLowerCase();
	let headSha: string | null = null;
	const fallback = (reason: string): AffectedWorkspaceInspection => ({
		selectorId: AFFECTED_SELECTOR_ID,
		baseSha,
		headSha,
		mode: "full",
		changedPaths: [],
		selectedMembers: [],
		importEdgeCount: 0,
		changeMembers: [],
		fallbackReason: reason,
		importEdgeCountsByRevision: { base: 0, head: 0 },
	});
	if (!isCommitSha(baseSha)) return fallback("comparison base must be a full 40- or 64-character commit SHA");

	let stage = "repository history";
	try {
		const commandOptions: GitReadOptions = {
			cwd: repoRoot,
			shell: false,
			encoding: null,
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
		};
		headSha = outputText(await git(["rev-parse", "--verify", "HEAD^{commit}"], commandOptions)).toLowerCase();
		if (!isCommitSha(headSha)) {
			headSha = null;
			return fallback("HEAD is not available as a full commit SHA");
		}
		const [shallowOutput, baseOutput] = await Promise.all([
			git(["rev-parse", "--is-shallow-repository"], commandOptions),
			git(["rev-parse", "--verify", `${baseRef}^{commit}`], commandOptions),
		]);
		const resolvedBaseSha = outputText(baseOutput).toLowerCase();
		if (resolvedBaseSha !== baseRef) return fallback("comparison base does not resolve to the requested commit SHA");
		if (outputText(shallowOutput) === "true") return fallback("repository history is shallow or incomplete");

		stage = "comparison history";
		await git(["merge-base", "--is-ancestor", resolvedBaseSha, headSha], commandOptions);

		stage = "base and head workspace snapshots";
		const baseSnapshot = await readWorkspaceSnapshot(resolvedBaseSha, repoRoot, git);
		const headSnapshot = await readWorkspaceSnapshot(headSha, repoRoot, git);

		stage = "NUL-delimited changed-path diff";
		const diff = await git(
			[
				"diff",
				"--name-status",
				"-z",
				"--find-renames",
				"--no-ext-diff",
				"--no-textconv",
				resolvedBaseSha,
				headSha,
				"--",
			],
			commandOptions,
		);
		const changes = parseGitNameStatus(diff);
		const importEdgeCount = baseSnapshot.importEdgeCount + headSnapshot.importEdgeCount;
		const importFallback = baseSnapshot.fallbackReason
			? `base ${baseSnapshot.fallbackReason}`
			: headSnapshot.fallbackReason
				? `head ${headSnapshot.fallbackReason}`
				: undefined;
		const selection =
			importFallback === undefined
				? selectAffectedWorkspaceMembers(changes, baseSnapshot.graph, headSnapshot.graph, importEdgeCount)
				: {
						mode: "full" as const,
						changedPaths: [...new Set(changes.flatMap(change => change.paths))].sort(),
						selectedMembers: allGraphMembers(baseSnapshot.graph, headSnapshot.graph),
						importEdgeCount,
						changeMembers: [...new Set(changes.flatMap(change => change.paths))]
							.sort()
							.map(file => ({
								path: file,
								selectedMembers: allGraphMembers(baseSnapshot.graph, headSnapshot.graph),
							})),
						fallbackReason: importFallback,
					};
		return {
			...selection,
			selectorId: AFFECTED_SELECTOR_ID,
			baseSha: resolvedBaseSha,
			headSha,
			importEdgeCountsByRevision: {
				base: baseSnapshot.importEdgeCount,
				head: headSnapshot.importEdgeCount,
			},
		};
	} catch {
		return fallback(`could not read ${stage}; using full mode`);
	}
}
