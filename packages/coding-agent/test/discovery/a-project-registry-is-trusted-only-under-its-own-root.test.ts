/**
 * WHY THIS SUITE EXISTS.
 *
 * Defect (issue 633, security): the project plugin registry gate computed its trust root from the
 * working directory, `canonicalProjectRoot(cwd)`. The registry lives at the owner's
 * `.veyyon/plugins/installed_plugins.json`, which is outside a nested cwd. The describer therefore
 * returned null for it, and `projectRegistryIsTrusted` returned `allowed: true`. The gate was
 * fail-open: a registry above a nested directory loaded with no decision recorded at all. It did
 * not report "untrusted". The same happens when the nested directory carries its own `.git`
 * marker, because the root is then that nested repository.
 *
 * The fix keys the gate on the registry's owner: the owner's git root, or the owner itself outside
 * a repository. `runTrustCommand` records under `findRepoRoot(cwd) ?? cwd`, and an approval given
 * at the owner is found from any spelling of a nested cwd. The class is the trust root disagreeing
 * with the registry actually loaded, across each spelling of one directory: nested, dotted,
 * trailing-slash, symlinked and cased, with and without a `.git` marker in the nested directory.
 * A non-git `.veyyon/` ancestor has its own fixture.
 *
 * Every state runs through the real `runTrustCommand` and the real `listClaudePluginRoots`, over an
 * `installed_plugins.json` written to disk. The assertions are on the plugin roots that come back
 * and on the refusal warnings. Each spelling is checked twice: refused before any approval, then
 * loaded after the owner approves. The profile registry lives outside the project, so each case
 * also checks that it still loads.
 *
 * Mutations this suite is designed to catch:
 * - Key the gate on `canonicalProjectRoot(cwd)` again: the nested no-decision cases load the
 *   registry, which is the fail-open defect.
 * - Let a describer null mean allowed: the nested `.git` no-decision case loads the registry.
 * - Drop the non-git owner fallback: the `.veyyon` ancestor case loads nothing from a nested cwd.
 * - Let an approval for one repository trust another: the unrelated-project control loads.
 * - Ignore the recorded denial or the registry bytes: the denial and changed-bytes cases load.
 * - Gate the profile registry, which sits outside the project: the profile root disappears.
 * - Key the writer on `findRepoRoot(cwd) ?? cwd` again: a nested non-git approval never reaches the gate.
 * - Let a junction that resolves outside the repository load after approval: the escape case loads.
 * - Serve a warm cache entry after a denial or a byte change: the warm cases load.
 *
 * Gaps: the Windows drive-letter and case variants run only on Windows, and whether they resolve to one
 * trust key depends on how the runtime's `realpath.native` treats case, which this suite does not normalise.
 * The suite does not run plugin code, and it does not cover `--plugin-dir` roots or the Claude Code registry.
 * The gate decides the registry file only. Project scope reads no other file in the project directory: its
 * `package.json`, lockfile and `node_modules` are not read. The files inside each `installPath` directory the
 * registry names are read as before, and they are not hashed. This suite does not claim to cover them.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTrustCommand, type TrustCommandResult } from "@veyyon/coding-agent/cli/trust-cli";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "@veyyon/coding-agent/discovery/helpers";
import { getConfigDirName } from "@veyyon/utils";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

const PROJECT_PLUGIN = "project-tool@project-market";
const PROFILE_PLUGIN = "profile-tool@profile-market";
const OTHER_PLUGIN = "other-tool@other-market";
const REGISTRY_RELATIVE = path.join(getConfigDirName(), "plugins", "installed_plugins.json").split(path.sep).join("/");
const NOT_TRUSTED = "has not been trusted";

interface Fixture {
	tempRoot: string;
	repoRoot: string;
	nestedCwd: string;
	agentDir: string;
	pluginsRoot: string;
	home: string;
	projectInstallPath: string;
}

function registryJson(plugins: Record<string, string>, scope: "user" | "project" = "project"): string {
	const entries: Record<string, unknown[]> = {};
	for (const [id, installPath] of Object.entries(plugins)) {
		entries[id] = [
			{
				scope,
				installPath,
				version: "1.0.0",
				installedAt: "2026-10-20T00:00:00.000Z",
				lastUpdated: "2026-10-20T00:00:00.000Z",
			},
		];
	}
	return `${JSON.stringify({ version: 2, plugins: entries }, null, 2)}\n`;
}

async function writeProjectRegistry(root: string, bytes: string): Promise<void> {
	const file = path.join(root, getConfigDirName(), "plugins", "installed_plugins.json");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, bytes);
}

async function makeFixture(): Promise<Fixture> {
	const tempRoot = makeTempDir("veyyon-project-registry-");
	const repoRoot = path.join(tempRoot, "repo");
	const nestedCwd = path.join(repoRoot, "packages", "workspace");
	const agentDir = path.join(tempRoot, "profiles", "work", "agent");
	const pluginsRoot = path.join(tempRoot, "profiles", "work", "plugins");
	const home = path.join(tempRoot, "home");
	const projectInstallPath = path.join(tempRoot, "payloads", "project-tool");
	await Promise.all([
		fs.mkdir(path.join(repoRoot, ".git"), { recursive: true }),
		fs.mkdir(nestedCwd, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(pluginsRoot, { recursive: true }),
		fs.mkdir(home, { recursive: true }),
	]);
	await fs.writeFile(
		path.join(pluginsRoot, "installed_plugins.json"),
		registryJson({ [PROFILE_PLUGIN]: path.join(tempRoot, "payloads", "profile-tool") }, "user"),
	);
	return { tempRoot, repoRoot, nestedCwd, agentDir, pluginsRoot, home, projectInstallPath };
}

function decide(action: "approve" | "deny" | "list", cwd: string, agentDir: string): Promise<TrustCommandResult> {
	clearFsCache();
	return runTrustCommand({ cwd, agentDir, action, paths: [] });
}

async function loadRoots(fixture: Fixture, cwd: string) {
	clearClaudePluginRootsCache(cwd);
	clearFsCache();
	return listClaudePluginRoots(fixture.home, cwd, fixture.pluginsRoot, fixture.agentDir);
}

function refusals(warnings: readonly string[]): string[] {
	return warnings.filter(warning => warning.startsWith("plugins:"));
}

function pluginIds(roots: readonly { id: string }[]): string[] {
	return roots.map(root => root.id);
}

function verdictFor(result: TrustCommandResult, relativePath: string): string | undefined {
	return result.candidates.find(candidate => candidate.relativePath === relativePath)?.verdict;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function probeDirSymlinkSupport(): Promise<boolean> {
	const probeDir = makeTempDir("veyyon-project-registry-symlink-probe-");
	const target = path.join(probeDir, "target");
	const link = path.join(probeDir, "link");
	await fs.mkdir(target, { recursive: true });
	try {
		await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
		throw error;
	}
}

/** Loads each spelling and reports whether the project root loaded and whether it was refused. */
async function probeSpellings(fixture: Fixture, spellings: readonly string[]) {
	const probes: Array<{ spelling: string; loaded: boolean; refused: boolean }> = [];
	for (const spelling of spellings) {
		const loaded = await loadRoots(fixture, spelling);
		probes.push({
			spelling,
			loaded: pluginIds(loaded.roots).includes(PROJECT_PLUGIN),
			refused: refusals(loaded.warnings).join("\n").includes(NOT_TRUSTED),
		});
	}
	return probes;
}

const dirSymlinksAvailable = await probeDirSymlinkSupport();
const dirSymlinkTest = test.skipIf(!dirSymlinksAvailable);

test("an approval given from the nested cwd loads the project registry's plugin root from that cwd", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const approval = await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(approval.decision).toBe("trusted");
	expect(approval.projectRoot).toBe(await fs.realpath(fixture.repoRoot));
	expect(verdictFor(approval, REGISTRY_RELATIVE)).toBe("trusted");
	expect(loaded.roots.find(root => root.id === PROJECT_PLUGIN)).toEqual({
		id: PROJECT_PLUGIN,
		marketplace: "project-market",
		plugin: "project-tool",
		version: "1.0.0",
		path: fixture.projectInstallPath,
		scope: "project",
	});
	expect(refusals(loaded.warnings)).toEqual([]);
});

test("every spelling of the nested cwd is refused before approval and loads the same root after it", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	const sep = path.sep;
	const spellings = [fixture.repoRoot, fixture.nestedCwd, `${fixture.nestedCwd}${sep}`, `${fixture.nestedCwd}${sep}.`, `${fixture.repoRoot}${sep}packages${sep}..${sep}packages${sep}workspace`];

	const before = await probeSpellings(fixture, spellings);
	await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const after = await probeSpellings(fixture, spellings);

	expect(before).toEqual(spellings.map(spelling => ({ spelling, loaded: false, refused: true })));
	expect(after).toEqual(spellings.map(spelling => ({ spelling, loaded: true, refused: false })));
});

dirSymlinkTest("an alias of the repository is refused before approval and loads the registry approved through the real path", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	const alias = path.join(fixture.tempRoot, "alias-repo");
	await fs.symlink(fixture.repoRoot, alias, process.platform === "win32" ? "junction" : "dir");
	const aliasedNestedCwd = path.join(alias, "packages", "workspace");

	const beforeApproval = await loadRoots(fixture, aliasedNestedCwd);
	const approval = await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const loaded = await loadRoots(fixture, aliasedNestedCwd);

	expect(pluginIds(beforeApproval.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(beforeApproval.warnings).join("\n")).toContain(NOT_TRUSTED);
	expect(approval.decision).toBe("trusted");
	expect(pluginIds(loaded.roots)).toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings)).toEqual([]);
});

test.skipIf(process.platform !== "win32")(
	"a drive-letter and case variant of the nested cwd is refused before approval and loads the same root after it",
	async () => {
		const fixture = await makeFixture();
		await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

		const drive = fixture.nestedCwd.charAt(0);
		const flippedDrive = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) +
			fixture.nestedCwd.slice(1);
		const upperCased = flippedDrive.charAt(0) + flippedDrive.slice(1).toUpperCase();
		const variants = [flippedDrive, upperCased];

		const before = await probeSpellings(fixture, variants);
		await decide("approve", fixture.nestedCwd, fixture.agentDir);
		const after = await probeSpellings(fixture, variants);

		expect(before).toEqual(variants.map(spelling => ({ spelling, loaded: false, refused: true })));
		expect(after).toEqual(variants.map(spelling => ({ spelling, loaded: true, refused: false })));
	},
);

test("with no decision the project registry is withheld and the profile registry still loads", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const listed = await decide("list", fixture.nestedCwd, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);
	const ids = pluginIds(loaded.roots);

	expect(listed.decision).toBe("undecided");
	expect(verdictFor(listed, REGISTRY_RELATIVE)).toBe("untrusted");
	expect(ids).toContain(PROFILE_PLUGIN);
	expect(ids).not.toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings).join("\n")).toContain(`${REGISTRY_RELATIVE} was not loaded because this project has not been trusted`);
});

test("a .git marker added inside the nested cwd does not trust the registry above it without an owner decision", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await fs.mkdir(path.join(fixture.nestedCwd, ".git"), { recursive: true });

	const listed = await decide("list", fixture.repoRoot, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(listed.decision).toBe("undecided");
	expect(verdictFor(listed, REGISTRY_RELATIVE)).toBe("untrusted");
	expect(pluginIds(loaded.roots)).toContain(PROFILE_PLUGIN);
	expect(pluginIds(loaded.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings).join("\n")).toContain(NOT_TRUSTED);
});

test("a denial at the owner withholds the registry even from a nested cwd with its own .git marker", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await fs.mkdir(path.join(fixture.nestedCwd, ".git"), { recursive: true });

	const denied = await decide("deny", fixture.repoRoot, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(denied.decision).toBe("denied");
	expect(pluginIds(loaded.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings).join("\n")).toContain("this project is marked untrusted");
});

test("an approval at the owner loads the registry from a nested cwd with its own .git marker", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await fs.mkdir(path.join(fixture.nestedCwd, ".git"), { recursive: true });

	const approval = await decide("approve", fixture.repoRoot, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(approval.decision).toBe("trusted");
	expect(pluginIds(loaded.roots)).toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings)).toEqual([]);
});

test("a denial recorded at the repository root withholds the registry from a nested cwd", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const denied = await decide("deny", fixture.repoRoot, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(denied.decision).toBe("denied");
	expect(verdictFor(denied, REGISTRY_RELATIVE)).toBe("denied");
	expect(pluginIds(loaded.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings).join("\n")).toContain("this project is marked untrusted");
});

test("registry bytes that change after approval are withheld until they are approved again", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await decide("approve", fixture.nestedCwd, fixture.agentDir);

	await writeProjectRegistry(
		fixture.repoRoot,
		registryJson({
			[PROJECT_PLUGIN]: fixture.projectInstallPath,
			[OTHER_PLUGIN]: path.join(fixture.tempRoot, "payloads", "other-tool"),
		}),
	);
	const listed = await decide("list", fixture.nestedCwd, fixture.agentDir);
	const changed = await loadRoots(fixture, fixture.nestedCwd);

	expect(verdictFor(listed, REGISTRY_RELATIVE)).toBe("changed");
	expect(pluginIds(changed.roots)).not.toContain(PROJECT_PLUGIN);
	expect(pluginIds(changed.roots)).not.toContain(OTHER_PLUGIN);
	expect(refusals(changed.warnings).join("\n")).toContain("its contents changed since it was trusted");

	await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const reapproved = await loadRoots(fixture, fixture.nestedCwd);

	expect(pluginIds(reapproved.roots)).toContain(PROJECT_PLUGIN);
	expect(pluginIds(reapproved.roots)).toContain(OTHER_PLUGIN);
	expect(refusals(reapproved.warnings)).toEqual([]);
});

test("approving an unrelated repository never trusts this repository's registry", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const otherRepo = path.join(fixture.tempRoot, "other-repo");
	const otherNestedCwd = path.join(otherRepo, "src");
	await fs.mkdir(path.join(otherRepo, ".git"), { recursive: true });
	await fs.mkdir(otherNestedCwd, { recursive: true });
	await writeProjectRegistry(otherRepo, registryJson({ [OTHER_PLUGIN]: path.join(fixture.tempRoot, "payloads", "other-tool") }));
	await decide("approve", otherNestedCwd, fixture.agentDir);

	const fromThisRepo = await loadRoots(fixture, fixture.nestedCwd);
	const fromOtherRepo = await loadRoots(fixture, otherNestedCwd);

	expect(pluginIds(fromThisRepo.roots)).not.toContain(PROJECT_PLUGIN);
	expect(pluginIds(fromThisRepo.roots)).not.toContain(OTHER_PLUGIN);
	expect(refusals(fromThisRepo.warnings).join("\n")).toContain(NOT_TRUSTED);
	expect(pluginIds(fromOtherRepo.roots)).toContain(OTHER_PLUGIN);
	expect(pluginIds(fromOtherRepo.roots)).not.toContain(PROJECT_PLUGIN);
});

test("a registry under a non-git owner directory is refused before approval and loads from a nested cwd after it", async () => {
	const fixture = await makeFixture();
	const owner = path.join(fixture.tempRoot, "loose-owner");
	const nestedCwd = path.join(owner, "a", "b");
	await fs.mkdir(nestedCwd, { recursive: true });
	await writeProjectRegistry(owner, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const beforeApproval = await loadRoots(fixture, nestedCwd);
	const approval = await decide("approve", owner, fixture.agentDir);
	const loaded = await loadRoots(fixture, nestedCwd);

	expect(pluginIds(beforeApproval.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(beforeApproval.warnings).join("\n")).toContain(NOT_TRUSTED);
	expect(approval.decision).toBe("trusted");
	expect(approval.projectRoot).toBe(await fs.realpath(owner));
	expect(pluginIds(loaded.roots)).toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings)).toEqual([]);
});

async function loadWarm(fixture: Fixture, cwd: string) {
	return listClaudePluginRoots(fixture.home, cwd, fixture.pluginsRoot, fixture.agentDir);
}

test("a nested non-git approval is recorded under the key the gate reads, so the same cwd loads the registry", async () => {
	const fixture = await makeFixture();
	const owner = path.join(fixture.tempRoot, "loose-owner");
	const nestedCwd = path.join(owner, "a", "b");
	await fs.mkdir(nestedCwd, { recursive: true });
	await writeProjectRegistry(owner, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));

	const approval = await decide("approve", nestedCwd, fixture.agentDir);
	const loaded = await loadRoots(fixture, nestedCwd);

	expect(approval.decision).toBe("trusted");
	expect(approval.projectRoot).toBe(await fs.realpath(owner));
	expect(pluginIds(loaded.roots)).toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings)).toEqual([]);
});

test("a project plugin directory that links outside the repository is refused even after approval", async () => {
	const fixture = await makeFixture();
	const outside = path.join(fixture.tempRoot, "outside-plugins");
	await fs.mkdir(outside, { recursive: true });
	await fs.writeFile(
		path.join(outside, "installed_plugins.json"),
		registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }),
	);
	const linkDir = path.join(fixture.repoRoot, getConfigDirName(), "plugins");
	await fs.mkdir(path.dirname(linkDir), { recursive: true });
	// A junction needs no privilege on Windows; the type argument is ignored on other platforms.
	await fs.symlink(outside, linkDir, "junction");

	const approval = await decide("approve", fixture.repoRoot, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);

	expect(approval.candidates).toEqual([]);
	expect(approval.outOfScope).toHaveLength(1);
	expect(pluginIds(loaded.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(loaded.warnings).join("\n")).toContain("resolves outside the project root");
});

test("a warm load is not served after the operator denies the registry it had loaded", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const warm = await loadWarm(fixture, fixture.nestedCwd);
	expect(pluginIds(warm.roots)).toContain(PROJECT_PLUGIN);

	await decide("deny", fixture.nestedCwd, fixture.agentDir);
	const afterDeny = await loadWarm(fixture, fixture.nestedCwd);

	expect(pluginIds(afterDeny.roots)).not.toContain(PROJECT_PLUGIN);
	expect(refusals(afterDeny.warnings).join("\n")).toContain("this project is marked untrusted");
});

test("a warm load is not served after the registry bytes change under an approval", async () => {
	const fixture = await makeFixture();
	await writeProjectRegistry(fixture.repoRoot, registryJson({ [PROJECT_PLUGIN]: fixture.projectInstallPath }));
	await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const warm = await loadWarm(fixture, fixture.nestedCwd);
	expect(pluginIds(warm.roots)).toContain(PROJECT_PLUGIN);

	await writeProjectRegistry(
		fixture.repoRoot,
		registryJson({
			[PROJECT_PLUGIN]: fixture.projectInstallPath,
			[OTHER_PLUGIN]: path.join(fixture.tempRoot, "payloads", "other-tool"),
		}),
	);
	const afterChange = await loadWarm(fixture, fixture.nestedCwd);

	expect(pluginIds(afterChange.roots)).not.toContain(PROJECT_PLUGIN);
	expect(pluginIds(afterChange.roots)).not.toContain(OTHER_PLUGIN);
	expect(refusals(afterChange.warnings).join("\n")).toContain("its contents changed since it was trusted");
});
test("the approved project registry alone loads plugins, without falling back to project dependencies", async () => {
	const fixture = await makeFixture();
	const explicitPluginPath = fixture.projectInstallPath;
	const unlistedPackagePath = path.join(fixture.tempRoot, "packages", "other-tool");
	const unlistedDependencyPath = path.join(fixture.repoRoot, "node_modules", "other-tool");
	await fs.mkdir(explicitPluginPath, { recursive: true });
	await fs.mkdir(unlistedPackagePath, { recursive: true });
	await fs.mkdir(path.dirname(unlistedDependencyPath), { recursive: true });
	await fs.writeFile(
		path.join(fixture.repoRoot, "package.json"),
		JSON.stringify({ private: true, dependencies: { "other-tool": "file:packages/other-tool" } }, null, 2),
	);
	await fs.writeFile(
		path.join(fixture.repoRoot, "package-lock.json"),
		JSON.stringify(
			{
				name: "project",
				lockfileVersion: 3,
				packages: {
					"": { dependencies: { "other-tool": "file:packages/other-tool" } },
					"node_modules/other-tool": { resolved: "packages/other-tool", link: true },
					"packages/other-tool": { name: "other-tool", version: "1.0.0" },
				},
			},
			null,
			2,
		),
	);
	await fs.writeFile(
		path.join(unlistedPackagePath, "package.json"),
		JSON.stringify({ name: "other-tool", version: "1.0.0" }),
	);
	await fs.writeFile(path.join(unlistedPackagePath, "package-marker.txt"), "dependency-only");
	await fs.symlink(unlistedPackagePath, unlistedDependencyPath, "junction");
	await writeProjectRegistry(
		fixture.repoRoot,
		JSON.stringify({
			version: 2,
			plugins: {
				[PROJECT_PLUGIN]: [
					{
						scope: "project",
						installPath: explicitPluginPath,
						version: "1.0.0",
						installedAt: "2026-10-20T00:00:00.000Z",
						lastUpdated: "2026-10-20T00:00:00.000Z",
					},
				],
				[OTHER_PLUGIN]: [
					{
						scope: "project",
						version: "1.0.0",
						installedAt: "2026-10-20T00:00:00.000Z",
						lastUpdated: "2026-10-20T00:00:00.000Z",
					},
				],
			},
		}),
	);
	const approval = await decide("approve", fixture.nestedCwd, fixture.agentDir);
	const loaded = await loadRoots(fixture, fixture.nestedCwd);
	const projectRoots = loaded.roots.filter(root => root.scope === "project");

	expect(approval.decision).toBe("trusted");
	expect(projectRoots).toEqual(
		expect.arrayContaining([expect.objectContaining({ id: PROJECT_PLUGIN, path: explicitPluginPath })]),
	);
	expect(pluginIds(projectRoots)).toEqual([PROJECT_PLUGIN]);
	expect(pluginIds(loaded.roots)).toContain(PROFILE_PLUGIN);
	expect(pluginIds(loaded.roots)).not.toContain(OTHER_PLUGIN);
	expect(projectRoots.some(root => root.path === unlistedDependencyPath || root.path === unlistedPackagePath)).toBe(false);
	expect(loaded.warnings.join("\n")).toContain(`${OTHER_PLUGIN} entry has no installPath`);
});
