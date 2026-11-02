import { expect, it } from "bun:test";
import type { MCPRequestOptions, MCPToolsListResult } from "../src/mcp/types";
import * as path from "node:path";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import { createMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

// WHY: a disconnected server's tools can vanish from MCPManager while a tool
// consumer never receives the changed registry when the configured server name
// needs sanitization. Exercise actual disposable stdio tool discovery/removal,
// not a copied prefix check or a spy-call assertion. This does not prove that
// a running T3/ACP client refreshed its installed tool list.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

it("a sanitized MCP server disconnect updates consumers without removing sibling tools", async () => {
	const serverName = "mcp-server-1";
	const siblingName = "ordinary";
	// Require the entire advertised fixture catalog before treating discovery
	// as complete: placeholder/connecting tool names can share these prefixes.
	const expectedServerTools = Array.from({ length: MANY_TOOL_COUNT }, (_, i) =>
		createMCPToolName(serverName, manyToolName(i)),
	);
	const expectedSiblingTools = Array.from({ length: MANY_TOOL_COUNT }, (_, i) =>
		createMCPToolName(siblingName, manyToolName(i)),
	);
	const manager = new MCPManager(process.cwd());
	const observedRegistries: string[][] = [];
	const bothLoaded = Promise.withResolvers<void>();
	manager.setOnToolsChanged(tools => {
		const names = tools.map(tool => tool.name);
		observedRegistries.push(names);
		if (expectedServerTools.every(name => names.includes(name)) && expectedSiblingTools.every(name => names.includes(name))) {
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
		expect(initial).toEqual([...expectedServerTools, ...expectedSiblingTools].sort());

		const priorNotifications = observedRegistries.length;
		await manager.disconnectServer(serverName);
		const afterSanitizedDisconnect = manager.getTools().map(tool => tool.name);
		expect(afterSanitizedDisconnect).toEqual([...expectedSiblingTools].sort());
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


// WHY: normalized MCP server names are not a prefix-free namespace.
// "alpha" and "alpha_beta" have overlapping tool-name prefixes, so a
// server-name prefix filter removes a healthy sibling during refresh or
// disconnect. The real server identity on each MCPTool is unambiguous.
// Gap: identical minted *full* tool names from distinct servers require
// separate conflict handling and are not established by this fixture.
it("overlapping MCP server name prefixes keep sibling tools on refresh and disconnect", async () => {
	const ownerName = "alpha";
	const siblingName = "alpha_beta";
	const ownerTools = Array.from({ length: MANY_TOOL_COUNT }, (_, i) =>
		createMCPToolName(ownerName, manyToolName(i)),
	);
	const siblingTools = Array.from({ length: MANY_TOOL_COUNT }, (_, i) =>
		createMCPToolName(siblingName, manyToolName(i)),
	);
	const allTools = [...ownerTools, ...siblingTools].sort();
	const manager = new MCPManager(process.cwd());
	const notified: string[][] = [];
	const initialToolLoads = Promise.withResolvers<void>();
	let initialNotifications = 0;
	manager.setOnToolsChanged(tools => {
		notified.push(tools.map(tool => tool.name));
		if (++initialNotifications === 2) initialToolLoads.resolve();
	});
	try {
		const fixtureConfig = { type: "stdio" as const, command: process.execPath, args: [FIXTURE_PATH] };
		await manager.connectServers({ [ownerName]: fixtureConfig, [siblingName]: fixtureConfig }, {});
		const startupDeadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => startupDeadline.reject(new Error("Both real MCP server tool loads did not finish")), 15_000);
		try {
			await Promise.race([initialToolLoads.promise, startupDeadline.promise]);
		} finally {
			clearTimeout(timer);
		}
		await Promise.all([manager.waitForConnection(ownerName), manager.waitForConnection(siblingName)]);
		// Restore the sibling's exact 45 tools after both initial loads: in the
		// unfixed code, which connection finishes last can itself delete them.
		// This makes the old-code negative fail on the ownership assertion below,
		// not on nondeterministic connection ordering or a placeholder tool.
		await manager.refreshServerTools(siblingName);
		expect(manager.getTools().map(tool => tool.name)).toEqual(allTools);

		await manager.refreshServerTools(ownerName);
		// The old mcp__alpha_ filter also matches every mcp__alpha_beta_ tool.
		expect(manager.getTools().map(tool => tool.name)).toEqual(allTools);
		expect(notified.at(-1)).toEqual(allTools);

		const beforeDisconnect = notified.length;
		await manager.disconnectServer(ownerName);
		expect(manager.getTools().map(tool => tool.name)).toEqual(siblingTools);
		expect(notified).toHaveLength(beforeDisconnect + 1);
		expect(notified.at(-1)).toEqual(siblingTools);

		await manager.disconnectServer(ownerName);
		expect(notified).toHaveLength(beforeDisconnect + 1);
		await manager.disconnectServer(siblingName);
		expect(manager.getTools()).toEqual([]);
		expect(notified.at(-1)).toEqual([]);
	} finally {
		await manager.disconnectAll();
	}
}, 35_000);


// WHY: refreshServerTools awaits the external tools/list reply after taking a
// connection snapshot. A late successful reply after disconnect must not
// resurrect that server's tools. Only the transport's response-completion
// boundary is delayed; real manager/stdio connection/cleanup paths are used.
// This synthetic fixture is not evidence of a live T3 transport doing this.
it("does not republish tools from a refresh completed after server disconnect", async () => {
	const name = "late-refresh-owner";
	const loaded = Promise.withResolvers<void>();
	const refreshEntered = Promise.withResolvers<void>();
	const lateReply = Promise.withResolvers<MCPToolsListResult>();
	const observed: string[][] = [];
	const expected = Array.from({ length: MANY_TOOL_COUNT }, (_, i) => createMCPToolName(name, manyToolName(i)));
	const manager = new MCPManager(process.cwd());
	manager.setOnToolsChanged(tools => {
		const names = tools.map(tool => tool.name);
		observed.push(names);
		if (expected.every(toolName => names.includes(toolName))) loaded.resolve();
	});
	const bounded = async <T>(work: Promise<T>, phase: string): Promise<T> => {
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => deadline.reject(new Error(`MCP ${phase} did not settle`)), 8_000);
		try {
			return await Promise.race([work, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		const fixture = { type: "stdio" as const, command: process.execPath, args: [FIXTURE_PATH] };
		await bounded(manager.connectServers({ [name]: fixture }, {}), "initial connection");
		await bounded(loaded.promise, "initial registry load");
		const connection = await bounded(manager.waitForConnection(name), "active stdio connection");
		const transport = connection.transport;
		const realRequest = transport.request;
		transport.request = async <T = unknown>(
			method: string,
			params?: Record<string, unknown>,
			options?: MCPRequestOptions,
		): Promise<T> => {
			if (method === "tools/list") {
				refreshEntered.resolve();
				return (await lateReply.promise) as T;
			}
			return realRequest.call(transport, method, params, options) as Promise<T>;
		};
		try {
			const refresh = manager.refreshServerTools(name);
			await bounded(refreshEntered.promise, "delayed tools/list");
			await bounded(manager.disconnectServer(name), "disconnect before delayed reply");
			expect(manager.getTools()).toEqual([]);
			const notificationsAfterDisconnect = observed.length;
			lateReply.resolve({
				tools: [{ name: "late_tool", inputSchema: { type: "object", properties: {} } }],
			});
			await bounded(refresh, "late response");
			expect(manager.getTools()).toEqual([]);
			expect(observed).toHaveLength(notificationsAfterDisconnect);
			expect(manager.getConnectedServers()).not.toContain(name);
		} finally {
			lateReply.resolve({ tools: [] });
			transport.request = realRequest;
		}
	} finally {
		lateReply.resolve({ tools: [] });
		await bounded(manager.disconnectAll(), "manager cleanup");
	}
}, 30_000);
