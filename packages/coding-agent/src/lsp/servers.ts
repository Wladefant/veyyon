/**
 * Language-server configuration per working directory, and the server selection the `lsp` tool, the
 * diagnostics fetch and the writethrough share.
 */
import { setIdleTimeout } from "./client";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import type { ServerConfig } from "./types";

// Cache config per cwd to avoid repeated file I/O
const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

export function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

export function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

export function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

/** Drop the cached configuration for `cwd`, so the next read loads it from disk. */
export function forgetConfig(cwd: string): void {
	configCache.delete(cwd);
}
