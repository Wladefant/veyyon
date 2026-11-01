import { expect, it } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { MCPManager } from "../src/mcp/manager";
import type { MCPEventOccurrence } from "../src/mcp/types";

// WHY: an in-flight push event can outlive stream cancellation. The manager
// must drain its acceptance before returning from stop, without acknowledging
// a cursor from a subscription that is no longer active.
const WAIT_LIMIT_MS = 5_000;
async function within<T>(operation: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), WAIT_LIMIT_MS);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it("drains in-flight push acceptance on stop without committing its cursor", async () => {
	const eventName = "orders/changed";
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const streamOpened = Promise.withResolvers<{
		id: string | number;
		response: ServerResponse;
	}>();
	const streamClosed = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const committedCursors: Array<string | null> = [];
	const serverErrors: unknown[] = [];

	async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = JSON.parse(await text(request)) as { id?: string | number; method?: string };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: Record<string, unknown>;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {}, events: { listChanged: true } },
					serverInfo: { name: "push-stop-drain", version: "1.0.0" },
				};
				break;
			case "tools/list":
				result = { tools: [] };
				break;
			case "events/list":
				result = {
					events: [{ name: eventName, inputSchema: { type: "object" }, delivery: ["push"] }],
				};
				break;
			case "events/stream": {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(": ready\n\n");
				response.once("close", () => { streamClosed.resolve(); });
				streamOpened.resolve({ id: message.id, response });
				return;
			}
			default:
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
					jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported synthetic method" },
				}));
				return;
		}
		response.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	}
	const server = createServer((request, response) => {
		void respond(request, response).catch(error => {
			serverErrors.push(error);
			if (!response.headersSent) response.writeHead(500).end();
			else response.destroy();
		});
	});
	const manager = new MCPManager(process.cwd());
	manager.setOnEvent(async (_server: string, occurrence: MCPEventOccurrence) => {
		firstStarted.resolve();
		await releaseFirst.promise;
		delivered.push(occurrence.eventId);
		return "queued" as const;
	});
	manager.setOnEventCursor((_server, _key, cursor) => {
		committedCursors.push(cursor);
	});
	try {
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await within(listening, "synthetic server startup");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Synthetic server has no TCP address");
		await within(manager.connectServers({
			"push-stop-server": {
				type: "http",
				url: "http://127.0.0.1:" + address.port + "/mcp",
				events: { enabled: true, subscriptions: [{ name: eventName, mode: "push" }] },
			},
		}, {}), "MCP connection");
		const { id, response } = await within(streamOpened.promise, "push stream");
		const occurrence = {
			eventId: "first", name: eventName, timestamp: "2026-11-01T12:00:00.000Z",
			data: { orderId: "first" }, cursor: "after-first",
		};
		const message = {
			jsonrpc: "2.0", method: "notifications/events/event",
			params: { ...occurrence, _meta: { "io.modelcontextprotocol/subscriptionId": id } },
		};
		response.write("data: " + JSON.stringify(message) + "\n\n");
		await within(firstStarted.promise, "in-flight push acceptance");
		let stopped = false;
		const stop = manager.stopEvents().then(() => { stopped = true; });
		await within(streamClosed.promise, "push stream cancellation");
		await delay(30);
		expect(stopped).toBe(false);
		releaseFirst.resolve();
		await within(stop, "subscription stop");
		expect(stopped).toBe(true);
		expect(delivered).toEqual(["first"]);
		expect(committedCursors).toEqual([]);
		expect(manager.getActiveEventSubscriptionCount()).toBe(0);
		expect(serverErrors).toEqual([]);
	} finally {
		releaseFirst.resolve();
		try {
			await within(manager.disconnectAll(), "manager cleanup");
		} finally {
			if (server.listening) {
				const closed = once(server, "close");
				server.close();
				server.closeAllConnections();
				await within(closed, "synthetic server cleanup");
			}
		}
	}
}, 20_000);
