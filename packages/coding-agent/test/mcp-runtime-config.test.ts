import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { resolveCliArgv } from "../src/cli-commands";
import {
	loadRuntimeMCPConfig,
	MAX_RUNTIME_MCP_CONFIG_BYTES,
	mergeRuntimeMCPConfig,
} from "../src/mcp/runtime-config";

test("run-only MCP files preserve native configuration and do not rewrite their source", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-runtime-mcp-"));
	const file = path.join(dir, "mcp.json");
	const original = JSON.stringify({
		mcpServers: {
			fleet: { type: "stdio", command: process.execPath, args: ["connector.ts"], env: { FLEET_HOST: "pc1" } },
			disabled: { type: "stdio", command: "unused", enabled: false },
		},
	});
	try {
		await fs.writeFile(file, original);
		const loaded = await loadRuntimeMCPConfig(file);
		expect(loaded.path).toBe(file);
		expect(Object.keys(loaded.configs)).toEqual(["fleet"]);
		expect(loaded.configs.fleet).toEqual(JSON.parse(original).mcpServers.fleet);
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(await fs.readdir(dir)).toEqual(["mcp.json"]);
		const existing = { other: { type: "stdio" as const, command: "existing" } };
		const merged = mergeRuntimeMCPConfig(existing, {}, loaded);
		expect(Object.keys(merged.configs)).toEqual(["other", "fleet"]);
		expect(Object.keys(existing)).toEqual(["other"]);
		expect(merged.sources.fleet.path).toBe(file);
		expect(() => mergeRuntimeMCPConfig({ fleet: existing.other }, {}, loaded)).toThrow("conflicts");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("invalid, ambiguous, missing and oversized explicit MCP input cannot silently become an empty list", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-runtime-mcp-invalid-"));
	const file = path.join(dir, "mcp.json");
	try {
		await expect(loadRuntimeMCPConfig("relative.json")).rejects.toThrow("absolute");
		await expect(loadRuntimeMCPConfig(file)).rejects.toThrow();
		for (const invalid of [
			"{not-json",
			"null",
			"{}",
			JSON.stringify({ mcpServers: { fleet: { type: "stdio", command: "valid", args: [42] } } }),
			JSON.stringify({ mcpServers: { fleet: { type: "stdio", command: "valid", url: "https://example.test" } } }),
			JSON.stringify({ mcpServers: {}, disabledServers: [] }),
			"x".repeat(MAX_RUNTIME_MCP_CONFIG_BYTES + 1),
		]) {
			await fs.writeFile(file, invalid);
			await expect(loadRuntimeMCPConfig(file)).rejects.toThrow();
		}
		await expect(loadRuntimeMCPConfig(dir)).rejects.toThrow();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("the MCP path is consumed as a flag value rather than an ACP command or model prompt", () => {
	expect(resolveCliArgv(["--mcp-config", "acp"])).toEqual({ argv: ["launch", "--mcp-config", "acp"] });
	const parsed = parseArgs(["--mcp-config=/tmp/mcp.json", "--mode", "acp"]);
	expect(parsed.mcpConfig).toBe("/tmp/mcp.json");
	expect(parsed.messages).toEqual([]);
	expect(parsed.unrecognizedFlags).toEqual([]);
	expect(() => parseArgs(["--mcp-config", "/tmp/a", "--mcp-config", "/tmp/b"])).toThrow("only once");
});
