import { expect, it } from "bun:test";
import { MCPManager } from "../src/mcp/manager";
import type { MCPEventOccurrence } from "../src/mcp/types";

// WHY: stopping during acceptance of the first event used to skip the rest of
// the page but still commit its final cursor, permanently hiding later events.
// Exercise the real manager/HTTP transport, with only the remote MCP server and
// durable acceptance boundary represented by synthetic in-memory fixtures.
it("keeps a partially delivered poll page replayable after stop and restart", async () => {
	const eventName = "orders/changed";
	const firstDeliveryStarted = Promise.withResolvers<void>();
	const releaseFirstDelivery = Promise.withResolvers<void>();
	const replayCommitted = Promise.withResolvers<void>();
	const pollCursors: unknown[] = [];
	const committedCursors: Array<string | null> = [];
	const accepted: string[] = [];
	const duplicates: string[] = [];
	let persistedCursor: string | null = "before-page";
	let pauseFirstDelivery = true;
	const occurrence = (eventId: string): MCPEventOccurrence => ({
		eventId,
		name: eventName,
		timestamp: "2026-11-01T12:00:00.000Z",
		data: { eventId },
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as {
				id?: string | number;
				method?: string;
				params?: Record<string, unknown>;
			};
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: Record<string, unknown>;
			switch (message.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {}, events: { listChanged: true } },
						serverInfo: { name: "poll-stop-replay", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [] };
					break;
				case "events/list":
					result = {
						events: [{ name: eventName, inputSchema: { type: "object" }, delivery: ["poll"] }],
					};
					break;
				case "events/poll":
					pollCursors.push(message.params?.cursor);
					result = {
						events: message.params?.cursor === "before-page" ? [occurrence("first"), occurrence("second")] : [],
						cursor: "after-page",
						hasMore: false,
						nextPollMs: 30_000,
					};
					break;
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
	const accept = async (_server: string, event: MCPEventOccurrence): Promise<"queued" | "duplicate"> => {
		if (pauseFirstDelivery) {
			pauseFirstDelivery = false;
			firstDeliveryStarted.resolve();
			await releaseFirstDelivery.promise;
		}
		if (accepted.includes(event.eventId)) {
			duplicates.push(event.eventId);
			return "duplicate";
		}
		accepted.push(event.eventId);
		return "queued";
	};
	manager.setOnEvent(accept);
	manager.setEventCursorProvider(() => persistedCursor);
	manager.setOnEventCursor((_server, _key, cursor) => {
		persistedCursor = cursor;
		committedCursors.push(cursor);
		replayCommitted.resolve();
	});
	try {
		await manager.connectServers({
			"poll-stop-server": {
				type: "http",
				url: `http://127.0.0.1:${server.port}/mcp`,
				events: { enabled: true, subscriptions: [{ name: eventName, mode: "poll" }] },
			},
		}, {});
		await firstDeliveryStarted.promise;
		const stopped = manager.stopEvents();
		releaseFirstDelivery.resolve();
		await stopped;

		expect(accepted).toEqual(["first"]);
		expect(committedCursors).toEqual([]);
		expect(persistedCursor).toBe("before-page");
		expect(manager.getActiveEventSubscriptionCount()).toBe(0);

		manager.setOnEvent(accept);
		await replayCommitted.promise;
		expect(pollCursors).toEqual(["before-page", "before-page"]);
		expect(accepted).toEqual(["first", "second"]);
		expect(duplicates).toEqual(["first"]);
		expect(committedCursors).toEqual(["after-page"]);
		expect(persistedCursor).toBe("after-page");
	} finally {
		releaseFirstDelivery.resolve();
		await manager.disconnectAll();
		server.stop(true);
	}
}, 10_000);
