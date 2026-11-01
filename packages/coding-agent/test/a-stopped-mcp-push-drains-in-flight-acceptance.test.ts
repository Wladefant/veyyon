import { expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { MCPManager } from "../src/mcp/manager";
import type { MCPEventOccurrence } from "../src/mcp/types";

// WHY: a push frame may already be inside its asynchronous acceptance callback
// when stopEvents cancels the stream. Stop must drain that callback without
// advancing the resume cursor for a stopped subscription.
it("drains an in-flight push acceptance on stop without committing its cursor", async () => {
	const eventName = "orders/changed";
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const streamOpened = Promise.withResolvers<{
		id: string | number;
		controller: ReadableStreamDefaultController<Uint8Array>;
	}>();
	const streamCancelled = Promise.withResolvers<void>();
	const delivered: string[] = [];
	const committedCursors: Array<string | null> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: string | number; method?: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
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
					const streamId = message.id;
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": ready\n\n"));
							streamOpened.resolve({ id: streamId, controller });
						},
						cancel() {
							streamCancelled.resolve();
						},
					});
					return new Response(body, { headers: { "content-type": "text/event-stream" } });
				}
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Unsupported synthetic method" },
					});
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		},
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
		await manager.connectServers({
			"push-stop-server": {
				type: "http",
				url: "http://127.0.0.1:" + server.port + "/mcp",
				events: { enabled: true, subscriptions: [{ name: eventName, mode: "push" }] },
			},
		}, {});
		const { id, controller } = await streamOpened.promise;
		const occurrence = {
			eventId: "first",
			name: eventName,
			timestamp: "2026-11-01T12:00:00.000Z",
			data: { orderId: "first" },
			cursor: "after-first",
		};
		const message = {
			jsonrpc: "2.0",
			method: "notifications/events/event",
			params: { ...occurrence, _meta: { "io.modelcontextprotocol/subscriptionId": id } },
		};
		controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(message) + "\n\n"));
		await firstStarted.promise;
		let stopped = false;
		const stop = manager.stopEvents().then(() => { stopped = true; });
		await streamCancelled.promise;
		await delay(30);
		expect(stopped).toBe(false);
		releaseFirst.resolve();
		await stop;
		expect(stopped).toBe(true);
		expect(delivered).toEqual(["first"]);
		expect(committedCursors).toEqual([]);
		expect(manager.getActiveEventSubscriptionCount()).toBe(0);
	} finally {
		releaseFirst.resolve();
		await manager.disconnectAll();
		server.stop(true);
	}
}, 15_000);
