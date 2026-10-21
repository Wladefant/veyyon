import { describe, expect, it } from "bun:test";
import {
	AFFECTED_DYNAMIC_IMPORT_LOADER_FILES,
	AFFECTED_SELECTOR_ID,
	type AffectedWorkspaceInspection,
	type AffectedWorkspaceSelection,
	buildWorkspaceGraphWithImports,
	ciContractTestsForPaths,
	fullTriggerReason,
	type GitReadCommand,
	headTrackedFiles,
	inspectAffectedWorkspaceSelection,
	parseGitNameStatus,
	selectAffectedWorkspaceMembers,
	type WorkspaceSourceFile,
} from "./affected-workspace-tests";
import {
	composeRelatedSelection,
	explicitTestCommands,
	NODE_TEST_PREFIX,
	type NodeTestTotals,
	parseNodeTapSummary,
	parseRunnerArguments,
	recordNodeRun,
	type TestCommand,
} from "./ci-test-ts";
import {
	buildWorkspaceDependencyGraph,
	reverseDependencyClosure,
	type WorkspaceDependencyGraph,
	type WorkspaceGraphEntry,
	workspaceDependencyGraph,
} from "./workspace-layout";

function graph(entries: readonly WorkspaceGraphEntry[]): WorkspaceDependencyGraph {
	return buildWorkspaceDependencyGraph(entries);
}

function member(directory: string, name: string, dependencies: Record<string, string> = {}): WorkspaceGraphEntry {
	return {
		directory,
		manifest: { name, ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}) },
	};
}

function basicGraph(): WorkspaceDependencyGraph {
	return graph([
		member("packages/shared", "@test/shared"),
		member("packages/shared/nested", "@test/nested"),
		member("packages/app", "@test/app", { "@test/nested": "workspace:*" }),
	]);
}

function manifest(name: string, dependencies: Record<string, string> = {}): string {
	return JSON.stringify({ name, ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}) });
}

function inspectionFor(selection: AffectedWorkspaceSelection): AffectedWorkspaceInspection {
	return {
		...selection,
		selectorId: AFFECTED_SELECTOR_ID,
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		importEdgeCountsByRevision: { base: 0, head: 0 },
	};
}

function ownedCommand(cwd: string): TestCommand {
	return { label: `workspace ${cwd}`, cwd, command: ["bun", "test", cwd] };
}

describe("affected workspace selection preserves complete safe coverage", () => {
	it("parses rename records with both paths and retains deletions", () => {
		expect(
			parseGitNameStatus(
				"R100\0packages/old/src/api.ts\0packages/new/src/api.ts\0D\0packages/gone/src/index.ts\0",
			),
		).toEqual([
			{ status: "R100", paths: ["packages/old/src/api.ts", "packages/new/src/api.ts"] },
			{ status: "D", paths: ["packages/gone/src/index.ts"] },
		]);
	});

	it("unions reverse closures from both revisions and maps the longest nested owner", () => {
		const base = basicGraph();
		const head = graph([
			member("packages/shared", "@test/shared"),
			member("packages/shared/nested", "@test/nested"),
			member("packages/app", "@test/app"),
		]);
		const selection = selectAffectedWorkspaceMembers(
			[{ status: "R100", paths: ["packages/shared/nested/src/old.ts", "packages/shared/nested/src/new.ts"] }],
			base,
			head,
		);

		expect(selection.mode).toBe("affected");
		expect(selection.selectedMembers).toEqual(["packages/app", "packages/shared/nested"]);
		expect(selection.selectedMembers).not.toContain("packages/shared");
	});

	it("adds import, export, require, and literal dynamic-import edges to member closure", () => {
		const types = member("packages/types", "@test/types");
		const exported = member("packages/exported", "@test/exported");
		const required = member("packages/required", "@test/required");
		const dynamic = member("packages/dynamic", "@test/dynamic");
		const app = member("packages/app", "@test/app");
		const sourcePath = "packages/app/src/index.ts";
		const sources: WorkspaceSourceFile[] = [
			{
				path: sourcePath,
				contents: [
					'import type { Shared } from "@test/types/types";',
					'export { Shared as RelativeShared } from "../../exported/src/types";',
					'const fromRequire = require("@test/required");',
					'const fromDynamic = import("@test/dynamic/subpath");',
				].join("\n"),
			},
		];
		const result = buildWorkspaceGraphWithImports(
			[types, exported, required, dynamic, app],
			sources,
			[
				"packages/app/package.json",
				"packages/app/src/index.ts",
				"packages/dynamic/package.json",
				"packages/dynamic/src/subpath.ts",
				"packages/exported/package.json",
				"packages/exported/src/types.ts",
				"packages/required/package.json",
				"packages/required/src/index.ts",
				"packages/types/package.json",
				"packages/types/src/types.ts",
			],
		);

		expect(result.fallbackReason).toBeUndefined();
		expect(result.importEdgeCount).toBe(4);
		expect(result.graph.reverseDependencies.get("packages/types")).toEqual(new Set(["packages/app"]));
		expect(selectAffectedWorkspaceMembers(
			[{ status: "M", paths: ["packages/types/src/types.ts"] }],
			result.graph,
			result.graph,
			result.importEdgeCount,
		)).toMatchObject({
			mode: "affected",
			selectedMembers: ["packages/app", "packages/types"],
			changeMembers: [{
				path: "packages/types/src/types.ts",
				selectedMembers: ["packages/app", "packages/types"],
			}],
		});
	});

	it("forces full selection for unresolved cross-member imports and unlisted non-literal dynamic imports", () => {
		const app = member("packages/app", "@test/app");
		const shared = member("packages/shared", "@test/shared");
		const paths = ["packages/app/package.json", "packages/app/src/load.ts", "packages/shared/package.json"];
		const unresolved = buildWorkspaceGraphWithImports(
			[app, shared],
			[{ path: "packages/app/src/load.ts", contents: 'import "../../shared/src/missing";' }],
			paths,
		);
		const unresolvedPackage = buildWorkspaceGraphWithImports(
			[app, shared],
			[{ path: "packages/app/src/load.ts", contents: 'import "@test/shared/missing";' }],
			paths,
		);
		const dynamic = buildWorkspaceGraphWithImports(
			[app],
			[{
				path: "packages/app/src/load.ts",
				contents: "export const load = (target: string) => import(target);",
			}],
			paths,
		);

		expect(unresolved.fallbackReason).toContain("packages/app/src/load.ts");
		expect(unresolvedPackage.fallbackReason).toContain("packages/app/src/load.ts");
		expect(dynamic.fallbackReason).toContain("packages/app/src/load.ts");
		expect(dynamic.fallbackReason).toContain("non-literal dynamic import");
	});

	it("falls back for a loader identifier shadowed by a function parameter", () => {
		const result = buildWorkspaceGraphWithImports(
			[member("packages/app", "@test/app"), member("packages/shared", "@test/shared")],
			[{
				path: "packages/app/src/load.ts",
				contents: [
					'const target = "@test/shared";',
					"export const load = (target: string) => import(target);",
				].join("\n"),
			}],
			["packages/app/package.json", "packages/app/src/load.ts", "packages/shared/package.json"],
		);

		expect(result.fallbackReason).toContain("non-literal dynamic import");
	});

	it("gives an audited non-literal loader an edge to every other member, not a silent exemption", () => {
		const loaderPath = "packages/coding-agent/src/eval/js/shared/runtime.ts";
		expect(AFFECTED_DYNAMIC_IMPORT_LOADER_FILES).toContain(loaderPath);
		const codingAgent = member("packages/coding-agent", "@test/coding-agent");
		const other = member("packages/other", "@test/other");
		const result = buildWorkspaceGraphWithImports(
			[codingAgent, other],
			[{ path: loaderPath, contents: "export const load = (target: string) => import(target);" }],
			["packages/coding-agent/package.json", loaderPath, "packages/other/package.json"],
		);

		expect(result.fallbackReason).toBeUndefined();
		expect(result.graph.reverseDependencies.get("packages/other")).toEqual(new Set(["packages/coding-agent"]));
	});

	it("forces full selection for a non-literal loader outside the audited list, even with one member", () => {
		const result = buildWorkspaceGraphWithImports(
			[member("packages/app", "@test/app")],
			[{ path: "packages/app/src/load.ts", contents: "export const load = (t: string) => import(t);" }],
			["packages/app/package.json", "packages/app/src/load.ts"],
		);

		expect(result.fallbackReason).toContain("non-literal dynamic import");
	});

	it("resolves a tracked relative text asset and an import-equals require as graph edges", () => {
		const shared = member("packages/shared", "@test/shared");
		const app = member("packages/app", "@test/app");
		const result = buildWorkspaceGraphWithImports(
			[shared, app],
			[{
				path: "packages/app/src/index.ts",
				contents: [
					'import notes from "./notes.md" with { type: "text" };',
					'import types = require("../../shared/src/types");',
				].join("\n"),
			}],
			[
				"packages/app/package.json",
				"packages/app/src/index.ts",
				"packages/app/src/notes.md",
				"packages/shared/package.json",
				"packages/shared/src/types.ts",
			],
		);

		expect(result.fallbackReason).toBeUndefined();
		expect(result.graph.reverseDependencies.get("packages/shared")).toEqual(new Set(["packages/app"]));
	});

	it("keeps renamed and deleted owners plus dependents whose edge was removed at head", async () => {
		const baseSha = "a".repeat(40);
		const headSha = "b".repeat(40);
		const rootManifest = JSON.stringify({ workspaces: { packages: ["packages/*"] } });
		const baseManifests: Record<string, string> = {
			"packages/old/package.json": manifest("@test/old"),
			"packages/old-consumer/package.json": manifest("@test/old-consumer", { "@test/old": "workspace:*" }),
			"packages/gone/package.json": manifest("@test/gone"),
			"packages/gone-consumer/package.json": manifest("@test/gone-consumer", { "@test/gone": "workspace:*" }),
		};
		const headManifests: Record<string, string> = {
			"packages/new/package.json": manifest("@test/new"),
			"packages/new-consumer/package.json": manifest("@test/new-consumer", { "@test/new": "workspace:*" }),
			"packages/gone-consumer/package.json": manifest("@test/gone-consumer"),
		};
		const calls: { args: readonly string[]; options: { shell: false; cwd: string } }[] = [];
		const gitRead: GitReadCommand = async (args, options) => {
			calls.push({ args, options });
			const command = args[0];
			if (command === "rev-parse") {
				if (args[1] === "--is-shallow-repository") return Buffer.from("false\n");
				if (args[2] === "HEAD^{commit}") return Buffer.from(`${headSha}\n`);
				if (args[2] === `${baseSha}^{commit}`) return Buffer.from(`${baseSha}\n`);
			}
			if (command === "merge-base") return Buffer.alloc(0);
			if (command === "ls-tree") {
				const revision = args.at(-1);
				const paths = revision === baseSha ? Object.keys(baseManifests) : Object.keys(headManifests);
				return Buffer.from(["package.json", ...paths].join("\0") + "\0");
			}
			if (command === "show") {
				const [revision, file] = (args[1] ?? "").split(":");
				if (file === "package.json") return Buffer.from(rootManifest);
				const contents = revision === baseSha ? baseManifests[file ?? ""] : headManifests[file ?? ""];
				if (contents !== undefined) return Buffer.from(contents);
			}
			if (command === "diff") {
				return Buffer.from(
					"R100\0packages/old/src/api.ts\0packages/new/src/api.ts\0D\0packages/gone/src/index.ts\0",
				);
			}
			throw new Error(`Unexpected Git read command: ${args.join(" ")}`);
		};

		const selection = await inspectAffectedWorkspaceSelection(baseSha, {
			repoRoot: "/repo",
			gitRead,
		});

		expect(selection.mode).toBe("affected");
		expect(selection.headSha).toBe(headSha);
		expect(selection.baseSha).toBe(baseSha);
		expect(selection.selectedMembers).toEqual([
			"packages/gone",
			"packages/gone-consumer",
			"packages/new",
			"packages/new-consumer",
			"packages/old",
			"packages/old-consumer",
		]);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every(call => call.options.shell === false && call.options.cwd === "/repo")).toBe(true);
		expect(calls.some(call => call.args[0] === "diff" && call.args.includes("--find-renames"))).toBe(true);
		expect(calls.some(call => call.args[0] === "show" && call.args[1]?.startsWith(`${baseSha}:`))).toBe(true);
		expect(calls.some(call => call.args[0] === "show" && call.args[1]?.startsWith(`${headSha}:`))).toBe(true);
		expect(calls.every(call => call.args[0] !== "checkout")).toBe(true);
	});

	it("falls back to all mode when the immutable base object is missing", async () => {
		const baseSha = "a".repeat(40);
		const headSha = "b".repeat(40);
		const gitRead: GitReadCommand = async args => {
			if (args[0] === "rev-parse" && args[2] === "HEAD^{commit}") return Buffer.from(`${headSha}\n`);
			if (args[0] === "rev-parse" && args[2] === `${baseSha}^{commit}`) throw new Error("missing object");
			if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return Buffer.from("false\n");
			throw new Error(`Unexpected Git read command: ${args.join(" ")}`);
		};

		const selection = await inspectAffectedWorkspaceSelection(baseSha, { repoRoot: "/repo", gitRead });

		expect(selection.mode).toBe("full");
		expect(selection.headSha).toBe(headSha);
		expect(selection.fallbackReason).toMatch(/repository history/);
	});

	it("uses full mode for shared triggers and unmapped shared paths, but not documentation-only changes", () => {
		const knownGraph = basicGraph();
		for (const file of [
			"package.json",
			"bun.lock",
			"packages/shared/tsconfig.json",
			"contracts/model/src/model.ts",
			".github/workflows/ci.yml",
			"natives/text/keys/src/lib.rs",
		]) {
			expect(fullTriggerReason(file)).toBeDefined();
			expect(
				selectAffectedWorkspaceMembers([{ status: "M", paths: [file] }], knownGraph, knownGraph).mode,
			).toBe("full");
		}
		for (const file of ["scripts/ci-test-ts.ts", "ci/cloudflare/lane-tests.sh"]) {
			expect(fullTriggerReason(file)).toBeUndefined();
			expect(
				selectAffectedWorkspaceMembers([{ status: "M", paths: [file] }], knownGraph, knownGraph),
			).toMatchObject({ mode: "affected", selectedMembers: [] });
			expect(ciContractTestsForPaths([file], new Set()).length).toBeGreaterThan(0);
		}
		expect(
			selectAffectedWorkspaceMembers(
				[{ status: "M", paths: ["tools/shared-policy.json"] }],
				knownGraph,
				knownGraph,
			).mode,
		).toBe("full");
		const documentation = selectAffectedWorkspaceMembers(
			[{ status: "M", paths: ["docs/internal/testing.md"] }],
			knownGraph,
			knownGraph,
		);
		expect(documentation).toMatchObject({ mode: "affected", selectedMembers: [] });
	});

	it("sweeps runtime workspace manifests for owner closure and Markdown reader targets", () => {
		const currentGraph = workspaceDependencyGraph();
		const trackedReaders = new Set([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/first-party-docs-are-indexed.test.ts",
		]);
		for (const directory of currentGraph.nodes.keys()) {
			const asset = `${directory}/README.md`;
			const expected = reverseDependencyClosure(currentGraph, [directory]);
			const selection = selectAffectedWorkspaceMembers(
				[{ status: "M", paths: [asset] }],
				currentGraph,
				currentGraph,
			);
			expect(selection).toMatchObject({
				mode: "affected",
				selectedMembers: expected,
				changeMembers: [{ path: asset, selectedMembers: expected }],
			});
			expect(ciContractTestsForPaths([asset], trackedReaders).map(target => target.path)).toEqual([
				"scripts/check-doc-links.test.ts",
				"scripts/check-doc-paths.test.ts",
				"scripts/first-party-docs-are-indexed.test.ts",
			]);
		}
	});

	it("maps root and handbook Markdown to explicit real readers, including cross-member inputs", () => {
		const trackedReaders = new Set([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/first-party-docs-are-indexed.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
			"scripts/settings-doc-coherence.test.ts",
			"scripts/a-documented-provider-default-is-the-descriptor-default.test.ts",
			"scripts/internal-docs-are-tracked.test.ts",
		]);
		const targets = (file: string) => ciContractTestsForPaths([file], trackedReaders).map(target => target.path);
		expect(targets("README.md")).toEqual(["scripts/check-doc-links.test.ts", "scripts/check-doc-paths.test.ts"]);
		expect(targets("docs/README.md")).toEqual([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/first-party-docs-are-indexed.test.ts",
		]);
		expect(targets("docs/handbook/src/reference/settings.md")).toEqual([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
			"scripts/settings-doc-coherence.test.ts",
		]);
		expect(targets("docs/handbook/src/reference/providers.md")).toContain(
			"scripts/a-documented-provider-default-is-the-descriptor-default.test.ts",
		);
		expect(targets("packages/ai/README.md")).toContain(
			"scripts/a-documented-provider-default-is-the-descriptor-default.test.ts",
		);
		expect(targets("packages/ai/NOTES.md")).toContain("scripts/first-party-docs-are-indexed.test.ts");

		const providerReadme = "packages/ai/README.md";
		const realGraph = workspaceDependencyGraph();
		const realSelection = selectAffectedWorkspaceMembers(
			[{ status: "M", paths: [providerReadme] }],
			realGraph,
			realGraph,
		);
		expect(realSelection.selectedMembers).toEqual(reverseDependencyClosure(realGraph, ["packages/ai"]));
	});

	it("routes nested Markdown reader contracts for additions, deletions, renames, and path failures", () => {
		const trackedReaders = new Set([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
		]);
		const targets = ciContractTestsForPaths(
			[
				"packages/ai/new.md",
				"plugins/sample/old.md",
				"plugins/sample/renamed.md",
				"docs/handbook/src/models/system-prompt.md",
			],
			trackedReaders,
		);
		expect(targets.map(target => target.path)).toEqual([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/first-party-docs-are-indexed.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
		]);
	});

	it("maps excluded Markdown to no readers and fails closed when a reader target is absent", () => {
		const trackedReaders = new Set(["scripts/check-doc-links.test.ts", "scripts/check-doc-paths.test.ts"]);
		for (const excluded of [
			"docs/handbook/book/index.md",
			"packages/foo/CHANGELOG.md",
			"plugins/foo/vendor/notes.md",
			"plugins/foo/discovery/builtin-rules/example.md",
		]) {
			expect(ciContractTestsForPaths([excluded], trackedReaders)).toEqual([]);
		}
		expect(() => ciContractTestsForPaths(["packages/ai/README.md"], new Set())).toThrow(
			/non-code reader target is not tracked at HEAD/,
		);
	});

	it("maps Markdown additions, deletions, and both rename sides without dropping reader targets", () => {
		const trackedReaders = new Set([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
		]);
		const targets = ciContractTestsForPaths(
			[
				"docs/handbook/src/new-page.md",
				"docs/handbook/src/old-page.md",
				"docs/handbook/src/old-name.md",
				"docs/handbook/src/new-name.md",
			],
			trackedReaders,
		);
		expect(targets.map(target => target.path)).toEqual([
			"scripts/check-doc-links.test.ts",
			"scripts/check-doc-paths.test.ts",
			"scripts/a-generated-doc-says-so-on-its-first-line.test.ts",
		]);
	});

	it("fails closed for unsupported non-Markdown paths and stale reader targets", () => {
		const knownGraph = basicGraph();
		for (const file of ["docs/assets/diagram.svg", "README.txt", "assets/image.png"]) {
			expect(
				selectAffectedWorkspaceMembers([{ status: "M", paths: [file] }], knownGraph, knownGraph),
			).toMatchObject({ mode: "full" });
		}
		expect(() =>
			ciContractTestsForPaths(
				["docs/handbook/src/reference/settings.md"],
				new Set([
					"scripts/check-doc-links.test.ts",
					"scripts/check-doc-paths.test.ts",
					"scripts/settings-doc-coherence.test.ts",
				]),
			),
		).toThrow(/non-code reader target is not tracked at HEAD/);
	});
	it("keeps changed script tests in a mixed workspace selection", () => {
		const knownGraph = basicGraph();
		const scriptTest = "scripts/ci-test-concurrency-default.test.ts";
		const selection = selectAffectedWorkspaceMembers(
			[{ status: "M", paths: ["packages/app/src/app.ts", scriptTest] }],
			knownGraph,
			knownGraph,
		);

		expect(selection).toMatchObject({ mode: "affected", selectedMembers: ["packages/app"] });
		expect(ciContractTestsForPaths(selection.changedPaths, new Set([scriptTest]))).toContainEqual({
			runner: "bun",
			path: scriptTest,
		});
	});

	it("maps runner changes to exact contract tests, not the scripts suite", () => {
		expect(ciContractTestsForPaths(["scripts/ci-test-ts.ts"], new Set())).toEqual([
			{ runner: "bun", path: "scripts/affected-workspace-selection-keeps-safe-coverage.test.ts" },
			{ runner: "bun", path: "scripts/ci-test-concurrency-default.test.ts" },
		]);
	});

	it("maps Cloudflare source paths to lane tests and Python adapter changes to unittest", () => {
		const targets = ciContractTestsForPaths(["ci/cloudflare/cf_ci.py", "ci/cloudflare/lane-routing.mjs"], new Set());
		expect(targets).toContainEqual({
			runner: "python-unittest",
			path: "ci/cloudflare/test_cf_ci.py",
		});
		expect(targets).toContainEqual({
			runner: "node",
			path: "ci/cloudflare/lane-routing.test.mjs",
		});
		expect(targets).toContainEqual({
			runner: "bun",
			path: "scripts/affected-workspace-selection-keeps-safe-coverage.test.ts",
		});
	});
	it("treats exact lockfile names as full triggers and does not match names that only contain lock", () => {
		for (const file of ["bun.lock", "packages/app/yarn.lock", "Cargo.lock", "go.sum"]) {
			expect(fullTriggerReason(file)).toContain("lockfile");
		}
		expect(fullTriggerReason("packages/app/src/file-lock.ts")).toBeUndefined();
	});

	it("parses related and explicit target arguments without widening their selection", () => {
		const sha = "c".repeat(40);
		expect(parseRunnerArguments([])).toEqual({
			mode: "all",
			changedSince: undefined,
			explicitTestFiles: [],
		});
		expect(parseRunnerArguments(["--changed-since", sha])).toEqual({
			mode: "all",
			changedSince: sha,
			explicitTestFiles: [],
		});
		expect(parseRunnerArguments(["scripts/example.test.ts"])).toEqual({
			mode: "all",
			changedSince: undefined,
			explicitTestFiles: ["scripts/example.test.ts"],
		});
		expect(() => parseRunnerArguments(["--changed-since", "main"])).toThrow(/full 40- or 64-character/);
		expect(() => parseRunnerArguments(["scripts", "--changed-since", sha])).toThrow(/only with the all mode/);
		expect(() => parseRunnerArguments(["local", "scripts/example.test.ts"])).toThrow(/cannot be combined/);
		expect(() => parseRunnerArguments(["--changed-since", sha, "--changed-since", sha])).toThrow(
			/may only be supplied once/,
		);
	});

	it("maps a changed script test only while HEAD still tracks it, so deleted and renamed-away tests are not targets", () => {
		const headTracked = new Set(["scripts/ci-test-concurrency-default.test.ts"]);
		expect(ciContractTestsForPaths(["scripts/ci-test-deleted-away.test.ts"], headTracked)).toEqual([]);
		expect(
			ciContractTestsForPaths(
				["scripts/ci-test-renamed-away.test.ts", "scripts/ci-test-concurrency-default.test.ts"],
				headTracked,
			),
		).toEqual([{ runner: "bun", path: "scripts/ci-test-concurrency-default.test.ts" }]);
	});

	it("keeps a deleted script test affected without selecting any member", () => {
		const knownGraph = basicGraph();
		expect(
			selectAffectedWorkspaceMembers(
				[{ status: "D", paths: ["scripts/ci-test-deleted-away.test.ts"] }],
				knownGraph,
				knownGraph,
			),
		).toMatchObject({ mode: "affected", selectedMembers: [] });
	});

	it("runs a renamed-to script test and drops the renamed-away path", () => {
		const knownGraph = basicGraph();
		const selection = selectAffectedWorkspaceMembers(
			[
				{
					status: "R100",
					paths: ["scripts/ci-test-renamed-away.test.ts", "scripts/ci-test-concurrency-default.test.ts"],
				},
			],
			knownGraph,
			knownGraph,
		);
		const result = composeRelatedSelection({
			inspection: inspectionFor(selection),
			drift: [],
			headTrackedPaths: new Set(["scripts/ci-test-concurrency-default.test.ts"]),
			ownedCommands: [],
		});
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]?.command).toContain("scripts/ci-test-concurrency-default.test.ts");
		expect(result.commands[0]?.command).not.toContain("scripts/ci-test-renamed-away.test.ts");
	});

	it("composes owned member buckets with Bun contract and script targets in a mixed workspace selection", () => {
		const knownGraph = basicGraph();
		const selection = selectAffectedWorkspaceMembers(
			[
				{
					status: "M",
					paths: [
						"packages/app/src/app.ts",
						"scripts/ci-test-ts.ts",
						"scripts/ci-test-concurrency-default.test.ts",
					],
				},
			],
			knownGraph,
			knownGraph,
		);
		const result = composeRelatedSelection({
			inspection: inspectionFor(selection),
			drift: [],
			headTrackedPaths: new Set(["scripts/ci-test-concurrency-default.test.ts"]),
			ownedCommands: [ownedCommand("packages/app"), ownedCommand("packages/shared")],
		});
		expect(result.selectedMembers).toEqual(["packages/app"]);
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0]).toEqual(ownedCommand("packages/app"));
		expect(result.commands[1]).toMatchObject({ label: "targets .", cwd: "." });
		const targets = (result.commands[1]?.command ?? []).filter(argument => argument.startsWith("scripts/")).sort();
		expect(targets).toEqual([
			"scripts/affected-workspace-selection-keeps-safe-coverage.test.ts",
			"scripts/ci-test-concurrency-default.test.ts",
		]);
		expect(result.contractTargets).toContainEqual({
			runner: "bun",
			path: "scripts/ci-test-concurrency-default.test.ts",
		});
	});

	it("runs node contract targets through node --test and leaves python ones unrun", () => {
		const knownGraph = basicGraph();
		const selection = selectAffectedWorkspaceMembers(
			[{ status: "M", paths: ["ci/cloudflare/cf_ci.py"] }],
			knownGraph,
			knownGraph,
		);
		const result = composeRelatedSelection({
			inspection: inspectionFor(selection),
			drift: [],
			headTrackedPaths: new Set(),
			ownedCommands: [],
		});
		expect(result.contractTargets).toContainEqual({ runner: "python-unittest", path: "ci/cloudflare/test_cf_ci.py" });
		expect(result.contractTargets).toContainEqual({ runner: "node", path: "ci/cloudflare/lane-routing.test.mjs" });
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toMatchObject({ label: "node contract tests", cwd: "." });
		expect(result.commands[0]?.command).toEqual([...NODE_TEST_PREFIX, "ci/cloudflare/lane-routing.test.mjs"]);
		expect(result.commands[0]?.command).not.toContain("ci/cloudflare/test_cf_ci.py");
	});

	it("counts node TAP totals only from a complete, consistent summary", () => {
		const green =
			"ok 1 - a\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n";
		expect(parseNodeTapSummary(green)).toEqual({ tests: 2, pass: 2, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
		expect(parseNodeTapSummary(green.replace("# cancelled 0\n", ""))).toBeUndefined();
		expect(parseNodeTapSummary(green.replace("# pass 2", "# pass 1"))).toBeUndefined();
		expect(parseNodeTapSummary("ok 1 - output without a summary")).toBeUndefined();
	});

	it("fails a red or summary-less node run while keeping the totals truthful", () => {
		const totals: NodeTestTotals = { pass: 0, fail: 0, skip: 0, todo: 0, files: 0, runs: 0 };
		const command = [...NODE_TEST_PREFIX, "ci/cloudflare/a.test.mjs", "ci/cloudflare/b.test.mjs"];
		const red = "# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
		expect(recordNodeRun(totals, command, red)).toBe(false);
		expect(recordNodeRun(totals, command, "not tap output")).toBe(false);
		expect(totals).toEqual({ pass: 2, fail: 1, skip: 0, todo: 0, files: 4, runs: 2 });
	});

	it("treats docs-only and deleted-only selections as an explicit no-op", () => {
		const knownGraph = basicGraph();
		for (const paths of [["docs/internal/testing.md"], ["scripts/ci-test-deleted-away.test.ts"]]) {
			const selection = selectAffectedWorkspaceMembers([{ status: "M", paths }], knownGraph, knownGraph);
			expect(
				composeRelatedSelection({
					inspection: inspectionFor(selection),
					drift: [],
					headTrackedPaths: new Set(),
					ownedCommands: [ownedCommand("packages/app")],
				}),
			).toMatchObject({ selectedMembers: [], commands: [] });
		}
	});

	it("still rejects full selections, unowned members and a drifted working tree", () => {
		const knownGraph = basicGraph();
		const full = selectAffectedWorkspaceMembers(
			[{ status: "M", paths: ["tools/shared-policy.json"] }],
			knownGraph,
			knownGraph,
		);
		expect(() =>
			composeRelatedSelection({
				inspection: inspectionFor(full),
				drift: [],
				headTrackedPaths: new Set(),
				ownedCommands: [],
			}),
		).toThrow(/CLOUDFLARE_RELATED_SELECTION_UNAVAILABLE fallback=/);
		const unowned = inspectionFor({
			mode: "affected",
			changedPaths: ["packages/ghost/src/x.ts"],
			selectedMembers: ["packages/ghost"],
			importEdgeCount: 0,
			changeMembers: [],
		});
		expect(() =>
			composeRelatedSelection({
				inspection: unowned,
				drift: [],
				headTrackedPaths: new Set(),
				ownedCommands: [ownedCommand("packages/app")],
			}),
		).toThrow(/no owning test bucket: packages\/ghost/);
		const docs = selectAffectedWorkspaceMembers([{ status: "M", paths: ["docs/a.md"] }], knownGraph, knownGraph);
		expect(() =>
			composeRelatedSelection({
				inspection: inspectionFor(docs),
				drift: ["scripts/x.ts"],
				headTrackedPaths: new Set(),
				ownedCommands: [],
			}),
		).toThrow(/working tree differs from HEAD/);
	});

	it("keeps explicit missing targets fail-closed", () => {
		expect(() => explicitTestCommands(["scripts/ci-test-missing-target.test.ts"])).toThrow(
			/Explicit test target not found/,
		);
	});

	it("reads HEAD tracked paths under a directory through the read-only Git reader", async () => {
		const calls: (readonly string[])[] = [];
		const gitRead: GitReadCommand = async args => {
			calls.push(args);
			return Buffer.from("scripts/ci-test-concurrency-default.test.ts\0scripts/ci-test-ts.ts\0");
		};
		const tracked = await headTrackedFiles(["scripts"], { repoRoot: "/repo", gitRead });
		expect([...tracked]).toEqual(["scripts/ci-test-concurrency-default.test.ts", "scripts/ci-test-ts.ts"]);
		expect(calls).toEqual([["ls-tree", "-r", "-z", "--name-only", "HEAD", "scripts"]]);
	});
});
