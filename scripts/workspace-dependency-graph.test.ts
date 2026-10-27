/**
 * Manifest edges must not leave a directly changed member's dependents out of test selection.
 *
 * WHY THIS SUITE EXISTS. The affected selector cannot safely infer coverage from changed paths alone.
 * It needs strict member membership and reverse edges across every manifest dependency field.
 *
 * WHAT IT DOES NOT CATCH. A real static import omitted from all four package dependency fields has no
 * manifest edge for this graph to follow. Callers must treat this as manifest-edge coverage, not a
 * proof of import completeness.
 */

import { describe, expect, it } from "bun:test";
import {
	buildWorkspaceDependencyGraph,
	reverseDependencyClosure,
	resolveWorkspaceMemberDirectories,
	workspaceDependencyGraph,
	type WorkspaceGraphEntry,
} from "./workspace-layout";

function graphEntry(directory: string, name: string, fields: Record<string, unknown> = {}) {
	return { directory, manifest: { name, ...fields } };
}

describe("workspace manifest membership resolution", () => {
	it("resolves declared glob and nested literal members from available manifest paths", () => {
		const directories = resolveWorkspaceMemberDirectories(
			{
				workspaces: {
					packages: ["packages/*", "packages/deep/leaf", "clients/python/veybot/web"],
				},
			},
			[
				"package.json",
				"packages/one/package.json",
				"packages/deep/leaf/package.json",
				"packages/deep/ignored/package.json",
				"clients/python/veybot/web/package.json",
				"unlisted/package.json",
			],
		);

		expect(directories).toEqual(["clients/python/veybot/web", "packages/deep/leaf", "packages/one"]);
	});

	it("fails closed on unsupported patterns and duplicate or malformed manifest paths", () => {
		const rootManifest = { workspaces: { packages: ["packages/**"] } };
		expect(() =>
			resolveWorkspaceMemberDirectories(rootManifest, ["packages/one/package.json"]),
		).toThrow(/more than one wildcard/);
		expect(() =>
			resolveWorkspaceMemberDirectories(
				{ workspaces: { packages: ["packages/*/nested"] } },
				["packages/one/package.json"],
			),
		).toThrow(/globs above its last segment/);
		expect(() =>
			resolveWorkspaceMemberDirectories(
				{ workspaces: { packages: ["packages/*"] } },
				["packages/one/package.json", "packages/one/package.json"],
			),
		).toThrow(/duplicate workspace manifest path/);
		expect(() =>
			resolveWorkspaceMemberDirectories(
				{ workspaces: { packages: ["packages/*"] } },
				["../outside/package.json"],
			),
		).toThrow(/normalized workspace-relative directory/);
		expect(() =>
			resolveWorkspaceMemberDirectories(
				{ workspaces: { packages: "packages/*" } },
				["packages/one/package.json"],
			),
		).toThrow(/non-empty string array/);
	});
});

describe("workspace reverse dependency selection", () => {
	it("selects direct and transitive dependents from every dependency field", () => {
		const graph = buildWorkspaceDependencyGraph([
			graphEntry("packages/core", "@fixture/core"),
			graphEntry("packages/runtime", "@fixture/runtime", {
				dependencies: { "@fixture/core": "workspace:*" },
			}),
			graphEntry("scripts/dev-tool", "@fixture/dev-tool", {
				devDependencies: { "@fixture/core": "workspace:*" },
			}),
			graphEntry("contracts/types", "@fixture/types", {
				peerDependencies: { "@fixture/core": "workspace:*" },
			}),
			graphEntry("plugins/optional", "@fixture/optional", {
				optionalDependencies: { "@fixture/core": "workspace:*" },
			}),
			graphEntry("hosts/terminal/engine", "@fixture/nested-owner", {
				dependencies: { "@fixture/runtime": "workspace:*" },
			}),
		]);

		expect(reverseDependencyClosure(graph, ["packages/core"])).toEqual([
			"contracts/types",
			"hosts/terminal/engine",
			"packages/core",
			"packages/runtime",
			"plugins/optional",
			"scripts/dev-tool",
		]);
	});

	it("returns the same sorted closure when manifest order changes and dependency cycles exist", () => {
		const members = [
			graphEntry("packages/alpha", "@fixture/alpha", {
				dependencies: { "@fixture/beta": "workspace:*" },
			}),
			graphEntry("packages/beta", "@fixture/beta", {
				dependencies: { "@fixture/alpha": "workspace:*" },
			}),
			graphEntry("apps/consumer", "@fixture/consumer", {
				dependencies: { "@fixture/beta": "workspace:*" },
			}),
		];
		const expected = ["apps/consumer", "packages/alpha", "packages/beta"];

		expect(reverseDependencyClosure(buildWorkspaceDependencyGraph(members), ["packages/alpha"])).toEqual(expected);
		expect(reverseDependencyClosure(buildWorkspaceDependencyGraph([...members].reverse()), ["packages/alpha"])).toEqual(
			expected,
		);
	});

	it("unions before and after closures so a removed edge still selects its former consumer", () => {
		const before = buildWorkspaceDependencyGraph([
			graphEntry("contracts/core", "@fixture/core"),
			graphEntry("apps/consumer", "@fixture/consumer", {
				dependencies: { "@fixture/core": "workspace:*" },
			}),
		]);
		const after = buildWorkspaceDependencyGraph([
			graphEntry("contracts/core", "@fixture/core"),
			graphEntry("apps/consumer", "@fixture/consumer"),
		]);
		const union = new Set([
			...reverseDependencyClosure(before, ["contracts/core"]),
			...reverseDependencyClosure(after, ["contracts/core"]),
		]);

		expect(reverseDependencyClosure(after, ["contracts/core"])).toEqual(["contracts/core"]);
		expect([...union].sort()).toEqual(["apps/consumer", "contracts/core"]);
	});

	it("models type-only workspace use through manifest dependency fields", () => {
		const graph = buildWorkspaceDependencyGraph([
			graphEntry("contracts/types", "@fixture/types"),
			graphEntry("packages/type-consumer", "@fixture/type-consumer", {
				devDependencies: { "@fixture/types": "workspace:*" },
			}),
		]);

		expect(reverseDependencyClosure(graph, ["contracts/types"])).toEqual([
			"contracts/types",
			"packages/type-consumer",
		]);
	});

	it("builds the current tree graph from declared package manifests", () => {
		const graph = workspaceDependencyGraph();

		expect(graph.names.get("@veyyon/utils")).toBe("packages/utils");
		expect(graph.nodes.get("packages/agent")?.dependencies.has("packages/utils")).toBe(true);
		expect(graph.reverseDependencies.get("packages/utils")?.has("packages/agent")).toBe(true);
	});
});

describe("strict workspace graph validation", () => {
	it("rejects missing and duplicate package names and duplicate directories", () => {
		expect(() =>
			buildWorkspaceDependencyGraph([
				{ directory: "packages/missing-name", manifest: {} },
			]),
		).toThrow(/invalid package name/);
		expect(() => buildWorkspaceDependencyGraph([graphEntry("packages/invalid-name", "@Fixture/one")])).toThrow(
			/invalid package name/,
		);
		expect(() =>
			buildWorkspaceDependencyGraph([
				graphEntry("packages/one", "@fixture/same"),
				graphEntry("packages/two", "@fixture/same"),
			]),
		).toThrow(/duplicate workspace package name/);
		expect(() =>
			buildWorkspaceDependencyGraph([
				graphEntry("packages/one", "@fixture/one"),
				graphEntry("packages/one", "@fixture/two"),
			]),
		).toThrow(/duplicate workspace member directory/);
		expect(() =>
			buildWorkspaceDependencyGraph([
				{ directory: "packages/invalid-manifest", manifest: null } as unknown as WorkspaceGraphEntry,
			]),
		).toThrow(/manifest object/);
	});

	it("rejects malformed dependency fields for every dependency category", () => {
		const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
		for (const field of fields) {
			expect(() =>
				buildWorkspaceDependencyGraph([
					graphEntry("packages/one", "@fixture/one", { [field]: [] }),
				]),
			).toThrow(/must be an object of package specs/);
		}
		expect(() =>
			buildWorkspaceDependencyGraph([
				graphEntry("packages/one", "@fixture/one", {
					dependencies: { "@fixture/external": { version: "1.0.0" } },
				}),
			]),
		).toThrow(/must be a non-empty string/);
		expect(() =>
			buildWorkspaceDependencyGraph([
				graphEntry("packages/one", "@fixture/one", { dependencies: { "@fixture/external": "" } }),
			]),
		).toThrow(/must be a non-empty string/);
	});

	it("throws for unresolved workspace references and unsupported dependency aliases", () => {
		expect(() =>
			buildWorkspaceDependencyGraph([
				graphEntry("packages/one", "@fixture/one", {
					dependencies: { "@fixture/missing": "workspace:*" },
				}),
			]),
		).toThrow(/unresolved workspace dependency/);

		for (const spec of ["file:../local", "link:../local", "npm:@fixture/core@*"]) {
			expect(() =>
				buildWorkspaceDependencyGraph([
					graphEntry("packages/one", "@fixture/one", {
						dependencies: { "@fixture/alias": spec },
					}),
				]),
			).toThrow(/unsupported .* dependency spec/);
		}
	});

	it("rejects a closure seed that is not a member of its snapshot graph", () => {
		const graph = buildWorkspaceDependencyGraph([graphEntry("packages/one", "@fixture/one")]);

		expect(() => reverseDependencyClosure(graph, ["packages/missing"])).toThrow(/unknown changed workspace member/);
	});
});
