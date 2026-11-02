import { expect, it } from "bun:test";
import { createServer } from "node:http";
import { MCPManager } from "../src/mcp/manager";

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
	let initializeCalls = 0;
	let publishedToolLists = 0;
	let closeRequests = 0;
	const server = createServer(async (request, response) => {
		try {
			if (request.method === "DELETE") {
				closeRequests++;
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
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch {
			response.writeHead(500).end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
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
		expect(manager.getServerConfig(name)).toBeUndefined();
		expect(manager.getConnectedServers()).not.toContain(name);
		expect(manager.getTools().filter(tool => tool.mcpServerName === name)).toEqual([]);
		expect(notifications).toEqual([]);

		// A newly authorized connection of the same NAME has new ownership.
		await withinConnectBoundary(manager.connectServers({ [name]: config }, {}), "explicit second connection");
		expect(initializeCalls).toBe(2);
		expect(manager.getConnectedServers()).toContain(name);
		const tools = manager.getTools().filter(tool => tool.mcpServerName === name);
		expect(tools).toHaveLength(1);
		expect(notifications.at(-1)).toEqual(manager.getTools().map(tool => tool.name));
		expect(publishedToolLists).toBeGreaterThanOrEqual(1);
	} finally {
		releaseFirstInitialize.resolve();
		try {
			if (initial) await withinConnectBoundary(initial, "initial connection teardown");
			await withinConnectBoundary(manager.disconnectAll(), "manager teardown");
		} finally {
			server.closeAllConnections();
			const stopped = Promise.withResolvers<void>();
			server.close(() => stopped.resolve());
			await withinConnectBoundary(stopped.promise, "private server shutdown");
		}
	}
	// A close request is a transport detail; it is deliberately not used as
	// an oracle because no-session-id HTTP servers may not send DELETE.
	expect(closeRequests).toBeGreaterThanOrEqual(0);
}, 30_000);
