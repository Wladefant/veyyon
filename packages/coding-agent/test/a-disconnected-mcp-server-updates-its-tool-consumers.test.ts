import { expect, it } from "bun:test";
import * as path from "node:path";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import { mcpToolNamePrefix } from "@veyyon/coding-agent/mcp/tool-bridge";

// WHY: a disconnected server's tools can vanish from MCPManager while a tool
// consumer never receives the changed registry when the configured server name
// needs sanitization. Exercise actual disposable stdio tool discovery/removal,
// not a copied prefix check or a spy-call assertion. This does not prove that
// a running T3/ACP client refreshed its installed tool list.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

it("a sanitized MCP server disconnect updates consumers without removing sibling tools", async () => {
	const serverName = "mcp-server-1";
	const siblingName = "ordinary";
	const serverPrefix = mcpToolNamePrefix(serverName);
	const siblingPrefix = mcpToolNamePrefix(siblingName);
	const manager = new MCPManager(process.cwd());
	const observedRegistries: string[][] = [];
	const bothLoaded = Promise.withResolvers<void>();
	manager.setOnToolsChanged(tools => {
		const names = tools.map(tool => tool.name);
		observedRegistries.push(names);
		if (names.some(name => name.startsWith(serverPrefix)) && names.some(name => name.startsWith(siblingPrefix))) {
			bothLoaded.resolve();
		}
	});

	try {
		const fixtureConfig = { type: "stdio" as const, command: process.execPath, args: [FIXTURE_PATH] };
		await manager.connectServers({ [serverName]: fixtureConfig, [siblingName]: fixtureConfig }, {});
		// Startup discovery is asynchronous; do not interpret a startup banner
		// or connection handshake as proof both tool sets reached the registry.
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error("Both real MCP fixture tool lists did not load")),
			15_000,
		);
		try {
			await Promise.race([bothLoaded.promise, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
		const initial = manager.getTools().map(tool => tool.name);
		expect(initial.some(name => name.startsWith(serverPrefix))).toBe(true);
		expect(initial.some(name => name.startsWith(siblingPrefix))).toBe(true);

		const priorNotifications = observedRegistries.length;
		await manager.disconnectServer(serverName);
		const afterSanitizedDisconnect = manager.getTools().map(tool => tool.name);
		expect(afterSanitizedDisconnect.some(name => name.startsWith(serverPrefix))).toBe(false);
		expect(afterSanitizedDisconnect.some(name => name.startsWith(siblingPrefix))).toBe(true);
		// Old source removes the sanitized tools but does not notify, because its
		// hadTools predicate checks a raw prefix with an embedded hyphen.
		expect(observedRegistries).toHaveLength(priorNotifications + 1);
		expect(observedRegistries.at(-1)).toEqual(afterSanitizedDisconnect);

		await manager.disconnectServer(serverName);
		expect(observedRegistries).toHaveLength(priorNotifications + 1);
		await manager.disconnectServer(siblingName);
		expect(manager.getTools()).toEqual([]);
		expect(observedRegistries).toHaveLength(priorNotifications + 2);
		expect(observedRegistries.at(-1)).toEqual([]);
	} finally {
		await manager.disconnectAll();
	}
}, 30_000);
