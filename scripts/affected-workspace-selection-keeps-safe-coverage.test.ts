import { describe, expect, it } from "bun:test";
import {
	AFFECTED_DYNAMIC_IMPORT_LOADER_FILES,
	AFFECTED_SELECTOR_ID,
	buildWorkspaceGraphWithImports,
	fullTriggerReason,
	inspectAffectedWorkspaceSelection,
	parseGitNameStatus,
	selectAffectedWorkspaceMembers,
	type GitReadCommand,
	type WorkspaceSourceFile,
} from "./affected-workspace-tests";
import {
	buildWorkspaceDependencyGraph,
	type WorkspaceDependencyGraph,
	type WorkspaceGraphEntry,
} from "./workspace-layout";
import {
	buildAffectedTestPlan,
	buildAllModeCommandPlan,
	fastWorkspacePackages,
	nativeAndIntegrationPackages,
	parseRunnerArguments,
	repoScriptTests,
} from "./ci-test-ts";

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
			"scripts/ci-test-ts.ts",
			"ci/cloudflare/lane-tests.sh",
			".github/workflows/ci.yml",
			"natives/text/keys/src/lib.rs",
		]) {
			expect(fullTriggerReason(file)).toBeDefined();
			expect(
				selectAffectedWorkspaceMembers([{ status: "M", paths: [file] }], knownGraph, knownGraph).mode,
			).toBe("full");
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

	it("treats exact lockfile names as full triggers and does not match names that only contain lock", () => {
		for (const file of ["bun.lock", "packages/app/yarn.lock", "Cargo.lock", "go.sum"]) {
			expect(fullTriggerReason(file)).toContain("lockfile");
		}
		expect(fullTriggerReason("packages/app/src/file-lock.ts")).toBeUndefined();
	});

	it("parses the changed-since option without treating its SHA as a mode", () => {
		const sha = "c".repeat(40);
		expect(parseRunnerArguments([])).toEqual(parseRunnerArguments(["all"]));
		expect(parseRunnerArguments(["--changed-since", sha, "--dry-run"])).toMatchObject({
			mode: "all",
			changedSince: sha,
			dryRun: true,
			planJson: false,
		});
		expect(() => parseRunnerArguments(["--changed-since", "main"])).toThrow(/full 40- or 64-character/);
		expect(() => parseRunnerArguments(["scripts", "--changed-since", sha])).toThrow(/only with the all mode/);
	});

	it("preserves the exact unfiltered all-mode command plan", async () => {
		const fullPlan = await buildAllModeCommandPlan(undefined, null);
		const allMembers = [...fastWorkspacePackages, ...nativeAndIntegrationPackages, "packages/coding-agent"];
		const selectedPlan = await buildAllModeCommandPlan(allMembers, null);

		expect(selectedPlan.commands).toEqual(fullPlan.commands);
	});

	it("keeps script gates and architecture suites in selected chunks exactly once", async () => {
		const sha = "d".repeat(40);
		const plan = await buildAffectedTestPlan(
			{
				selectorId: AFFECTED_SELECTOR_ID,
				baseSha: "e".repeat(40),
				headSha: sha,
				mode: "affected",
				changedPaths: ["packages/utils/src/index.ts"],
				selectedMembers: ["packages/utils"],
				importEdgeCount: 0,
				changeMembers: [{ path: "packages/utils/src/index.ts", selectedMembers: ["packages/utils"] }],
				importEdgeCountsByRevision: { base: 0, head: 0 },
			},
			{ index: 0, count: 1 },
		);
		const allChunkFiles = plan.chunks.flatMap(chunk => chunk.files);
		const scriptFiles = plan.selectedInventory.filter(file => repoScriptTests.includes(file));
		const architectureFiles = plan.selectedInventory.filter(file =>
			file.startsWith("packages/coding-agent/test/architecture/"),
		);
		const architectureOccurrences = allChunkFiles.filter(file =>
			file.startsWith("packages/coding-agent/test/architecture/"),
		);

		expect(plan.mode).toBe("affected");
		expect(plan.selectedMembers).toEqual(["packages/utils"]);
		expect(plan.selectionHash).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.importEdgeCountsByRevision).toEqual({ base: 0, head: 0 });
		expect(scriptFiles.sort()).toEqual([...new Set(repoScriptTests)].sort());
		expect(architectureFiles.length).toBeGreaterThan(0);
		expect(architectureOccurrences.sort()).toEqual(architectureFiles.sort());
		expect(new Set(allChunkFiles).size).toBe(allChunkFiles.length);
		expect([...allChunkFiles].sort()).toEqual(plan.selectedInventory);
		expect(plan.chunks.every(chunk => chunk.files.length <= 10)).toBe(true);
		expect(plan.chunks.some(chunk => chunk.cwd === "packages/utils")).toBe(true);
		expect(plan.chunks.some(chunk => chunk.cwd === ".")).toBe(true);
		expect(plan.commands.filter(command => command.cwd === "packages/coding-agent").every(command =>
			command.command.includes("--preload") && command.command.some(argument => argument.startsWith("--parallel=")),
		)).toBe(true);
	});
});
