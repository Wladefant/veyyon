import { expect, it } from "bun:test";
import { createServer } from "node:http";
import { MCPManager } from "../src/mcp/manager";
import { createMCPToolName } from "../src/mcp/tool-bridge";
import type { MCPToolCache } from "../src/mcp/tool-cache";

// WHY: the server's first initialize response may arrive after the operator
// explicitly disconnects it. The stale connection must not resurrect config,
// publish tools, or become an untracked live transport. This uses a real
// MCPManager and private node:http protocol endpoint, not a copied manager.
//
// Gap: the synthetic connection does not verify installed T3/Windows runtime.
async function withinConnectBoundary<T>(work: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`MCP ${phase} did not settle`)), 8_000);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it("a cancelled initial MCP handshake cannot revive its server after explicit disconnect", async () => {
	const name = "initially-cancelled-server";
	const initializeEntered = Promise.withResolvers<void>();
	const releaseFirstInitialize = Promise.withResolvers<void>();
	const firstTerminated = Promise.withResolvers<void>();
	let initializeCalls = 0;
	let publishedToolLists = 0;
	let closeRequests = 0;
	const server = createServer(async (request, response) => {
		try {
			if (request.method === "DELETE") {
				closeRequests++;
				if (request.headers["mcp-session-id"] === "test-custody-session-1") firstTerminated.resolve();
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
				initializeCalls++;
				if (initializeCalls === 1) {
					initializeEntered.resolve();
					await releaseFirstInitialize.promise;
				}
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "initial-connect-custody", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				publishedToolLists++;
				result = { tools: [{ name: "read_fixture", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": `test-custody-session-${initializeCalls}` } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await withinConnectBoundary(listening.promise, "private server listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
	const config = { type: "http" as const, url: `http://127.0.0.1:${address.port}/mcp` };
	const manager = new MCPManager(process.cwd());
	const notifications: string[][] = [];
	manager.setOnToolsChanged(tools => notifications.push(tools.map(tool => tool.name)));
	let initial: Promise<unknown> | undefined;
	try {
		initial = manager.connectServers({ [name]: config }, {});
		await withinConnectBoundary(initializeEntered.promise, "first initialize request");
		await withinConnectBoundary(manager.disconnectServer(name), "explicit disconnect before initialization");
		expect(manager.getServerConfig(name)).toBeUndefined();
		expect(manager.getConnectedServers()).not.toContain(name);
		releaseFirstInitialize.resolve();
		await withinConnectBoundary(initial, "obsolete initial connect result");
		await withinConnectBoundary(firstTerminated.promise, "obsolete initialized session transport close");
		expect(closeRequests).toBe(1);
		expect(manager.getServerConfig(name)).toBeUndefined();
		expect(manager.getConnectedServers()).not.toContain(name);
		expect(manager.getTools().filter(tool => tool.mcpServerName === name)).toEqual([]);
		expect(notifications).toEqual([]);

		// A newly authorized connection of the same NAME has new ownership.
		await withinConnectBoundary(manager.connectServers({ [name]: config }, {}), "explicit second connection");
		expect(initializeCalls).toBe(2);
		expect(manager.getConnectedServers()).toContain(name);
		const tools = manager.getTools().filter(tool => tool.mcpServerName === name);
		expect(tools.map(tool => tool.name)).toEqual([createMCPToolName(name, "read_fixture")]);
		expect(notifications.at(-1)).toEqual(manager.getTools().map(tool => tool.name));
		expect(publishedToolLists).toBeGreaterThanOrEqual(1);
	} finally {
		releaseFirstInitialize.resolve();
		try {
			if (initial) await withinConnectBoundary(initial, "initial connection teardown");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "manager teardown");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "private server shutdown");
			}
		}
	}
}, 30_000);


// WHY: bulk shutdown closes a snapshot of connected servers, while another
// server's initial initialize response may arrive after that snapshot. The
// pending promise must be fenced by the same global teardown epoch that
// already fences reconnects, or it can publish an untracked transport.
it("bulk MCP disconnect retires a pending initialize before closing its connected peer", async () => {
	const aToolsListed = Promise.withResolvers<void>();
	const bInitializeEntered = Promise.withResolvers<void>();
	const releaseBInitialize = Promise.withResolvers<void>();
	const aDeleteEntered = Promise.withResolvers<void>();
	const releaseADelete = Promise.withResolvers<void>();
	const bDeleteObserved = Promise.withResolvers<void>();
	let aInitializations = 0;
	let bInitializations = 0;
	let cInitializations = 0;
	const server = createServer(async (request, response) => {
		try {
			const route = request.url === "/a" ? "a" : request.url === "/b" ? "b" : request.url === "/c" ? "c" : undefined;
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			if (request.method === "DELETE") {
				if (route === "a") {
					aDeleteEntered.resolve();
					await releaseADelete.promise;
				} else if (request.headers["mcp-session-id"] === "test-bulk-b") {
					bDeleteObserved.resolve();
				}
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
				if (route === "a") aInitializations++;
				if (route === "c") cInitializations++;
				if (route === "b" && ++bInitializations === 1) {
					bInitializeEntered.resolve();
					await releaseBInitialize.promise;
				}
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "bulk-shutdown-fixture", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				if (route === "a") aToolsListed.resolve();
				result = { tools: [{ name: "read_fixture", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": `test-bulk-${route}` } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await withinConnectBoundary(listening.promise, "bulk test HTTP listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback fixture address");
	const names = { a: "bulk-peer-a", b: "bulk-peer-b", c: "bulk-peer-c" };
	const configs = {
		[names.a]: { type: "http" as const, url: `http://127.0.0.1:${address.port}/a` },
		[names.b]: { type: "http" as const, url: `http://127.0.0.1:${address.port}/b` },
		[names.c]: { type: "http" as const, url: `http://127.0.0.1:${address.port}/c` },
	};
	const manager = new MCPManager(process.cwd());
	const notifications: string[][] = [];
	manager.setOnToolsChanged(tools => notifications.push(tools.map(tool => tool.name)));
	let originalConnect: Promise<unknown> | undefined;
	let bulkShutdown: Promise<void> | undefined;
	try {
		originalConnect = manager.connectServers(configs, {});
		// The other server A must already be registered before disconnectAll
		// snapshots connected transports; B is held inside initialize.
		await withinConnectBoundary(
			Promise.all([aToolsListed.promise, bInitializeEntered.promise]),
			"bulk fixture A tools and B initialize",
		);
		expect(manager.getConnectedServers()).toContain(names.a);
		expect(manager.getConnectedServers()).not.toContain(names.b);
		bulkShutdown = manager.disconnectAll();
		await withinConnectBoundary(aDeleteEntered.promise, "bulk shutdown closing connected A");
		// B finishes while A's DELETE is still blocked. On the original code,
		// B is admitted after the snapshot and never receives its own DELETE.
		releaseBInitialize.resolve();
		await withinConnectBoundary(bDeleteObserved.promise, "obsolete B session disposal");
		// C starts for the first time AFTER bulk shutdown snapshots active transports.
		// A held DELETE leaves the manager inside teardown; C must be refused
		// before launching any transport, rather than succeeding and becoming orphaned.
		await expect(
			withinConnectBoundary(manager.connectServers({ [names.c]: configs[names.c]! }, {}), "new C while bulk disconnect runs"),
		).rejects.toThrow(/bulk disconnect.*in progress/i);
		expect(cInitializations).toBe(0);
		expect(manager.getServerConfig(names.c)).toBeUndefined();
		// Manual/automatic reconnect must also not capture the incremented epoch
		// while the old A transport is still in disconnectAll's close snapshot.
		expect(
			await withinConnectBoundary(manager.reconnectServer(names.a, { manual: true }), "reconnect while bulk disconnect runs"),
		).toBeNull();
		expect(aInitializations).toBe(1);
		releaseADelete.resolve();
		await withinConnectBoundary(bulkShutdown, "bulk shutdown completion");
		await withinConnectBoundary(originalConnect, "original parallel connections");
		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getServerConfig(names.b)).toBeUndefined();
		expect(manager.getTools().filter(tool => tool.mcpServerName === names.b)).toEqual([]);
		expect(notifications.some(tools => tools.includes(createMCPToolName(names.b, "read_fixture")))).toBe(false);

		// A new explicit connection after teardown is a separate authorized
		// handshake, not the obsolete B attempt returning late.
		await withinConnectBoundary(
			manager.connectServers({ [names.b]: configs[names.b]! }, {}),
			"fresh B connect after bulk teardown",
		);
		expect(bInitializations).toBe(2);
		await withinConnectBoundary(
			manager.connectServers({ [names.c]: configs[names.c]! }, {}),
			"fresh C connect after bulk teardown",
		);
		expect(cInitializations).toBe(1);
		expect(manager.getConnectedServers()).toContain(names.c);
		expect(manager.getTools().some(tool => tool.mcpServerName === names.c)).toBe(true);
		expect(manager.getConnectedServers()).toContain(names.b);
		expect(manager.getTools().filter(tool => tool.mcpServerName === names.b).map(tool => tool.name)).toEqual([
			createMCPToolName(names.b, "read_fixture"),
		]);
	} finally {
		releaseBInitialize.resolve();
		releaseADelete.resolve();
		try {
			if (originalConnect) await withinConnectBoundary(originalConnect, "bulk fixture original connection cleanup");
			if (bulkShutdown) await withinConnectBoundary(bulkShutdown, "bulk fixture shutdown cleanup");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "bulk fixture manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "bulk fixture server shutdown");
			}
		}
	}
}, 35_000);


// WHY: the initial startup batch can still be waiting on tool-cache discovery
// after a bulk teardown has already removed its live transports. An old batch
// must not republish a completed peer's cached tools after disconnectAll.
it("a stale MCP startup batch cannot publish tools after bulk teardown completes", async () => {
	const bInitializeEntered = Promise.withResolvers<void>();
	const releaseBInitialize = Promise.withResolvers<void>();
	const aToolsServed = Promise.withResolvers<void>();
	const cacheReadEntered = Promise.withResolvers<void>();
	const releaseCacheRead = Promise.withResolvers<void>();
	const bTransportRetired = Promise.withResolvers<void>();
	const server = createServer(async (request, response) => {
		try {
			const route = request.url === "/a" ? "a" : request.url === "/b" ? "b" : null;
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			if (request.method === "DELETE") {
				if (route === "b" && request.headers["mcp-session-id"] === "stale-cache-b") {
					bTransportRetired.resolve();
				}
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
				if (route === "b") {
					bInitializeEntered.resolve();
					await releaseBInitialize.promise;
				}
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "stale-aggregate-batch", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				result = { tools: [{ name: "read_fixture", inputSchema: { type: "object", properties: {} } }] };
				if (route === "a") aToolsServed.resolve();
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": `stale-cache-${route}` } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await withinConnectBoundary(listening.promise, "stale batch HTTP listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected private fixture address");
	const configs = {
		"stale-batch-a": { type: "http" as const, url: `http://127.0.0.1:${address.port}/a` },
		"stale-batch-b": { type: "http" as const, url: `http://127.0.0.1:${address.port}/b` },
	};
	// Only the external cache interface is controlled. The manager, HTTP MCP
	// initialization, tool listing and disconnectAll are all production paths.
	const cache = {
		async get(): Promise<null> {
			cacheReadEntered.resolve();
			await releaseCacheRead.promise;
			return null;
		},
		async set(): Promise<void> {},
	} as unknown as MCPToolCache;
	const manager = new MCPManager(process.cwd(), cache);
	let initial: Promise<unknown> | undefined;
	try {
		initial = manager.connectServers(configs, {});
		await withinConnectBoundary(
			Promise.all([aToolsServed.promise, bInitializeEntered.promise]),
			"stale batch A tools and B pending initialize",
		);
		// After 250ms, the startup batch waits for its optional cached
		// tools, even though A has already completed tools/list.
		await withinConnectBoundary(cacheReadEntered.promise, "held external tool-cache read");
		expect(manager.getConnectedServers()).toContain("stale-batch-a");
		await withinConnectBoundary(manager.disconnectAll(), "bulk teardown before cache completion");
		expect(manager.getTools()).toEqual([]);
		releaseBInitialize.resolve();
		await withinConnectBoundary(bTransportRetired.promise, "stale pending B transport close");
		releaseCacheRead.resolve();
		const completed = await withinConnectBoundary(initial, "stale aggregate startup completion");
		const load = completed as { tools: Array<{ name: string }>; connectedServers: string[] };
		expect(load.tools).toEqual([]);
		expect(load.connectedServers).toEqual([]);
		expect(manager.getTools()).toEqual([]);
		expect(manager.getConnectedServers()).toEqual([]);
	} finally {
		releaseBInitialize.resolve();
		releaseCacheRead.resolve();
		try {
			if (initial) await withinConnectBoundary(initial, "stale cache fixture connection cleanup");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "stale cache manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "stale cache server shutdown");
			}
		}
	}
}, 35_000);


// WHY: a single-server disconnect keeps the old transport mapped while
// waiting for its DELETE to settle. A new connect or tool waiter must not
// treat that retiring transport as a newly available live connection.
// This is a real manager and private HTTP MCP server with a held DELETE.
it("single-server teardown blocks same-name connect and reconnect until close settles", async () => {
	const name = "single-disconnect-gate";
	const deleteEntered = Promise.withResolvers<void>();
	const releaseDelete = Promise.withResolvers<void>();
	let initializeCalls = 0;
	let deleteCalls = 0;
	const server = createServer(async (request, response) => {
		try {
			if (request.method === "DELETE") {
				deleteCalls++;
				deleteEntered.resolve();
				await releaseDelete.promise;
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const message = JSON.parse(body) as { method?: string; id?: number | string };
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: Record<string, unknown>;
			if (message.method === "initialize") {
				initializeCalls++;
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "single-disconnect-gate", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				result = { tools: [{ name: "fixture_read", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": `single-disconnect-${initializeCalls}` } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await withinConnectBoundary(listening.promise, "single-disconnect HTTP listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected private fixture address");
	const config = { type: "http" as const, url: `http://127.0.0.1:${address.port}/mcp` };
	const manager = new MCPManager(process.cwd());
	let disconnecting: Promise<void> | undefined;
	try {
		const initial = await withinConnectBoundary(manager.connectServers({ [name]: config }, {}), "initial live connection");
		expect(initial.connectedServers).toContain(name);
		expect(manager.getConnectedServers()).toContain(name);
		disconnecting = manager.disconnectServer(name);
		await withinConnectBoundary(deleteEntered.promise, "held single-server DELETE");
		// A simultaneous disconnect must join the first teardown, not return
		// an independent success while the transport is still closing.
		expect(manager.disconnectServer(name)).toBe(disconnecting);
		const blocked = await withinConnectBoundary(
			manager.connectServers({ [name]: config }, {}),
			"same-name connect during explicit disconnect",
		);
		expect(blocked.connectedServers).not.toContain(name);
		expect(blocked.errors.get(name)).toMatch(/disconnect.*in progress/i);
		expect(initializeCalls).toBe(1);
		expect(
			await withinConnectBoundary(manager.reconnectServer(name, { manual: true }), "reconnect while closing"),
		).toBeNull();
		await expect(
			withinConnectBoundary(manager.waitForConnection(name), "wait for retiring connection"),
		).rejects.toThrow(/disconnect/i);
		// The per-name gate must not halt healthy unrelated MCP servers.
		const otherName = "single-disconnect-unaffected-peer";
		const other = await withinConnectBoundary(
			manager.connectServers({ [otherName]: config }, {}),
			"unrelated connect while first server disconnects",
		);
		expect(other.connectedServers).toContain(otherName);
		expect(manager.getConnectedServers()).toContain(otherName);
		expect(initializeCalls).toBe(2);
		releaseDelete.resolve();
		await withinConnectBoundary(disconnecting, "held disconnect completion");
		expect(deleteCalls).toBe(1);
		expect(manager.getConnectedServers()).not.toContain(name);
		const fresh = await withinConnectBoundary(manager.connectServers({ [name]: config }, {}), "fresh post-close connection");
		expect(fresh.connectedServers).toContain(name);
		expect(initializeCalls).toBe(3);
		expect(manager.getConnectedServers()).toContain("single-disconnect-unaffected-peer");
		expect(manager.getTools().filter(tool => tool.mcpServerName === name)).toHaveLength(1);

		// A failed close must NOT leave the retiring transport advertised as
		// connected when the per-name gate is released. Simulate only the
		// external close rejection; all manager lifecycle code is production.
		const connection = await withinConnectBoundary(manager.waitForConnection(name), "connected transport for close failure");
		const originalClose = connection.transport.close.bind(connection.transport);
		connection.transport.close = async () => { throw new Error("fixture close rejected"); };
		try {
			await expect(
				withinConnectBoundary(manager.disconnectServer(name), "rejected transport close"),
			).rejects.toThrow("fixture close rejected");
			expect(manager.getConnectedServers()).not.toContain(name);
			expect(manager.getConnectionStatus(name)).toBe("disconnected");
			expect(manager.getServerConfig(name)).toBeUndefined();
			expect(manager.getTools().filter(tool => tool.mcpServerName === name)).toEqual([]);
		} finally {
			connection.transport.close = originalClose;
			await withinConnectBoundary(originalClose(), "retire fixture transport after injected failure");
		}
		const recovered = await withinConnectBoundary(
			manager.connectServers({ [name]: config }, {}),
			"explicit re-enrollment after rejected close",
		);
		expect(recovered.connectedServers).toContain(name);
		expect(initializeCalls).toBe(4);
	} finally {
		releaseDelete.resolve();
		try {
			if (disconnecting) await withinConnectBoundary(disconnecting, "single disconnect cleanup");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "single fixture manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "single fixture HTTP shutdown");
			}
		}
	}
}, 30_000);


// WHY: bulk disconnect has an epoch fence, but a single-server disconnect
// must also revoke A's historical fulfilled task before a held B cache lookup
// allows the old parallel startup result to publish tools again.
it("does not republish a removed MCP peer when another server stalls startup cache discovery", async () => {
	const nameA = "batch-retired-peer-a";
	const nameB = "batch-pending-peer-b";
	const aToolsServed = Promise.withResolvers<void>();
	const bInitializeEntered = Promise.withResolvers<void>();
	const releaseBInitialize = Promise.withResolvers<void>();
	const cacheReadEntered = Promise.withResolvers<void>();
	const releaseCacheRead = Promise.withResolvers<void>();
	let aCloseRequests = 0;
	const server = createServer(async (request, response) => {
		try {
			const route = request.url === "/a" ? "a" : request.url === "/b" ? "b" : null;
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			if (request.method === "DELETE") {
				if (route === "a") aCloseRequests++;
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
				if (route === "b") {
					bInitializeEntered.resolve();
					await releaseBInitialize.promise;
				}
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "single-peer-retirement", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				if (route === "a") aToolsServed.resolve();
				result = { tools: [{ name: "read_fixture", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": "retired-peer-" + route } : {}),
			}).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await withinConnectBoundary(listening.promise, "retired-peer fixture listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback fixture address");
	const configs = {
		[nameA]: { type: "http" as const, url: "http://127.0.0.1:" + address.port + "/a" },
		[nameB]: { type: "http" as const, url: "http://127.0.0.1:" + address.port + "/b" },
	};
	const cache = {
		async get(name: string): Promise<null> {
			if (name === nameB) {
				cacheReadEntered.resolve();
				await releaseCacheRead.promise;
			}
			return null;
		},
		async set(): Promise<void> {},
	} as unknown as MCPToolCache;
	const manager = new MCPManager(process.cwd(), cache);
	let original: Promise<unknown> | undefined;
	try {
		original = manager.connectServers(configs, {});
		await withinConnectBoundary(
			Promise.all([aToolsServed.promise, bInitializeEntered.promise, cacheReadEntered.promise]),
			"fulfilled A with held B cache",
		);
		expect(manager.getConnectedServers()).toContain(nameA);
		expect(manager.getTools().some(tool => tool.mcpServerName === nameA)).toBe(true);
		await withinConnectBoundary(manager.disconnectServer(nameA), "retire A while B cache lookup is held");
		expect(aCloseRequests).toBe(1);
		expect(manager.getConnectedServers()).not.toContain(nameA);
		expect(manager.getTools().filter(tool => tool.mcpServerName === nameA)).toEqual([]);
		releaseCacheRead.resolve();
		const oldResult = await withinConnectBoundary(original, "held startup batch completion") as {
			connectedServers: string[];
			tools: Array<{ mcpServerName?: string }>;
		};
		expect(oldResult.connectedServers).not.toContain(nameA);
		expect(oldResult.tools.some(tool => tool.mcpServerName === nameA)).toBe(false);
		expect(manager.getTools().filter(tool => tool.mcpServerName === nameA)).toEqual([]);
		expect(manager.getConnectedServers()).not.toContain(nameA);
		// The unrelated B startup can still complete normally; only A was retired.
		releaseBInitialize.resolve();
		await withinConnectBoundary(manager.waitForConnection(nameB), "unrelated B connection");
		expect(manager.getConnectedServers()).toContain(nameB);
	} finally {
		releaseBInitialize.resolve();
		releaseCacheRead.resolve();
		try {
			if (original) await withinConnectBoundary(original, "retired-peer original batch cleanup");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "retired-peer manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "retired-peer HTTP cleanup");
			}
		}
	}
}, 35_000);


// WHY: a global disconnect must join an in-flight single-server close.
// Even when an HTTP transport suppresses duplicate DELETE requests, a second
// close invocation is not an actual join of the first pending teardown.
it("bulk MCP teardown joins a concurrent per-server close without a duplicate close attempt", async () => {
	const names = { a: "joined-close-a", b: "joined-close-b" };
	const aCloseEntered = Promise.withResolvers<void>();
	const bDeleteEntered = Promise.withResolvers<void>();
	const releaseADelete = Promise.withResolvers<void>();
	let aCloseCalls = 0;
	let aDeletes = 0;
	let bDeletes = 0;
	const server = createServer(async (request, response) => {
		try {
			const route = request.url === "/a" ? "a" : request.url === "/b" ? "b" : undefined;
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			if (request.method === "DELETE") {
				if (route === "a") {
					aDeletes++;
					if (aDeletes === 1) await releaseADelete.promise;
				} else {
					bDeletes++;
					bDeleteEntered.resolve();
				}
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const message = JSON.parse(body) as { id?: number | string; method?: string };
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const result: Record<string, unknown> = message.method === "initialize"
				? {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "joined-close", version: "1.0.0" },
				}
				: message.method === "tools/list"
					? { tools: [{ name: "read_fixture", inputSchema: { type: "object", properties: {} } }] }
					: {};
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": "joined-close-" + route } : {}),
			}).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const ready = Promise.withResolvers<void>();
	server.once("error", ready.reject);
	server.listen(0, "127.0.0.1", () => ready.resolve());
	await withinConnectBoundary(ready.promise, "joined-close HTTP listen");
	server.off("error", ready.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected HTTP fixture address");
	const manager = new MCPManager(process.cwd());
	let single: Promise<void> | undefined;
	let bulk: Promise<void> | undefined;
	try {
		const configs = {
			[names.a]: { type: "http" as const, url: "http://127.0.0.1:" + address.port + "/a" },
			[names.b]: { type: "http" as const, url: "http://127.0.0.1:" + address.port + "/b" },
		};
		const load = await withinConnectBoundary(manager.connectServers(configs, {}), "two live peer connects");
		expect(load.connectedServers.sort()).toEqual([names.a, names.b].sort());
		// Only the external close boundary is held. The manager and HTTP
		// transport remain real. Counting invocations proves the previous bulk
		// implementation started a SECOND close even when HttpTransport.close
		// makes the duplicate DELETE a no-op by clearing #connected first.
		const connection = await withinConnectBoundary(manager.waitForConnection(names.a), "live A transport");
		const actualClose = connection.transport.close.bind(connection.transport);
		connection.transport.close = async () => {
			aCloseCalls++;
			aCloseEntered.resolve();
			if (aCloseCalls === 1) await releaseADelete.promise;
			await actualClose();
		};
		single = manager.disconnectServer(names.a);
		await withinConnectBoundary(aCloseEntered.promise, "single A close held");
		bulk = manager.disconnectAll();
		// B's DELETE proves the bulk teardown has reached its connected-peer
		// closing snapshot without releasing the independent A close.
		await withinConnectBoundary(bDeleteEntered.promise, "bulk B DELETE");
		releaseADelete.resolve();
		await withinConnectBoundary(Promise.all([single, bulk]), "joined single/bulk teardown");
		expect(aCloseCalls).toBe(1);
		expect(aDeletes).toBe(1);
		expect(bDeletes).toBe(1);
		expect(manager.getConnectedServers()).toEqual([]);
		expect(manager.getTools()).toEqual([]);
	} finally {
		releaseADelete.resolve();
		try {
			if (single) await withinConnectBoundary(single, "single close cleanup");
			if (bulk) await withinConnectBoundary(bulk, "bulk close cleanup");
		} finally {
			try {
				await withinConnectBoundary(manager.disconnectAll(), "joined-close final manager cleanup");
			} finally {
				server.closeAllConnections();
				const stopped = Promise.withResolvers<void>();
				server.close(() => stopped.resolve());
				await withinConnectBoundary(stopped.promise, "joined-close server cleanup");
			}
		}
	}
}, 35_000);
