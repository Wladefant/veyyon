import { expect, it } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { MCPManager } from "../src/mcp/manager";
import type { MCPEventOccurrence } from "../src/mcp/types";

// WHY: stopping during an awaited occurrence or gap acceptance must not commit
// the page's final cursor. Replay must retain undelivered events and deduplicate
// accepted ones. These cases use the real manager/HTTP transport and synthetic
// durable callbacks; they do not prove disk persistence, push or webhook replay.
const WAIT_LIMIT_MS = 5_000;
async function within<T>(operation: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${phase}`)), WAIT_LIMIT_MS);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

for (const boundary of ["occurrence", "gap"] as const) {
	it(`keeps a poll page replayable after stopping during ${boundary} acceptance`, async () => {
		const eventName = "orders/changed";
		const acceptanceStarted = Promise.withResolvers<void>();
		const releaseAcceptance = Promise.withResolvers<void>();
		const replayCommitted = Promise.withResolvers<void>();
		const pollCursors: unknown[] = [];
		const committedCursors: Array<string | null> = [];
		const accepted: string[] = [];
		const duplicates: string[] = [];
		const gapIds = new Set<string>();
		const acceptedGapCursors: Array<string | null> = [];
		const duplicateGapCursors: Array<string | null> = [];
		const serverErrors: unknown[] = [];
		let persistedCursor: string | null = "before-page";
		let pauseAcceptance = true;
		const occurrence = (eventId: string): MCPEventOccurrence => ({
			eventId,
			name: eventName,
			timestamp: "2026-11-01T12:00:00.000Z",
			data: { eventId },
		});
		async function pauseAt(selected: typeof boundary): Promise<void> {
			if (selected !== boundary || !pauseAcceptance) return;
			pauseAcceptance = false;
			acceptanceStarted.resolve();
			await releaseAcceptance.promise;
		}
		async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			const message = JSON.parse(await text(request)) as {
				id?: string | number;
				method?: string;
				params?: Record<string, unknown>;
			};
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
						serverInfo: { name: "poll-stop-replay", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [] };
					break;
				case "events/list":
					result = { events: [{ name: eventName, inputSchema: { type: "object" }, delivery: ["poll"] }] };
					break;
				case "events/poll":
					pollCursors.push(message.params?.cursor);
					result = {
						events: message.params?.cursor === "before-page" ? [occurrence("first"), occurrence("second")] : [],
						cursor: "after-page",
						truncated: boundary === "gap",
						hasMore: false,
						nextPollMs: 30_000,
					};
					break;
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
				response.writeHead(500).end();
			});
		});
		const manager = new MCPManager(process.cwd());
		const accept = async (_server: string, event: MCPEventOccurrence): Promise<"queued" | "duplicate"> => {
			await pauseAt("occurrence");
			if (accepted.includes(event.eventId)) {
				duplicates.push(event.eventId);
				return "duplicate";
			}
			accepted.push(event.eventId);
			return "queued";
		};
		manager.setOnEvent(accept);
		manager.setOnEventControl(async (_server, _key, control) => {
			if (control.type !== "gap") throw new Error("Unexpected synthetic control type");
			await pauseAt("gap");
			if (gapIds.has(control.messageId)) {
				duplicateGapCursors.push(control.cursor ?? null);
				return "duplicate";
			}
			gapIds.add(control.messageId);
			acceptedGapCursors.push(control.cursor ?? null);
			return "queued";
		});
		manager.setEventCursorProvider(() => persistedCursor);
		manager.setOnEventCursor((_server, _key, cursor) => {
			persistedCursor = cursor;
			committedCursors.push(cursor);
			replayCommitted.resolve();
		});
		try {
			const listening = once(server, "listening");
			server.listen(0, "127.0.0.1");
			await within(listening, "synthetic server startup");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Synthetic server has no TCP address");
			await within(manager.connectServers({
				"poll-stop-server": {
					type: "http",
					url: `http://127.0.0.1:${address.port}/mcp`,
					events: { enabled: true, subscriptions: [{ name: eventName, mode: "poll" }] },
				},
			}, {}), "MCP connection");
			await within(acceptanceStarted.promise, `${boundary} acceptance`);
			const stopped = manager.stopEvents();
			releaseAcceptance.resolve();
			await within(stopped, "subscription stop");

			expect(accepted).toEqual(boundary === "occurrence" ? ["first"] : ["first", "second"]);
			expect(committedCursors).toEqual([]);
			expect(persistedCursor).toBe("before-page");
			expect(manager.getActiveEventSubscriptionCount()).toBe(0);

			manager.setOnEvent(accept);
			await within(replayCommitted.promise, "replay cursor commit");
			expect(pollCursors).toEqual(["before-page", "before-page"]);
			expect(accepted).toEqual(["first", "second"]);
			expect(duplicates).toEqual(boundary === "occurrence" ? ["first"] : ["first", "second"]);
			expect(acceptedGapCursors).toEqual(boundary === "gap" ? ["after-page"] : []);
			expect(duplicateGapCursors).toEqual(boundary === "gap" ? ["after-page"] : []);
			expect(committedCursors).toEqual(["after-page"]);
			expect(persistedCursor).toBe("after-page");
			expect(serverErrors).toEqual([]);
		} finally {
			releaseAcceptance.resolve();
			try {
				await within(manager.disconnectAll(), "manager cleanup");
			} finally {
				const closed = once(server, "close");
				server.close();
				server.closeAllConnections();
				await within(closed, "synthetic server cleanup");
			}
		}
	}, 30_000);
}
