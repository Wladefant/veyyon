import { expect, it } from "bun:test";
import type { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { MCPToolCache } from "@veyyon/coding-agent/mcp/tool-cache";
import type { MCPRequestOptions, MCPToolsListResult } from "../src/mcp/types";
import { createServer } from "node:http";
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
// connection snapshot. A late successful reply during OR after disconnect
// must not resurrect that server's tools. Only the transport's response-completion
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
		const disconnectEntered = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		const realClose = transport.close;
		transport.close = async () => {
			disconnectEntered.resolve();
			await releaseClose.promise;
			await realClose.call(transport);
		};
		try {
			const refresh = manager.refreshServerTools(name);
			await bounded(refreshEntered.promise, "delayed tools/list");
			const beforeDisconnect = observed.length;
			const disconnect = manager.disconnectServer(name);
			// During the real disconnect, delay only its external transport
			// close acknowledgement: the old connection remains in #connections.
			await bounded(disconnectEntered.promise, "disconnect entered transport close");
			lateReply.resolve({
				tools: [{ name: "late_tool", inputSchema: { type: "object", properties: {} } }],
			});
			await bounded(refresh, "late reply while disconnect is still pending");
			// A post-await connection-identity check alone is insufficient:
			// the same connection is still mapped until close settles.
			expect(manager.getTools().map(tool => tool.name)).toEqual(expected);
			expect(observed).toHaveLength(beforeDisconnect);
			releaseClose.resolve();
			await bounded(disconnect, "disconnect after late tool response");
			expect(manager.getTools()).toEqual([]);
			expect(observed).toHaveLength(beforeDisconnect + 1);
			expect(manager.getConnectedServers()).not.toContain(name);
		} finally {
			lateReply.resolve({ tools: [] });
			releaseClose.resolve();
			transport.close = realClose;
			transport.request = realRequest;
		}
	} finally {
		lateReply.resolve({ tools: [] });
		await bounded(manager.disconnectAll(), "manager cleanup");
	}
}, 30_000);


// WHY: two notifications may request tools/list concurrently for the same
// live transport. A delayed *older* reply must never overwrite the newest
// catalog in either the connection cache or the manager registry.
// The manager and stdio fixture are real; only this transport response seam
// is controlled. No installed ACP/T3 evidence is claimed.
it("serializes overlapping live-server tool refreshes and retains the newest catalog", async () => {
	const name = "sequenced-refresh";
	const manager = new MCPManager(process.cwd());
	const startupCatalog = Promise.withResolvers<void>();
	const changes: string[][] = [];
	manager.setOnToolsChanged(tools => {
		const names = tools.map(tool => tool.name);
		changes.push(names);
		if (names.filter(tool => tool.startsWith(`mcp__${name}_`)).length === MANY_TOOL_COUNT) {
			startupCatalog.resolve();
		}
	});
	const bounded = async <T>(work: Promise<T>, phase: string): Promise<T> => {
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new Error(`MCP ${phase} did not settle`)), 8_000);
		try {
			return await Promise.race([work, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	const firstRequestEntered = Promise.withResolvers<void>();
	const releaseFirstResponse = Promise.withResolvers<void>();
	let firstRefresh: Promise<void> | undefined;
	let secondRefresh: Promise<void> | undefined;
	let interceptedListRequests = 0;
	try {
		const fixture = { type: "stdio" as const, command: process.execPath, args: [FIXTURE_PATH] };
		await bounded(manager.connectServers({ [name]: fixture }, {}), "initial connection");
		await bounded(startupCatalog.promise, "initial 45-tool catalog");
		const connection = await bounded(manager.waitForConnection(name), "live fixture connection");
		const transport = connection.transport;
		const originalRequest = transport.request;
		transport.request = async <T = unknown>(
			method: string,
			params?: Record<string, unknown>,
			options?: MCPRequestOptions,
		): Promise<T> => {
			if (method === "tools/list") {
				interceptedListRequests++;
				if (interceptedListRequests === 1) {
					firstRequestEntered.resolve();
					await releaseFirstResponse.promise;
					return { tools: [{ name: "old_catalog", inputSchema: { type: "object", properties: {} } }] } as T;
				}
				if (interceptedListRequests === 2) {
					return { tools: [{ name: "new_catalog", inputSchema: { type: "object", properties: {} } }] } as T;
				}
				throw new Error("Unexpected extra tools/list request after coalescing");
			}
			return originalRequest.call(transport, method, params, options) as Promise<T>;
		};
		try {
			const beforeRefreshNotifications = changes.length;
			firstRefresh = manager.refreshServerTools(name);
			await bounded(firstRequestEntered.promise, "held first list response");
			secondRefresh = manager.refreshServerTools(name);
			// Old code starts request 2 immediately; a single-flight manager
			// must let request 1 finish before sending request 2.
			expect(interceptedListRequests).toBe(1);
			releaseFirstResponse.resolve();
			await bounded(Promise.all([firstRefresh, secondRefresh]), "coalesced second refresh");
			expect(interceptedListRequests).toBe(2);
			// A superseded first response must never reach a tool consumer.
			expect(changes).toHaveLength(beforeRefreshNotifications + 1);
			const latest = [createMCPToolName(name, "new_catalog")];
			expect(manager.getTools().filter(tool => tool.mcpServerName === name).map(tool => tool.name)).toEqual(latest);
			expect(connection.tools?.map(tool => tool.name)).toEqual(["new_catalog"]);
			expect(changes.at(-1)).toEqual(manager.getTools().map(tool => tool.name));
		} finally {
			releaseFirstResponse.resolve();
			await bounded(
				Promise.allSettled([firstRefresh, secondRefresh].filter((p): p is Promise<void> => !!p)),
				"refresh drain",
			);
			transport.request = originalRequest;
		}
	} finally {
		releaseFirstResponse.resolve();
		await bounded(manager.disconnectAll(), "fixture teardown");
	}
}, 30_000);


// WHY: a pending list can fail just as a newer tools-changed notification
// arrives. The queued notification must get a fresh request instead of
// inheriting the failed stale request and leaving an old catalog active.
// This exercises real manager/disposable stdio with an external response seam;
// it does not claim first-party network or installed T3 execution.
it("recovers a queued tool-change refresh after the first list fails", async () => {
	const name = "refresh-after-error";
	const manager = new MCPManager(process.cwd());
	const loaded = Promise.withResolvers<void>();
	const notices: string[][] = [];
	manager.setOnToolsChanged(tools => {
		const names = tools.map(tool => tool.name);
		notices.push(names);
		if (names.filter(toolName => toolName.startsWith(`mcp__${name}_`)).length === MANY_TOOL_COUNT) loaded.resolve();
	});
	const bounded = async <T>(work: Promise<T>, phase: string): Promise<T> => {
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(() => expired.reject(new Error(`MCP ${phase} did not settle`)), 8_000);
		try {
			return await Promise.race([work, expired.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	const firstEntered = Promise.withResolvers<void>();
	const releaseFailure = Promise.withResolvers<void>();
	try {
		const fixture = { type: "stdio" as const, command: process.execPath, args: [FIXTURE_PATH] };
		await bounded(manager.connectServers({ [name]: fixture }, {}), "initial connection");
		await bounded(loaded.promise, "complete initial catalog");
		const connection = await bounded(manager.waitForConnection(name), "connected fixture");
		const transport = connection.transport;
		const originalRequest = transport.request;
		let calls = 0;
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		transport.request = async <T = unknown>(
			method: string,
			params?: Record<string, unknown>,
			options?: MCPRequestOptions,
		): Promise<T> => {
			if (method === "tools/list") {
				if (++calls === 1) {
					firstEntered.resolve();
					await releaseFailure.promise;
					throw new Error("synthetic first list failure");
				}
				if (calls === 2) {
					return { tools: [{ name: "recovered", inputSchema: { type: "object", properties: {} } }] } as T;
				}
				throw new Error("Unexpected repeated tool-list attempt");
			}
			return originalRequest.call(transport, method, params, options) as Promise<T>;
		};
		try {
			first = manager.refreshServerTools(name);
			await bounded(firstEntered.promise, "first request");
			second = manager.refreshServerTools(name);
			expect(calls).toBe(1);
			expect(first).toBe(second);
			const before = notices.length;
			releaseFailure.resolve();
			await bounded(Promise.all([first, second]), "queued newer refresh after failure");
			expect(calls).toBe(2);
			expect(manager.getTools().map(tool => tool.name)).toEqual([createMCPToolName(name, "recovered")]);
			expect(connection.tools?.map(tool => tool.name)).toEqual(["recovered"]);
			expect(notices).toHaveLength(before + 1);
			expect(notices.at(-1)).toEqual(manager.getTools().map(tool => tool.name));
		} finally {
			releaseFailure.resolve();
			await bounded(Promise.allSettled([first, second].filter((p): p is Promise<void> => !!p)), "refresh settlement");
			transport.request = originalRequest;
		}
	} finally {
		releaseFailure.resolve();
		await bounded(manager.disconnectAll(), "fixture teardown");
	}
}, 30_000);


// WHY: initial discovery's tools/list can settle after a newer live refresh.
// A single connection/cache must never publish the superseded initial catalog.
// Real HTTP MCP handshake and MCPManager; only the newer list reply is faked.
async function exerciseInitialRefreshRace(initialRejects: boolean): Promise<void> {
	const name = "initial-refresh-order";
	const firstListEntered = Promise.withResolvers<void>();
	const releaseInitialList = Promise.withResolvers<void>();
	const persisted = new Map<string, string>();
	const cacheWrites: string[][] = [];
	const freshCacheWritten = Promise.withResolvers<void>();
	const storage = {
		getCache: (key: string) => persisted.get(key) ?? null,
		setCache: (key: string, raw: string, _expiresAtSec: number) => {
			persisted.set(key, raw);
			const parsed = JSON.parse(raw) as { tools: Array<{ name: string }> };
			const names = parsed.tools.map(tool => tool.name);
			cacheWrites.push(names);
			if (names.includes("fresh_notification")) freshCacheWritten.resolve();
		},
	} as unknown as AgentStorage;
	const manager = new MCPManager(process.cwd(), new MCPToolCache(storage));
	const observed: string[][] = [];
	manager.setOnToolsChanged(tools => observed.push(tools.map(tool => tool.name)));
	const bounded = async <T>(work: Promise<T>, phase: string): Promise<T> => {
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(() => expired.reject(new Error("MCP " + phase + " did not settle")), 8_000);
		try {
			return await Promise.race([work, expired.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	const server = createServer(async (request, response) => {
		try {
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const message = JSON.parse(body) as { method?: string; id?: string | number };
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: Record<string, unknown>;
			if (message.method === "initialize") {
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "initial-refresh-order-fixture", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				firstListEntered.resolve();
				await releaseInitialList.promise;
				if (initialRejects) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32000, message: "synthetic initial tool-list failure" },
						}),
					);
					return;
				}
				result = { tools: [{ name: "stale_initial", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": "initial-refresh-fixture" } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await bounded(listening.promise, "private fixture listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback fixture address");
	const config = { type: "http" as const, url: "http://127.0.0.1:" + address.port + "/mcp" };
	let connecting: ReturnType<MCPManager["connectServers"]> | undefined;
	let refreshing: Promise<void> | undefined;
	let restoreRequest: (() => void) | undefined;
	let refreshRequests = 0;
	const connectedStatuses: string[] = [];
	try {
		connecting = manager.connectServers({ [name]: config }, {}, event => {
			if (event.type === "connected") connectedStatuses.push(event.serverName);
		});
		await bounded(firstListEntered.promise, "first initial tools/list request");
		const connection = await bounded(manager.waitForConnection(name), "initialized HTTP connection");
		const transport = connection.transport;
		const originalRequest = transport.request;
		transport.request = async <T = unknown>(
			method: string,
			params?: Record<string, unknown>,
			options?: MCPRequestOptions,
		): Promise<T> => {
			if (method === "tools/list") {
				refreshRequests++;
				return { tools: [{ name: "fresh_notification", inputSchema: { type: "object", properties: {} } }] } as T;
			}
			return originalRequest.call(transport, method, params, options) as Promise<T>;
		};
		restoreRequest = () => {
			transport.request = originalRequest;
		};
		refreshing = manager.refreshServerTools(name);
		// Old code starts request 2 before the initial request settles.
		expect(refreshRequests).toBe(0);
		releaseInitialList.resolve();
		const [startup] = await bounded(Promise.all([connecting, refreshing]), "startup and queued refresh");
		expect(startup.connectedServers).toContain(name);
		expect(connectedStatuses).toContain(name);
		expect(refreshRequests).toBe(1);
		await bounded(freshCacheWritten.promise, "latest persistent tool cache");
		expect(cacheWrites).toEqual([["fresh_notification"]]);
		const newest = [createMCPToolName(name, "fresh_notification")];
		const obsolete = createMCPToolName(name, "stale_initial");
		expect(manager.getTools().map(tool => tool.name)).toEqual(newest);
		expect(connection.tools?.map(tool => tool.name)).toEqual(["fresh_notification"]);
		expect(observed).not.toEqual([]);
		expect(observed.every(names => !names.includes(obsolete))).toBe(true);
		expect(observed.at(-1)).toEqual(newest);
	} finally {
		releaseInitialList.resolve();
		try {
			if (connecting) await bounded(connecting, "startup cleanup");
			if (refreshing) await bounded(refreshing, "refresh cleanup");
		} finally {
			restoreRequest?.();
			try {
				await bounded(manager.disconnectAll(), "manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await bounded(stopped.promise, "private fixture close");
			}
		}
	}
}

it("a newer refresh supersedes a successful pending initial tool discovery", () => exerciseInitialRefreshRace(false), 30_000);
it("a queued refresh recovers initial list failure and reports healthy startup", () => exerciseInitialRefreshRace(true), 30_000);
