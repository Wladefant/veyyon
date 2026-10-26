/**
 * Project approval covers the plugin payload, not its ancestor marketplace catalog.
 * Exercise both catalog layouts and declaration forms through loadConfig. User catalogs
 * and project payload configs remain usable. This suite does not launch an LSP process.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudePluginRoot } from "@veyyon/coding-agent/discovery/helpers";
import { loadConfig } from "@veyyon/coding-agent/lsp/config";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(scope: "project" | "user", catalogName: string, declaration: "map" | "path") {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-catalog-trust-"));
	scratch.push(cwd);
	const pluginPath = path.join(cwd, "cache", "plugins", "fixture");
	fs.mkdirSync(pluginPath, { recursive: true });
	const servers = {
		"catalog-trust-fixture": {
			command: process.execPath,
			args: ["ancestor-command"],
			fileTypes: ["fixture"],
			rootMarkers: ["."],
		},
	};
	fs.writeFileSync(path.join(pluginPath, "catalog-lsp.json"), JSON.stringify({ servers }));
	const catalogPath = path.join(cwd, "cache", catalogName);
	fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
	fs.writeFileSync(catalogPath, JSON.stringify({
		plugins: [{ name: "fixture", lspServers: declaration === "map" ? servers : "catalog-lsp.json" }],
	}));
	const root: ClaudePluginRoot = {
		id: "fixture@catalog", marketplace: "catalog", plugin: "fixture", version: "1", path: pluginPath, scope,
	};
	return { cwd, root, servers };
}

describe("marketplace commands stay inside project approval", () => {
	for (const catalog of ["marketplace.json", path.join(".claude-plugin", "marketplace.json")]) {
		for (const declaration of ["map", "path"] as const) {
			it(`ignores project ${declaration} declarations in ${catalog}`, () => {
				const { cwd, root } = fixture("project", catalog, declaration);
				expect(loadConfig(cwd, [root]).servers["catalog-trust-fixture"]).toBeUndefined();
			});
			it(`keeps user ${declaration} declarations in ${catalog}`, () => {
				const { cwd, root } = fixture("user", catalog, declaration);
				expect(loadConfig(cwd, [root]).servers["catalog-trust-fixture"]?.args).toEqual(["ancestor-command"]);
			});
		}
	}
	it("loads the project plugin's payload config without the ancestor catalog", () => {
		const { cwd, root, servers } = fixture("project", "marketplace.json", "map");
		servers["catalog-trust-fixture"].args = ["approved-payload-command"];
		fs.writeFileSync(path.join(root.path, "lsp.json"), JSON.stringify({ servers }));
		expect(loadConfig(cwd, [root]).servers["catalog-trust-fixture"]?.args).toEqual(["approved-payload-command"]);
	});
});
