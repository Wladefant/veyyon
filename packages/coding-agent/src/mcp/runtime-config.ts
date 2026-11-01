import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@veyyon/ai/utils/schema/json-schema-validator";
import mcpSchema from "../config/mcp-schema.json" with { type: "json" };
import type { SourceMeta } from "../discovery/capability/types";
import type { MCPConfigFile, MCPServerConfig } from "./types";
import { validateServerConfig } from "./validate";

export interface RuntimeMCPConfig {
	readonly path: string;
	readonly configs: Readonly<Record<string, MCPServerConfig>>;
}

export const MAX_RUNTIME_MCP_CONFIG_BYTES = 1_048_576;

/** Read only the operator-supplied file; no profile discovery or persistence. */
export async function loadRuntimeMCPConfig(file: string): Promise<RuntimeMCPConfig> {
	if (!path.isAbsolute(file)) throw new Error("--mcp-config requires an absolute path");
	// A FIFO can block inside open before the descriptor check can reject it.
	// Keep that check on the same handle, and leave Windows open flags unchanged.
	const flags = process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
	const handle = await fs.open(file, flags);
	let content: string;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_RUNTIME_MCP_CONFIG_BYTES) {
			throw new Error("--mcp-config must be a regular JSON file no larger than 1 MiB");
		}
		const buffer = Buffer.alloc(MAX_RUNTIME_MCP_CONFIG_BYTES + 1);
		let used = 0;
		while (used < buffer.length) {
			const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		if (used > MAX_RUNTIME_MCP_CONFIG_BYTES) throw new Error("--mcp-config exceeds 1 MiB");
		content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
	} finally {
		await handle.close();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("--mcp-config is not valid JSON");
	}
	const validation = validateJsonSchemaValue(mcpSchema, parsed);
	if (!validation.success) {
		const fields = validation.issues.slice(0, 8).map(issue => issue.path.join(".") || "root");
		throw new Error(`--mcp-config does not match the MCP schema (${fields.join(", ")})`);
	}
	const config = parsed as MCPConfigFile;
	if (!config.mcpServers || config.disabledServers !== undefined || config.enabledServers !== undefined) {
		throw new Error("--mcp-config requires mcpServers and does not accept profile enable/disable lists");
	}
	const configs: Record<string, MCPServerConfig> = Object.create(null);
	for (const [name, server] of Object.entries(config.mcpServers)) {
		if (name === "__proto__" || name === "constructor" || name === "prototype") {
			throw new Error("--mcp-config contains a reserved server name");
		}
		const errors = validateServerConfig(name, server);
		if (errors.length > 0) throw new Error(`--mcp-config: ${errors.join("; ")}`);
		if (server.enabled !== false) configs[name] = server;
	}
	return { path: file, configs };
}

/** Merge explicit servers without letting either source silently replace the other. */
export function mergeRuntimeMCPConfig(
	configs: Readonly<Record<string, MCPServerConfig>>,
	sources: Readonly<Record<string, SourceMeta>>,
	runtime: RuntimeMCPConfig | undefined,
): { configs: Record<string, MCPServerConfig>; sources: Record<string, SourceMeta> } {
	const mergedConfigs = { ...configs };
	const mergedSources = { ...sources };
	if (!runtime) return { configs: mergedConfigs, sources: mergedSources };
	for (const [name, server] of Object.entries(runtime.configs)) {
		if (Object.hasOwn(mergedConfigs, name)) {
			throw new Error(`MCP server "${name}" conflicts with --mcp-config; use distinct names`);
		}
		mergedConfigs[name] = server;
		mergedSources[name] = {
			provider: "runtime",
			providerName: "Run-only MCP configuration",
			path: runtime.path,
			level: "user",
		};
	}
	return { configs: mergedConfigs, sources: mergedSources };
}
