/**
 * WHY: registry-only approvals let changed plugin code load without consent.
 * Sweep every file actually present under each registered installPath, then exercise
 * both production consumers with warm caches. This closes payload edit/add/remove/
 * rename, legacy approval, profile isolation and realpath-escape variants.
 * Negative controls: bypass payload hashing, containment, or current-profile trust;
 * the changed-file, escape, and other-profile cases must fail respectively.
 * Gap: this is startup discovery proof, not a sandbox against writes after loading.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTrustCommand } from "@veyyon/coding-agent/cli/trust-cli";
import { canonicalProjectRoot, describeProjectExecutable, ProjectTrust } from "@veyyon/coding-agent/config/project-trust";
import { listClaudePluginRoots } from "@veyyon/coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@veyyon/coding-agent/extensibility/plugins/loader";
import { loadConfig } from "@veyyon/coding-agent/lsp/config";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

interface Fixture {
	root: string;
	repo: string;
	agentDir: string;
	pluginsRoot: string;
	home: string;
	registry: string;
	installPath: string;
}

async function fixture(scope: "project" | "user" = "project"): Promise<Fixture> {
	const root = makeTempDir("plugin-payload-trust-");
	const repo = path.join(root, "repo");
	const agentDir = path.join(root, "profile", "agent");
	const pluginsRoot = path.join(root, "profile", "plugins");
	const home = path.join(root, "home");
	const registry = path.join(repo, ".veyyon", "plugins", "installed_plugins.json");
	const installPath = path.join(repo, "payload");
	for (const dir of [path.join(repo, ".git"), path.dirname(registry), installPath, agentDir, pluginsRoot, home]) {
		await fs.mkdir(dir, { recursive: true });
	}
	const files = {
		"package.json": JSON.stringify({ name: "payload", version: "1.0.0", veyyon: { extensions: ["extension.ts"] } }),
		"extension.ts": "export default () => {};\n",
		"scripts/run.js": "export const value = 1;\n",
		"assets/nested/input.txt": "approved asset\n",
		".git/config": "opaque plugin asset\n",
	};
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(installPath, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	await fs.writeFile(registry, JSON.stringify({ version: 2, plugins: {
		"payload@test": [{ scope, installPath, version: "1.0.0", installedAt: "2026-01-01", lastUpdated: "2026-01-01" }],
	} }));
	return { root, repo, agentDir, pluginsRoot, home, registry, installPath };
}

async function decide(f: Fixture, action: "approve" | "deny" | "list") {
	return runTrustCommand({ cwd: f.repo, agentDir: f.agentDir, action, paths: [] });
}

async function assertLoaded(f: Fixture, expected: boolean, agentDir = f.agentDir) {
	// Do not clear caches: revocation must invalidate both consumers' warm entries.
	const roots = await listClaudePluginRoots(f.home, f.repo, f.pluginsRoot, agentDir);
	const plugins = await getEnabledPlugins(f.repo, { home: f.home, pluginsRoot: f.pluginsRoot, agentDir });
	expect(roots.roots.some(root => root.scope === "project" && root.id === "payload@test")).toBe(expected);
	expect(plugins.some(plugin => plugin.scope === "project" && plugin.name === "payload")).toBe(expected);
}

test("a project registry cannot claim user scope to load unhashed ancestor LSP commands", async () => {
	const f = await fixture("user");
	await fs.writeFile(path.join(f.root, "marketplace.json"), JSON.stringify({
		plugins: [{
			name: "payload",
			lspServers: {
				"unapproved-ancestor": { command: process.execPath, args: ["unapproved"], fileTypes: ["fixture"], rootMarkers: ["."] },
			},
		}],
	}));
	await decide(f, "approve");
	const { roots } = await listClaudePluginRoots(f.home, f.repo, f.pluginsRoot, f.agentDir);
	expect(roots.filter(root => root.id === "payload@test").map(root => root.scope)).toEqual(["project"]);
	expect(loadConfig(f.repo, roots).servers["unapproved-ancestor"]).toBeUndefined();
});

async function filesUnder(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const target = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await filesUnder(target));
		else files.push(target);
	}
	return files.sort();
}

test("approval covers every file found under every named installPath, including same-size edits", async () => {
	const f = await fixture();
	await assertLoaded(f, false);
	await decide(f, "approve");
	await assertLoaded(f, true);
	// Enumerate registry sources and their files rather than maintain a coverage allowlist.
	const registry: { plugins: Record<string, Array<{ installPath: string }>> } = JSON.parse(await fs.readFile(f.registry, "utf8"));
	for (const entries of Object.values(registry.plugins)) {
		for (const entry of entries) {
			for (const file of await filesUnder(entry.installPath)) {
				const original = await fs.readFile(file);
				const changed = Buffer.from(original);
				changed[changed.length - 1] = changed[changed.length - 1] === 32 ? 10 : 32;
				await fs.writeFile(file, changed);
				try {
					expect((await decide(f, "list")).candidates.map(candidate => candidate.verdict)).toEqual(["changed"]);
					await assertLoaded(f, false);
				} finally {
					await fs.writeFile(file, original);
				}
				await assertLoaded(f, true);
			}
		}
	}
}, 30_000);

for (const mutation of ["add", "remove", "rename"] as const) {
	test(`payload ${mutation} invalidates an unchanged approved registry`, async () => {
		const f = await fixture();
		await decide(f, "approve");
		await assertLoaded(f, true);
		const target = path.join(f.installPath, "assets", "nested", "input.txt");
		if (mutation === "add") await fs.writeFile(path.join(f.installPath, "new-script.js"), "unapproved\n");
		if (mutation === "remove") await fs.unlink(target);
		if (mutation === "rename") await fs.rename(target, `${target}.renamed`);
		await assertLoaded(f, false);
		expect((await decide(f, "list")).candidates.map(candidate => candidate.verdict)).toEqual(["changed"]);
		await decide(f, "approve");
		await assertLoaded(f, true);
	});
}

test("legacy registry-only approvals cannot load unchanged plugin code", async () => {
	const f = await fixture();
	const root = await canonicalProjectRoot(f.repo);
	const legacy = await describeProjectExecutable(f.registry, root);
	if (!legacy) throw new Error("fixture registry must be readable");
	await (await ProjectTrust.load(f.agentDir)).trust(root, [legacy]);
	await assertLoaded(f, false);
	expect((await decide(f, "list")).candidates.map(candidate => candidate.verdict)).toEqual(["changed"]);
	await decide(f, "approve");
	await assertLoaded(f, true);
});

test("denial and a different session profile cannot reuse an approved warm payload", async () => {
	const f = await fixture();
	await decide(f, "approve");
	await assertLoaded(f, true);
	await assertLoaded(f, false, path.join(f.root, "other-profile", "agent"));
	await decide(f, "deny");
	await assertLoaded(f, false);
});

for (const destination of ["outside-project", "inside-project-outside-plugin"] as const) {
	test(`a child junction to ${destination} is not covered by plugin approval`, async () => {
		const f = await fixture();
		await decide(f, "approve");
		await assertLoaded(f, true);
		const external = path.join(destination === "outside-project" ? f.root : f.repo, "external");
		await fs.mkdir(external, { recursive: true });
		await fs.writeFile(path.join(external, "payload.js"), "unapproved code\n");
		await fs.symlink(external, path.join(f.installPath, "linked"), process.platform === "win32" ? "junction" : "dir");
		await assertLoaded(f, false);
		const approval = await decide(f, "approve");
		expect(approval.candidates).toEqual([]);
		await assertLoaded(f, false);
	});
}

test("an absolute installPath outside the approved project is refused", async () => {
	const f = await fixture();
	const outside = path.join(f.root, "outside");
	await fs.rename(f.installPath, outside);
	const registry = await fs.readFile(f.registry, "utf8");
	await fs.writeFile(f.registry, registry.replace(JSON.stringify(f.installPath), JSON.stringify(outside)));
	expect((await decide(f, "approve")).candidates).toEqual([]);
	await assertLoaded(f, false);
});

test("replacing an approved installPath with an escaping junction revokes both warm routes", async () => {
	const f = await fixture();
	await decide(f, "approve");
	await assertLoaded(f, true);
	const outside = path.join(f.root, "relocated");
	await fs.rename(f.installPath, outside);
	await fs.symlink(outside, f.installPath, process.platform === "win32" ? "junction" : "dir");
	await assertLoaded(f, false);
	expect((await decide(f, "approve")).candidates).toEqual([]);
});

test("a cyclic payload link refuses approval and terminates", async () => {
	const f = await fixture();
	await fs.symlink(f.installPath, path.join(f.installPath, "loop"), process.platform === "win32" ? "junction" : "dir");
	expect((await decide(f, "approve")).candidates).toEqual([]);
	await assertLoaded(f, false);
}, 5_000);

test("a payload over the scan depth bound refuses approval and terminates", async () => {
	const f = await fixture();
	const nested = path.join(f.installPath, ...Array.from({ length: 10 }, (_, index) => `level-${index}`));
	await fs.mkdir(nested, { recursive: true });
	await fs.writeFile(path.join(nested, "code.js"), "unapproved\n");
	expect((await decide(f, "approve")).candidates).toEqual([]);
	await assertLoaded(f, false);
}, 5_000);

test("an oversized payload file revokes approval rather than hashing a prefix", async () => {
	const f = await fixture();
	await decide(f, "approve");
	await assertLoaded(f, true);
	await fs.writeFile(path.join(f.installPath, "large.bin"), Buffer.alloc(1024 * 1024 + 1));
	expect((await decide(f, "approve")).candidates).toEqual([]);
	await assertLoaded(f, false);
}, 5_000);

test.skipIf(process.platform === "win32")("a relative installPath uses the registry's loader path, not its symlink target directory", async () => {
	const f = await fixture();
	const relativePath = path.relative(path.dirname(f.registry), f.installPath);
	const bytes = await fs.readFile(f.registry, "utf8");
	const stored = path.join(f.repo, "registry-store", "installed_plugins.json");
	await fs.mkdir(path.dirname(stored), { recursive: true });
	await fs.writeFile(stored, bytes.replace(JSON.stringify(f.installPath), JSON.stringify(relativePath)));
	await fs.unlink(f.registry);
	await fs.symlink(stored, f.registry, "file");
	await decide(f, "approve");
	await assertLoaded(f, true);
	await fs.writeFile(path.join(f.installPath, "extension.ts"), "export default () => ({ changed: true });\n");
	await assertLoaded(f, false);
});

test("approval covers disabled entries before they can be enabled", async () => {
	const f = await fixture();
	const disabled = path.join(f.repo, "disabled-payload");
	await fs.mkdir(disabled, { recursive: true });
	const code = path.join(disabled, "code.js");
	await fs.writeFile(code, "old code\n");
	const registry: { plugins: Record<string, Array<{ installPath: string; enabled?: boolean }>> } =
		JSON.parse(await fs.readFile(f.registry, "utf8"));
	registry.plugins["disabled@test"] = [{ installPath: disabled, enabled: false }];
	await fs.writeFile(f.registry, JSON.stringify(registry));
	await decide(f, "approve");
	await assertLoaded(f, true);
	await fs.writeFile(code, "new code\n");
	await assertLoaded(f, false);
	expect((await decide(f, "list")).candidates.map(candidate => candidate.verdict)).toEqual(["changed"]);
});
