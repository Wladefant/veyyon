/**
 * injectPluginDirRoots reads each --plugin-dir target's
 * `.claude-plugin/plugin.json` to name the synthetic plugin root, falling back
 * to the directory basename when the manifest is absent. A --plugin-dir path is
 * something the user asked for explicitly, so a manifest that EXISTS but cannot
 * be parsed must not be swallowed into a silent basename fallback (Law 10): a
 * missing manifest is expected and stays silent, a malformed one warns.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsDir, logger } from "@veyyon/utils";
import {
	clearClaudePluginRootsCache,
	clearPluginRootsAndCaches,
	getPreloadedPluginRoots,
	injectPluginDirRoots,
	preloadPluginRoots,
} from "../../src/discovery/helpers";
import * as discoveryFs from "../../src/discovery/capability/fs";
import { collectConfigSources, loadConfig } from "../../src/lsp/config";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

// Nothing deleted these: the prefix varies per case, so this file named a directory
// after each one and left every one of them in `/tmp`. `useTrackedTempDirFactory` is
// the prefix-per-call form of the same tracking the rest of the tree uses.
const makeTempDir = useTrackedTempDirFactory();

async function inject(dir: string): Promise<string> {
	// cwd points at an empty tempdir so no ambient project registry contributes roots.
	const cwd = makeTempDir("veyyon-plugin-dir-cwd-");
	await injectPluginDirRoots(cwd, [dir], cwd);
	return cwd;
}

function injectedRootFor(dir: string, cwd: string): { plugin: string } | undefined {
	const resolved = path.resolve(dir);
	return getPreloadedPluginRoots(cwd).find(root => root.path === resolved);
}

afterEach(() => {
	clearPluginRootsAndCaches();
	vi.restoreAllMocks();
});

describe("injectPluginDirRoots manifest name (Law 10)", () => {
	it("uses the manifest name when plugin.json is well-formed, without warning", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-ok-");
		fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-tools" }));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const cwd = await inject(dir);

		expect(injectedRootFor(dir, cwd)?.plugin).toBe("acme-tools");
		const manifestWarned = warnSpy.mock.calls.some(([message]) =>
			String(message).includes("Plugin manifest exists but could not be read"),
		);
		expect(manifestWarned).toBe(false);
	});

	it("falls back to the directory basename silently when no manifest exists", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-none-");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const cwd = await inject(dir);

		expect(injectedRootFor(dir, cwd)?.plugin).toBe(path.basename(dir));
		const manifestWarned = warnSpy.mock.calls.some(([message]) =>
			String(message).includes("Plugin manifest exists but could not be read"),
		);
		expect(manifestWarned).toBe(false);
	});

	it("warns and falls back to the basename when the manifest is malformed", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-bad-");
		fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
		const manifestPath = path.join(dir, ".claude-plugin", "plugin.json");
		fs.writeFileSync(manifestPath, '{ "name": broken ');
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const cwd = await inject(dir);

		expect(injectedRootFor(dir, cwd)?.plugin).toBe(path.basename(dir));
		const warned = warnSpy.mock.calls.some(([message, context]) => {
			const ctx = context as Record<string, unknown> | undefined;
			return (
				String(message).includes("Plugin manifest exists but could not be read") &&
				typeof ctx?.path === "string" &&
				ctx.path === manifestPath
			);
		});
		expect(warned).toBe(true);
	});

	it("keeps preloaded plugin config sources separate for two destination directories", async () => {
		const cwdA = makeTempDir("plugin-scope-a-");
		const cwdB = makeTempDir("plugin-scope-b-");
		const homeA = makeTempDir("plugin-home-a-");
		const homeB = makeTempDir("plugin-home-b-");
		const rootA = path.join(homeA, "plugin-a");
		const rootB = path.join(homeB, "plugin-b");
		for (const [home, root, name] of [[homeA, rootA, "a"], [homeB, rootB, "b"]]) {
			fs.mkdirSync(root, { recursive: true });
			const pluginsDir = getPluginsDir(home);
			fs.mkdirSync(pluginsDir, { recursive: true });
			fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({
				version: 2,
				plugins: { [`${name}@scope-test`]: [{ scope: "user", installPath: root, version: "1.0.0" }] },
			}));
		}
		await Promise.all([preloadPluginRoots(homeA, cwdA), preloadPluginRoots(homeB, cwdB)]);
		const sourcesFor = (cwd: string) => collectConfigSources({
			baseName: "lsp",
			cwd,
			fileSource: filePath => ({ read: () => filePath }),
		}).map(source => source.read());
		expect(sourcesFor(cwdA)).toContain(path.join(rootA, "lsp.json"));
		expect(sourcesFor(cwdA)).not.toContain(path.join(rootB, "lsp.json"));
		expect(sourcesFor(cwdB)).toContain(path.join(rootB, "lsp.json"));
		expect(sourcesFor(cwdB)).not.toContain(path.join(rootA, "lsp.json"));
	});

	it("awaits current plugin roots when another scope invalidates a blocked preload", async () => {
		const cwdA = makeTempDir("plugin-invalidated-a-");
		const cwdB = makeTempDir("plugin-invalidated-b-");
		const homeA = makeTempDir("plugin-invalidated-home-");
		const homeB = makeTempDir("plugin-warmed-home-");
		const rootA = path.join(homeA, "plugin-a");
		const rootB = path.join(homeB, "plugin-b");
		const registryPath = path.join(getPluginsDir(homeA), "installed_plugins.json");
		for (const [home, root, name] of [[homeA, rootA, "a"], [homeB, rootB, "b"]]) {
			fs.mkdirSync(root, { recursive: true });
			const pluginsDir = getPluginsDir(home);
			fs.mkdirSync(pluginsDir, { recursive: true });
			fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({
				version: 2,
				plugins: { [`${name}@scope-test`]: [{ scope: "user", installPath: root, version: "1.0.0" }] },
			}));
		}
		fs.writeFileSync(path.join(rootA, "lsp.json"), JSON.stringify({
			servers: { "scope-a": { command: process.execPath, fileTypes: ["scope-a"], rootMarkers: ["."] } },
		}));
		await preloadPluginRoots(homeB, cwdB);
		const firstEntered = Promise.withResolvers<void>();
		const replacementEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const readFile = discoveryFs.readFile;
		let reads = 0;
		vi.spyOn(discoveryFs, "readFile").mockImplementation(async filePath => {
			if (filePath === registryPath) {
				reads++;
				if (reads === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				} else if (reads === 2) {
					replacementEntered.resolve();
					await releaseReplacement.promise;
				}
			}
			return readFile(filePath);
		});
		const preloadA = preloadPluginRoots(homeA, cwdA);
		try {
			await firstEntered.promise;
			clearClaudePluginRootsCache();
			await replacementEntered.promise;
			expect(getPreloadedPluginRoots(cwdB).some(root => root.path === rootB)).toBe(true);
			releaseFirst.resolve();
			await preloadA;
			// A must be usable even while its background replacement remains blocked.
			expect(getPreloadedPluginRoots(cwdA).some(root => root.path === rootA)).toBe(true);
			expect(loadConfig(cwdA).servers["scope-a"]?.command).toBe(process.execPath);
		} finally {
			releaseFirst.resolve();
			releaseReplacement.resolve();
			await preloadA;
		}
	});
});
