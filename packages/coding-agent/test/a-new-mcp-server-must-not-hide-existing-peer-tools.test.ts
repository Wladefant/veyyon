import { expect, it } from "bun:test";
import { createServer } from "node:http";
import { MCPManager } from "../src/mcp/manager";
import { createMCPToolName } from "../src/mcp/tool-bridge";

// WHY: connectServers may be invoked again with a subset of servers after
// initial startup. The global tool registry must keep other live peers, and a
// repeat connection request cannot erase their tools or open a second session.
// The manager and MCP HTTP initialization/tool discovery are production paths.
async function within<T>(promise: Promise<T>, stage: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`incremental MCP ${stage} timed out`)), 8_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it("adding B and reconnecting an already-connected A preserves both peer tool catalogs", async () => {
	const names = { a: "incremental-a", b: "incremental-b" };
	const initialized = { a: 0, b: 0 };
	const listRequests = { a: 0, b: 0 };
	const server = createServer(async (request, response) => {
		try {
			const route = request.url === "/a" ? "a" : request.url === "/b" ? "b" : undefined;
			if (!route) {
				response.writeHead(404).end();
				return;
			}
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
			const message = JSON.parse(body) as { method?: string; id?: number | string };
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: Record<string, unknown>;
			if (message.method === "initialize") {
				initialized[route]++;
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "incremental-catalog-fixture", version: "1.0.0" },
				};
			} else if (message.method === "tools/list") {
				listRequests[route]++;
				result = { tools: [{ name: "peer_read", inputSchema: { type: "object", properties: {} } }] };
			} else {
				result = {};
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "Mcp-Session-Id": `incremental-catalog-${route}` } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			if (!response.headersSent) response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await within(listening.promise, "HTTP listen");
	server.off("error", listening.reject);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback test address");
	const configs = {
		[names.a]: { type: "http" as const, url: `http://127.0.0.1:${address.port}/a` },
		[names.b]: { type: "http" as const, url: `http://127.0.0.1:${address.port}/b` },
	};
	const manager = new MCPManager(process.cwd());
	const aTool = createMCPToolName(names.a, "peer_read");
	const bTool = createMCPToolName(names.b, "peer_read");
	const seenA = Promise.withResolvers<void>();
	const seenB = Promise.withResolvers<void>();
	manager.setOnToolsChanged(tools => {
		const current = tools.map(tool => tool.name);
		if (current.includes(aTool)) seenA.resolve();
		if (current.includes(bTool)) seenB.resolve();
	});
	const catalog = () => manager.getTools().map(tool => tool.name).sort();
	const expected = [aTool, bTool].sort();
	try {
		const first = await within(manager.connectServers({ [names.a]: configs[names.a]! }, {}), "connect A");
		await within(seenA.promise, "A tools/list notification");
		expect(first.connectedServers).toContain(names.a);
		expect(catalog()).toEqual([aTool]);
		const incremental = await within(
			manager.connectServers({ [names.b]: configs[names.b]! }, {}),
			"connect B while A remains live",
		);
		await within(seenB.promise, "B tools/list notification");
		expect(manager.getConnectedServers().sort()).toEqual([names.a, names.b].sort());
		// The old source overwrote the whole registry with the new batch B.
		expect(catalog()).toEqual(expected);
		expect(incremental.tools.map(tool => tool.name).sort()).toEqual(expected);
		const repeated = await within(
			manager.connectServers({ [names.a]: configs[names.a]! }, {}),
			"repeat already-connected A",
		);
		// No pending tasks: the old source wrote an empty global registry.
		expect(catalog()).toEqual(expected);
		expect(repeated.tools.map(tool => tool.name).sort()).toEqual(expected);
		expect(initialized).toEqual({ a: 1, b: 1 });
		expect(listRequests).toEqual({ a: 1, b: 1 });
	} finally {
		try {
			await within(manager.disconnectAll(), "manager teardown");
		} finally {
			server.closeAllConnections();
			const stopped = Promise.withResolvers<void>();
			server.close(() => stopped.resolve());
			await within(stopped.promise, "private HTTP server stop");
		}
	}
}, 30_000);
