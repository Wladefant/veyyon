import { describe, expect, it, vi } from "bun:test";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MCPManager } from "../src/mcp/manager";
import type { MCPEventOccurrence, MCPServerConfig, MCPServerEventSubscriptionConfig } from "../src/mcp/types";

const EVENT_NAME = "orders/changed";
const CALLBACK_SECRET = `whsec_${Buffer.from("manager-contract-test-secret").toString("base64")}`;

type JsonRpcRequest = { id?: string | number; method?: string; params?: Record<string, unknown> };
type ServerRecord = { id?: string | number; method: string; params: Record<string, unknown> };
type FakeServer = {
	url: string;
	requests: ServerRecord[];
	streamControllers: ReadableStreamDefaultController<Uint8Array>[];
	streamCancellations: Array<Promise<void>>;
	stop(): void;
};
type FakeServerOptions = {
	delivery?: "poll" | "push" | "webhook" | Array<"poll" | "push" | "webhook">;
	eventsList?: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
	poll?: (params: Record<string, unknown>) => Record<string, unknown>;
	webhookSubscribe?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
	webhookUnsubscribe?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
	onStream?: (
		controller: ReadableStreamDefaultController<Uint8Array>,
		streamId: string | number,
		ordinal: number,
	) => void;
};

// A dead callback must not leave a previously active MCP feed consuming
// events. Observe real fake-server requests with a bounded wait.
async function withinHandlerChange<T>(work: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${phase}`)), 5_000);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function advanceTimers(ms: number): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	vi.advanceTimersByTime(ms);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeMcpServer(options: FakeServerOptions): FakeServer {
	const requests: ServerRecord[] = [];
	const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const streamCancellations: Array<Promise<void>> = [];
	let nextSubscription = 1;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as JsonRpcRequest;
			const params = message.params ?? {};
			requests.push({ id: message.id, method: message.method ?? "", params });
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: Record<string, unknown> = {};
			switch (message.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {}, events: { listChanged: true } },
						serverInfo: { name: "manager-contract", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [] };
					break;
				case "events/list":
					result = options.eventsList
						? await options.eventsList(params)
						: {
								events: [
									{
										name: EVENT_NAME,
										description: "order changes",
										inputSchema: { type: "object" },
										delivery: Array.isArray(options.delivery)
											? options.delivery
											: [options.delivery ?? "poll"],
									},
								],
							};
					break;
				case "events/poll":
					result = options.poll?.(params) ?? { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
					break;
				case "events/stream": {
					const encoder = new TextEncoder();
					const cancellation = Promise.withResolvers<void>();
					streamCancellations.push(cancellation.promise);
					const streamId = message.id;
					const ordinal = streamControllers.length + 1;
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							streamControllers.push(controller);
							controller.enqueue(encoder.encode(": ready\n\n"));
							if (streamId !== undefined) options.onStream?.(controller, streamId, ordinal);
						},
						cancel() {
							cancellation.resolve();
						},
					});
					return new Response(body, { headers: { "content-type": "text/event-stream" } });
				}
				case "events/subscribe":
					result = options.webhookSubscribe
						? await options.webhookSubscribe(params)
						: { id: `webhook-${nextSubscription++}`, cursor: "webhook-cursor", refreshBefore: null };
					break;
				case "events/unsubscribe":
					result = options.webhookUnsubscribe ? await options.webhookUnsubscribe(params) : { ok: true };
					break;
				default:
					result = {};
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		requests,
		streamControllers,
		streamCancellations,
		stop: () => server.stop(true),
	};
}

function event(eventId: string, cursor?: string): MCPEventOccurrence {
	return {
		eventId,
		name: EVENT_NAME,
		timestamp: "2026-10-14T12:00:00.000Z",
		data: { orderId: eventId },
		...(cursor === undefined ? {} : { cursor }),
	};
}

function emitStreamNotification(
	controller: ReadableStreamDefaultController<Uint8Array>,
	streamId: string | number,
	method: string,
	params: Record<string, unknown> | MCPEventOccurrence,
): void {
	const payload = JSON.stringify({
		jsonrpc: "2.0",
		method,
		params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": streamId } },
	});
	controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
}

function emitStreamBatch(
	controller: ReadableStreamDefaultController<Uint8Array>,
	streamId: string | number,
	messages: Array<{ method: string; params: Record<string, unknown> | MCPEventOccurrence }>,
): void {
	const frame = messages
		.map(({ method, params }) => {
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				method,
				params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": streamId } },
			});
			return `data: ${payload}\n\n`;
		})
		.join("");
	controller.enqueue(new TextEncoder().encode(frame));
}

function managerConfig(server: FakeServer, events: NonNullable<MCPServerConfig["events"]>): MCPServerConfig {
	return { type: "http", url: server.url, events };
}

async function connect(manager: MCPManager, name: string, config: MCPServerConfig): Promise<void> {
	await manager.connectServers({ [name]: config }, {});
}

describe("MCPManager event subscription contracts", () => {
	it("uses hasMore for immediate polling, resumes with cursors, and enforces the one-second poll floor", async () => {
		const pollRequests: Array<Record<string, unknown>> = [];
		const firstDelivered = Promise.withResolvers<void>();
		const secondPoll = Promise.withResolvers<void>();
		const thirdPoll = Promise.withResolvers<void>();
		const bothDelivered = Promise.withResolvers<void>();
		const delivered = new Set<string>();
		const cursors: Array<string | null> = [];
		const server = fakeMcpServer({
			delivery: "poll",
			poll: params => {
				pollRequests.push(params);
				if (pollRequests.length === 1)
					return { events: [event("evt-1", "cursor-1")], cursor: "cursor-1", hasMore: true, nextPollMs: 0 };
				if (pollRequests.length === 2) {
					secondPoll.resolve();
					return { events: [event("evt-2", "cursor-2")], cursor: "cursor-2", hasMore: false, nextPollMs: 0 };
				}
				thirdPoll.resolve();
				return { events: [], cursor: "cursor-2", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEvent((_name, occurrence) => {
			delivered.add(occurrence.eventId);
			if (delivered.size === 1) firstDelivered.resolve();
			if (delivered.size === 2) bothDelivered.resolve();
		});
		manager.setEventCursorProvider(() => "resume-here");
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"poll-server",
				managerConfig(server, { enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }] }),
			);
			await firstDelivered.promise;
			await secondPoll.promise;
			expect(pollRequests).toHaveLength(2);
			await bothDelivered.promise;
			await advanceTimers(0);
			expect(delivered).toEqual(new Set(["evt-1", "evt-2"]));
			expect(pollRequests.slice(0, 2).map(params => params.cursor)).toEqual(["resume-here", "cursor-1"]);
			expect(cursors).toContain("cursor-1");
			expect(cursors).toContain("cursor-2");
			await advanceTimers(999);
			expect(pollRequests).toHaveLength(2);
			await advanceTimers(1);
			await thirdPoll.promise;
			expect(pollRequests).toHaveLength(3);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});
	it("preserves the prior poll cursor when persistence fails within a multi-event batch", async () => {
		const pollRequests: Array<Record<string, unknown>> = [];
		const secondDeliveryFailed = Promise.withResolvers<void>();
		const retryPollStarted = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "poll",
			poll: params => {
				pollRequests.push(params);
				if (pollRequests.length === 1) {
					return {
						events: [event("batch-first", "batch-event-cursor"), event("batch-second", "second-event-cursor")],
						cursor: "batch-final-cursor",
						hasMore: false,
						nextPollMs: 30_000,
					};
				}
				retryPollStarted.resolve();
				return { events: [], cursor: "retry-cursor", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		const cursors: Array<string | null> = [];
		manager.setOnEvent((_name, occurrence) => {
			if (occurrence.eventId === "batch-second") {
				secondDeliveryFailed.resolve();
				throw new Error("second event was not persisted");
			}
			return "queued";
		});
		manager.setEventCursorProvider(() => "prior-cursor");
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"poll-batch-server",
				managerConfig(server, { enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }] }),
			);
			await secondDeliveryFailed.promise;
			await advanceTimers(0);
			expect(cursors).not.toContain("batch-final-cursor");
			expect(cursors).toEqual([]);
			await advanceTimers(4_999);
			expect(pollRequests).toHaveLength(1);
			await advanceTimers(1);
			await retryPollStarted.promise;
			expect(pollRequests[1]?.cursor).toBe("prior-cursor");
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	it("routes push events by stream id, reconnects after heartbeat idle timeout, and stops on termination", async () => {
		const firstStreamOpened = Promise.withResolvers<void>();
		const secondStreamOpened = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "push",
			onStream(_controller, _streamId, ordinal) {
				if (ordinal === 1) firstStreamOpened.resolve();
				else if (ordinal === 2) secondStreamOpened.resolve();
			},
		});
		const manager = new MCPManager(process.cwd());
		const received: string[] = [];
		const controls: string[] = [];
		const eventReceived = Promise.withResolvers<void>();
		const controlReceived = Promise.withResolvers<void>();
		manager.setOnEvent((_name, occurrence) => {
			received.push(occurrence.eventId);
			eventReceived.resolve();
		});
		manager.setOnEventControl((_name, _key, control) => {
			controls.push(control.type);
			controlReceived.resolve();
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"push-server",
				managerConfig(server, { enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "push" }] }),
			);
			await firstStreamOpened.promise;
			const firstStream = server.requests.find(request => request.method === "events/stream");
			const firstController = server.streamControllers[0];
			expect(firstStream?.id).toBeDefined();
			expect(firstController).toBeDefined();
			emitStreamNotification(firstController!, firstStream!.id!, "notifications/events/event", event("push-1"));
			emitStreamNotification(firstController!, "unowned-stream", "notifications/events/event", event("not-owned"));
			await eventReceived.promise;
			expect(received).toEqual(["push-1"]);
			const priorStreamCount = server.requests.filter(request => request.method === "events/stream").length;
			await advanceTimers(60_000);
			await server.streamCancellations[0];
			await advanceTimers(5_000);
			await secondStreamOpened.promise;
			const streams = server.requests.filter(request => request.method === "events/stream");
			expect(streams.length).toBeGreaterThan(priorStreamCount);
			const nextStream = streams[1];
			const nextController = server.streamControllers[1];
			expect(nextStream?.id).toBeDefined();
			emitStreamNotification(nextController!, nextStream!.id!, "notifications/events/terminated", {
				error: { code: -32024, message: "subscription ended" },
			});
			await controlReceived.promise;
			expect(controls).toEqual(["terminated"]);
			await manager.stopEvents();
			const stoppedCount = server.requests.filter(request => request.method === "events/stream").length;
			await advanceTimers(5_000);
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(stoppedCount);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	// WHY: an immediately reopened or increasingly delayed push stream can hide a dead subscription or
	// grow reconnect latency after repeated transport failures. This pins the fixed delay and stop
	// behavior through real stream requests and delivered events; it does not cover server-side recovery.
	it("bounds repeated push reconnects and cancels a pending reconnect on stop", async () => {
		const streamOpened = Promise.withResolvers<void>();
		const secondStreamOpened = Promise.withResolvers<void>();
		const thirdStreamOpened = Promise.withResolvers<void>();
		const received: string[] = [];
		const eventReceived = Promise.withResolvers<void>();
		const secondEventReceived = Promise.withResolvers<void>();
		// Fake timer advancement drains promises, but not the real HTTP server's I/O.
		// Let any prematurely opened request reach the server before asserting absence.
		const settleNetwork = async () => {
			const response = await fetch(server.url, {
				method: "POST",
				body: JSON.stringify({ id: "network-fence", method: "tools/list" }),
			});
			await response.json();
		};
		const server = fakeMcpServer({
			delivery: "push",
			onStream(controller, streamId, ordinal) {
				if (ordinal === 1) streamOpened.resolve();
				if (ordinal === 2) secondStreamOpened.resolve();
				if (ordinal === 3) thirdStreamOpened.resolve();
				if (ordinal <= 2 && streamId !== undefined) {
					emitStreamNotification(controller, streamId, "notifications/events/event", event(`stream-${ordinal}`));
				}
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEvent((_name, occurrence) => {
			received.push(occurrence.eventId);
			eventReceived.resolve();
			if (occurrence.eventId === "stream-2") secondEventReceived.resolve();
		});
		vi.useFakeTimers();
		try {
			await connect(manager, "bounded-reconnect-server", managerConfig(server, {
				enabled: true,
				subscriptions: [{ name: EVENT_NAME, mode: "push" }],
			}));
			await streamOpened.promise;
			await eventReceived.promise;
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(1);
			expect(received).toEqual(["stream-1"]);

			emitStreamNotification(server.streamControllers[0]!, server.requests.filter(request => request.method === "events/stream")[0]!.id!, "notifications/events/event", {
				eventId: "failed-1", name: EVENT_NAME, timestamp: "2026-10-14T12:00:00Z", data: {}, cursor: 1,
			});
			await server.streamCancellations[0]!;
			await advanceTimers(4_999);
			await settleNetwork();
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(1);
			await advanceTimers(1);
			await settleNetwork();
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(2);
			await secondStreamOpened.promise;
			await secondEventReceived.promise;
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(2);
			expect(received).toEqual(["stream-1", "stream-2"]);

			emitStreamNotification(server.streamControllers[1]!, server.requests.filter(request => request.method === "events/stream")[1]!.id!, "notifications/events/event", {
				eventId: "failed-2", name: EVENT_NAME, timestamp: "2026-10-14T12:00:00Z", data: {}, cursor: 1,
			});
			await server.streamCancellations[1]!;
			await advanceTimers(4_999);
			await settleNetwork();
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(2);
			await advanceTimers(1);
			await settleNetwork();
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(3);
			await thirdStreamOpened.promise;
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(3);

			emitStreamNotification(server.streamControllers[2]!, server.requests.filter(request => request.method === "events/stream")[2]!.id!, "notifications/events/event", {
				eventId: "failed-3", name: EVENT_NAME, timestamp: "2026-10-14T12:00:00Z", data: {}, cursor: 1,
			});
			await server.streamCancellations[2]!;
			const stop = manager.stopEvents();
			await stop;
			await advanceTimers(10_001);
			await settleNetwork();
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(3);
			expect(received).toEqual(["stream-1", "stream-2"]);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	it("waits for concurrent duplicate persistence and retries the failed event after reconnect", async () => {
		const firstPersistence = Promise.withResolvers<void>();
		const firstAttemptStarted = Promise.withResolvers<void>();
		const retryStreamOpened = Promise.withResolvers<void>();
		const retryAccepted = Promise.withResolvers<void>();
		const retryCursorRecorded = Promise.withResolvers<void>();
		const thirdDeliveryProcessed = Promise.withResolvers<void>();
		const eventAttempts: string[] = [];
		const acceptedEvents: string[] = [];
		const cursors: Array<string | null> = [];
		const firstStreamOpened = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "push",
			onStream(controller, streamId, ordinal) {
				if (ordinal === 1) {
					firstStreamOpened.resolve();
				} else if (ordinal === 2) {
					retryStreamOpened.resolve();
					emitStreamBatch(controller, streamId, [
						{ method: "notifications/events/event", params: event("duplicate-event", "retry-cursor") },
					]);
				}
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEvent(async (_name, occurrence) => {
			eventAttempts.push(occurrence.eventId);
			if (eventAttempts.length === 1) {
				firstAttemptStarted.resolve();
				await firstPersistence.promise;
				throw new Error("first persistence attempt failed");
			}
			acceptedEvents.push(occurrence.eventId);
			if (occurrence.eventId === "duplicate-event") retryAccepted.resolve();
			if (occurrence.eventId === "marker-event") thirdDeliveryProcessed.resolve();
			return "queued" as const;
		});
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
			if (cursor === "retry-cursor") retryCursorRecorded.resolve();
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"duplicate-push-server",
				managerConfig(server, { enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "push" }] }),
			);
			await firstStreamOpened.promise;
			const stream = server.requests.find(request => request.method === "events/stream");
			const controller = server.streamControllers[0];
			expect(stream?.id).toBeDefined();
			emitStreamBatch(controller!, stream!.id!, [
				{ method: "notifications/events/event", params: event("duplicate-event", "duplicate-cursor") },
				{ method: "notifications/events/event", params: event("duplicate-event", "duplicate-cursor") },
				{ method: "notifications/events/event", params: event("following-event", "following-cursor") },
			]);
			await firstAttemptStarted.promise;
			await advanceTimers(0);
			expect(eventAttempts).toEqual(["duplicate-event"]);
			firstPersistence.reject(new Error("persistence rejected"));
			await server.streamCancellations[0];
			expect(eventAttempts).toEqual(["duplicate-event"]);
			expect(cursors).not.toContain("duplicate-cursor");
			expect(cursors).not.toContain("following-cursor");
			await advanceTimers(5_000);
			await retryStreamOpened.promise;
			await retryAccepted.promise;
			await retryCursorRecorded.promise;
			expect(acceptedEvents).toEqual(["duplicate-event"]);
			const retriedStream = server.requests.filter(request => request.method === "events/stream")[1];
			emitStreamBatch(server.streamControllers[1]!, retriedStream!.id!, [
				{ method: "notifications/events/event", params: event("duplicate-event", "post-success-cursor") },
				{ method: "notifications/events/event", params: event("marker-event", "marker-cursor") },
			]);
			await thirdDeliveryProcessed.promise;
			expect(eventAttempts).toEqual(["duplicate-event", "duplicate-event", "marker-event"]);
			expect(acceptedEvents.filter(eventId => eventId === "duplicate-event")).toEqual(["duplicate-event"]);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	it("does not advance a heartbeat cursor past an event whose persistence fails", async () => {
		const firstStreamOpened = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "push",
			onStream(_controller, _streamId, ordinal) {
				if (ordinal === 1) firstStreamOpened.resolve();
			},
		});
		const manager = new MCPManager(process.cwd());
		const eventPersistence = Promise.withResolvers<void>();
		const eventStarted = Promise.withResolvers<void>();
		const cursors: Array<string | null> = [];
		manager.setOnEvent(() => {
			eventStarted.resolve();
			return eventPersistence.promise;
		});
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"ordered-push-server",
				managerConfig(server, { enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "push" }] }),
			);
			await firstStreamOpened.promise;
			const stream = server.requests.find(request => request.method === "events/stream");
			const controller = server.streamControllers[0];
			expect(stream?.id).toBeDefined();
			emitStreamBatch(controller!, stream!.id!, [
				{ method: "notifications/events/event", params: event("unpersisted-event", "event-cursor") },
				{ method: "notifications/events/heartbeat", params: { cursor: "heartbeat-cursor" } },
			]);
			await eventStarted.promise;
			await advanceTimers(0);
			expect(cursors).not.toContain("heartbeat-cursor");
			eventPersistence.reject(new Error("event persistence failed"));
			await server.streamCancellations[0];
			expect(cursors).not.toContain("heartbeat-cursor");
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	it("rejects malformed push cursors and reconnects from the last committed cursor", async () => {
		const firstStreamOpened = Promise.withResolvers<void>();
		const retryStreamOpened = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "push",
			onStream(_controller, _streamId, ordinal) {
				if (ordinal === 1) firstStreamOpened.resolve();
				else if (ordinal === 2) retryStreamOpened.resolve();
			},
		});
		const manager = new MCPManager(process.cwd());
		const received: string[] = [];
		const cursors: Array<string | null> = [];
		manager.setEventCursorProvider(() => "committed-cursor");
		manager.setOnEvent((_name, occurrence) => {
			received.push(occurrence.eventId);
			return "queued";
		});
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"malformed-push-server",
				managerConfig(server, {
					enabled: true,
					subscriptions: [{ name: EVENT_NAME, mode: "push" }],
				}),
			);
			await firstStreamOpened.promise;
			const firstStream = server.requests.find(request => request.method === "events/stream");
			emitStreamNotification(server.streamControllers[0]!, firstStream!.id!, "notifications/events/event", {
				eventId: "malformed-event",
				name: EVENT_NAME,
				timestamp: "2026-10-14T12:00:00Z",
				data: {},
				cursor: 42,
			});
			await server.streamCancellations[0];
			expect(received).toEqual([]);
			expect(cursors).toEqual([]);
			await advanceTimers(5_000);
			await retryStreamOpened.promise;
			const streams = server.requests.filter(request => request.method === "events/stream");
			expect(streams[1]?.params.cursor).toBe("committed-cursor");
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	// WHY: an invalid or mismatched push occurrence used to throw in the stream processor, which cancelled the stream and
	// reopened it at the same cursor, so the server resent the frame and the subscription never advanced (#718).
	// Gap: a malformed cursor on a frame still fails the frame, as the test above pins.
	it("drops a mismatched push occurrence, advances its cursor and keeps the stream open for the next frame", async () => {
		const firstStreamOpened = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "push",
			onStream(_controller, _streamId, ordinal) {
				if (ordinal === 1) firstStreamOpened.resolve();
			},
		});
		const manager = new MCPManager(process.cwd());
		const received: string[] = [];
		const cursors: Array<string | null> = [];
		const goodDelivered = Promise.withResolvers<void>();
		manager.setOnEvent((_name, occurrence) => {
			received.push(occurrence.eventId);
			goodDelivered.resolve();
			return "queued";
		});
		manager.setOnEventCursor((_name, _key, cursor) => {
			cursors.push(cursor);
		});
		vi.useFakeTimers();
		try {
			await connect(
				manager,
				"mismatch-push-server",
				managerConfig(server, {
					enabled: true,
					subscriptions: [{ name: EVENT_NAME, mode: "push" }],
				}),
			);
			await firstStreamOpened.promise;
			const stream = server.requests.find(request => request.method === "events/stream");
			const controller = server.streamControllers[0]!;
			emitStreamNotification(controller, stream!.id!, "notifications/events/event", {
				...event("mismatched", "cursor-bad"),
				name: "other/unsubscribed-event",
			});
			emitStreamNotification(controller, stream!.id!, "notifications/events/event", event("valid-1", "cursor-ok"));
			await goodDelivered.promise;
			await advanceTimers(5_000);
			expect(received).toEqual(["valid-1"]);
			expect(cursors).toEqual(["cursor-bad", "cursor-ok"]);
			expect(server.requests.filter(request => request.method === "events/stream")).toHaveLength(1);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
		}
	});

	it("answers webhook challenges before subscribing, refreshes, and unsubscribes on stop", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);
		const subscriptionCalls: number[] = [];
		const webhookCalls: string[] = [];
		const firstChallenge = Promise.withResolvers<void>();
		const secondChallenge = Promise.withResolvers<void>();
		const secondSubscription = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: "webhook",
			webhookSubscribe: async params => {
				subscriptionCalls.push(subscriptionCalls.length + 1);
				if (subscriptionCalls.length === 2) secondSubscription.resolve();
				const hookConfig = params.delivery;
				if (!hookConfig || typeof hookConfig !== "object" || !("url" in hookConfig) || !("secret" in hookConfig)) {
					throw new Error("subscribe request omitted webhook URL or signing secret");
				}
				const callbackUrl = hookConfig.url;
				const secret = hookConfig.secret;
				if (typeof callbackUrl !== "string" || typeof secret !== "string")
					throw new Error("invalid webhook request values");
				const callbackPath = new URL(callbackUrl).pathname;
				const challenge = `challenge-${subscriptionCalls.length}`;
				const messageId = `challenge-id-${subscriptionCalls.length}`;
				const timestamp = String(Math.floor(Date.now() / 1_000));
				const body = JSON.stringify({ type: "verification", challenge });
				const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
					.update(`${messageId}.${timestamp}.${body}`)
					.digest("base64");
				const response = await fetch(`http://127.0.0.1:${listenPort}${callbackPath}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"X-MCP-Subscription-Id": `pending-${subscriptionCalls.length}`,
						"webhook-id": messageId,
						"webhook-timestamp": timestamp,
						"webhook-signature": `v1,${signature}`,
					},
					body,
				});
				webhookCalls.push(`${response.status}:${await response.text()}`);
				if (subscriptionCalls.length === 1) firstChallenge.resolve();
				if (subscriptionCalls.length === 2) secondChallenge.resolve();
				return {
					id: `webhook-${subscriptionCalls.length}`,
					cursor: `cursor-${subscriptionCalls.length}`,
					refreshBefore: new Date(Date.now() + 30_000).toISOString(),
				};
			},
		});
		const manager = new MCPManager(process.cwd());
		const firstCursor = Promise.withResolvers<void>();
		manager.setOnEvent(() => {});
		manager.setOnEventCursor((_name, _key, cursor) => {
			if (cursor === "cursor-1") firstCursor.resolve();
		});
		const oldSecret = process.env.MCP_EVENTS_CONTRACT_SECRET;
		process.env.MCP_EVENTS_CONTRACT_SECRET = CALLBACK_SECRET;
		vi.useFakeTimers();
		try {
			const webhookConfig = {
				type: "http" as const,
				url: server.url,
				events: {
					enabled: true,
					subscriptions: [
						{
							name: EVENT_NAME,
							mode: "webhook" as const,
							webhook: {
								callbackUrl: "https://callback.example.test/events/orders",
								secretRef: "$MCP_EVENTS_CONTRACT_SECRET",
								listenPort,
							},
						},
					],
				},
			} satisfies MCPServerConfig;
			await connect(manager, "webhook-server", webhookConfig);
			await firstChallenge.promise;
			expect(webhookCalls[0]?.startsWith("200:")).toBe(true);
			await firstCursor.promise;
			expect(subscriptionCalls).toHaveLength(1);
			await advanceTimers(1_000);
			await secondSubscription.promise;
			await secondChallenge.promise;
			await manager.stopEvents();
			expect(server.requests.some(request => request.method === "events/unsubscribe")).toBe(true);
		} finally {
			await manager.stopEvents();
			server.stop();
			vi.useRealTimers();
			if (oldSecret === undefined) delete process.env.MCP_EVENTS_CONTRACT_SECRET;
			else process.env.MCP_EVENTS_CONTRACT_SECRET = oldSecret;
		}
	});

	it("reports a missing webhook signing secret through subscription status", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);
		const server = fakeMcpServer({ delivery: "webhook" });
		const manager = new MCPManager(process.cwd());
		manager.setOnEvent(() => {});
		manager.setOnEventCursor(() => {});
		const serverName = "missing-secret-server";
		const subscriptionConfig: MCPServerEventSubscriptionConfig = {
			name: EVENT_NAME,
			mode: "webhook",
			webhook: {
				callbackUrl: "https://callback.example.test/events/orders",
				secretRef: "$MCP_EVENTS_CONTRACT_MISSING_SECRET",
				listenPort,
			},
		};
		const oldSecret = process.env.MCP_EVENTS_CONTRACT_MISSING_SECRET;
		delete process.env.MCP_EVENTS_CONTRACT_MISSING_SECRET;
		try {
			await connect(
				manager,
				serverName,
				managerConfig(server, { enabled: true, subscriptions: [subscriptionConfig] }),
			);
			await manager.stopEvents();
			const status = manager.getEventSubscriptionStatus(serverName, subscriptionConfig);
			expect(status?.status).toBe("failed");
			expect(status?.reason).toContain("MCP_EVENTS_CONTRACT_MISSING_SECRET");
		} finally {
			await manager.stopEvents();
			server.stop();
			if (oldSecret === undefined) delete process.env.MCP_EVENTS_CONTRACT_MISSING_SECRET;
			else process.env.MCP_EVENTS_CONTRACT_MISSING_SECRET = oldSecret;
		}
	});

	it("aborts delayed event listing during stopEvents and prevents post-shutdown start across all modes", async () => {
		const listGate = Promise.withResolvers<Record<string, unknown>>();
		const listRequested = Promise.withResolvers<void>();
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);

		const server = fakeMcpServer({
			delivery: ["poll", "push", "webhook"],
			eventsList: () => {
				listRequested.resolve();
				return listGate.promise;
			},
			poll: () => ({ events: [], cursor: "poll-cursor", hasMore: false, nextPollMs: 30_000 }),
			webhookSubscribe: async () => ({ id: "webhook-delayed", cursor: "wh-cursor", refreshBefore: null }),
		});

		const manager = new MCPManager(process.cwd());
		const onEvent = vi.fn();
		const onCursor = vi.fn();
		const serverName = "delayed-list-server";

		const subscriptions: MCPServerEventSubscriptionConfig[] = [
			{ name: "orders/poll", mode: "poll" },
			{ name: "orders/push", mode: "push" },
			{
				name: "orders/webhook",
				mode: "webhook",
				webhook: {
					callbackUrl: "https://callback.example.test/events/delayed",
					secretRef: "$MCP_EVENTS_DELAYED_SECRET",
					listenPort,
				},
			},
		];

		process.env.MCP_EVENTS_DELAYED_SECRET = CALLBACK_SECRET;

		try {
			await connect(manager, serverName, managerConfig(server, { enabled: true, subscriptions }));

			manager.setOnEvent(onEvent);
			manager.setOnEventCursor(onCursor);
			await listRequested.promise;
			const startupPromise = manager.getEventStartupPromise(serverName);

			await manager.stopEvents();
			listGate.resolve({
				events: [
					{ name: "orders/poll", description: "poll", inputSchema: { type: "object" }, delivery: ["poll"] },
					{ name: "orders/push", description: "push", inputSchema: { type: "object" }, delivery: ["push"] },
					{
						name: "orders/webhook",
						description: "webhook",
						inputSchema: { type: "object" },
						delivery: ["webhook"],
					},
				],
			});

			await startupPromise;
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			const subscriptionMethods = server.requests
				.map(r => r.method)
				.filter(m => m === "events/poll" || m === "events/stream" || m === "events/subscribe");
			expect(subscriptionMethods).toEqual([]);
			expect(onEvent).not.toHaveBeenCalled();
			expect(server.streamControllers).toHaveLength(0);
		} finally {
			await manager.stopEvents();
			server.stop();
			delete process.env.MCP_EVENTS_DELAYED_SECRET;
		}
	});

	it("aborts delayed event listing during disconnectServer and prevents post-disconnect start across all modes", async () => {
		const listGate = Promise.withResolvers<Record<string, unknown>>();
		const listRequested = Promise.withResolvers<void>();
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);

		const server = fakeMcpServer({
			delivery: ["poll", "push", "webhook"],
			eventsList: () => {
				listRequested.resolve();
				return listGate.promise;
			},
			poll: () => ({ events: [], cursor: "poll-cursor", hasMore: false, nextPollMs: 30_000 }),
			webhookSubscribe: async () => ({ id: "webhook-delayed", cursor: "wh-cursor", refreshBefore: null }),
		});

		const manager = new MCPManager(process.cwd());
		const onEvent = vi.fn();
		const onCursor = vi.fn();
		const serverName = "disconnect-delayed-list-server";

		const subscriptions: MCPServerEventSubscriptionConfig[] = [
			{ name: "orders/poll", mode: "poll" },
			{ name: "orders/push", mode: "push" },
			{
				name: "orders/webhook",
				mode: "webhook",
				webhook: {
					callbackUrl: "https://callback.example.test/events/delayed",
					secretRef: "$MCP_EVENTS_DELAYED_SECRET",
					listenPort,
				},
			},
		];

		process.env.MCP_EVENTS_DELAYED_SECRET = CALLBACK_SECRET;

		try {
			await connect(manager, serverName, managerConfig(server, { enabled: true, subscriptions }));

			manager.setOnEvent(onEvent);
			manager.setOnEventCursor(onCursor);
			await listRequested.promise;
			const startupPromise = manager.getEventStartupPromise(serverName);

			await manager.disconnectServer(serverName);
			listGate.resolve({
				events: [
					{ name: "orders/poll", description: "poll", inputSchema: { type: "object" }, delivery: ["poll"] },
					{ name: "orders/push", description: "push", inputSchema: { type: "object" }, delivery: ["push"] },
					{
						name: "orders/webhook",
						description: "webhook",
						inputSchema: { type: "object" },
						delivery: ["webhook"],
					},
				],
			});

			await startupPromise;
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			const subscriptionMethods = server.requests
				.map(r => r.method)
				.filter(m => m === "events/poll" || m === "events/stream" || m === "events/subscribe");
			expect(subscriptionMethods).toEqual([]);
			expect(onEvent).not.toHaveBeenCalled();
			expect(server.streamControllers).toHaveLength(0);
		} finally {
			await manager.stopEvents();
			server.stop();
			delete process.env.MCP_EVENTS_DELAYED_SECRET;
		}
	});
	it("does not arm a webhook refresh timer if disconnected while recording event cursor", async () => {
		const cursorGate = Promise.withResolvers<void>();
		const cursorStarted = Promise.withResolvers<void>();
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);

		const server = fakeMcpServer({
			delivery: ["webhook"],
			webhookSubscribe: async () => ({
				id: "webhook-refresh-race",
				cursor: "wh-cursor",
				refreshBefore: new Date(Date.now() + 600_000).toISOString(),
			}),
		});

		const manager = new MCPManager(process.cwd());
		const serverName = "cursor-race-server";
		process.env.MCP_EVENTS_RACE_SECRET = CALLBACK_SECRET;
		const realSetTimeout = globalThis.setTimeout;
		const refreshTimers: number[] = [];
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: Parameters<typeof globalThis.setTimeout>[0],
			delay?: number,
			...args: unknown[]
		) => {
			const handle = realSetTimeout(handler as () => void, delay, ...args);
			if (typeof delay === "number" && delay >= 500_000) {
				refreshTimers.push(delay);
				// Never let a leaked timer outlive the test.
				clearTimeout(handle);
			}
			return handle;
		}) as typeof setTimeout);

		try {
			await connect(
				manager,
				serverName,
				managerConfig(server, {
					enabled: true,
					subscriptions: [
						{
							name: EVENT_NAME,
							mode: "webhook",
							webhook: {
								callbackUrl: "https://callback.example.test/events/race",
								secretRef: "$MCP_EVENTS_RACE_SECRET",
								listenPort,
							},
						},
					],
				}),
			);

			manager.setOnEvent(vi.fn());
			manager.setOnEventCursor(async () => {
				cursorStarted.resolve();
				await cursorGate.promise;
			});

			await cursorStarted.promise;
			const disconnectPromise = manager.disconnectServer(serverName);
			cursorGate.resolve();
			await disconnectPromise;

			// The refresh timer is the only ~9 minute timer the manager arms. The startup promise is
			// deleted whether or not it was armed, so the armed delays are the observable contract.
			expect(refreshTimers).toEqual([]);
		} finally {
			await manager.stopEvents();
			server.stop();
			delete process.env.MCP_EVENTS_RACE_SECRET;
			setTimeoutSpy.mockRestore();
		}
	});

	it("drops invalid event occurrences with a warning and advances the poll cursor without wedging the loop", async () => {
		let pollCount = 0;
		const secondPollRequested = Promise.withResolvers<void>();
		const server = fakeMcpServer({
			delivery: ["poll"],
			poll: () => {
				pollCount++;
				if (pollCount === 1) {
					return {
						events: [
							{ ...event("mismatched-name", "cursor-0"), name: "other/unsubscribed-event" },
							event("valid-1", "cursor-1"),
						],
						cursor: "cursor-1",
						hasMore: true,
						nextPollMs: 100,
					};
				}
				secondPollRequested.resolve();
				return { events: [], cursor: "cursor-2", hasMore: false, nextPollMs: 30_000 };
			},
		});

		const manager = new MCPManager(process.cwd());
		const onEvent = vi.fn().mockResolvedValue("accepted");
		const onCursor = vi.fn();
		const serverName = "invalid-event-server";
		manager.setOnEvent(onEvent);
		manager.setOnEventCursor(onCursor);

		try {
			await connect(
				manager,
				serverName,
				managerConfig(server, {
					enabled: true,
					subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
				}),
			);

			await secondPollRequested.promise;

			expect(onEvent).toHaveBeenCalledTimes(1);
			expect(onEvent).toHaveBeenCalledWith(
				serverName,
				expect.objectContaining({ eventId: "valid-1", name: EVENT_NAME }),
				expect.any(String),
			);
			expect(onCursor).toHaveBeenCalledWith(serverName, expect.any(String), "cursor-1");
		} finally {
			await manager.stopEvents();
			server.stop();
		}
	});
	// WHY: the old setter aborted only future discovery, leaving an existing
	// event stream active without a consumer. Re-enrollment must create a new
	// stream rather than keeping a zombie subscription.
	it("clearing a live event handler cancels poll and push feeds and allows re-enrollment", async () => {
		for (const mode of ["poll", "push"] as const) {
			const firstStarted = Promise.withResolvers<void>();
			const secondStarted = Promise.withResolvers<void>();
			let starts = 0;
			const started = () => {
				starts++;
				if (starts === 1) firstStarted.resolve();
				if (starts === 2) secondStarted.resolve();
			};
			const server = fakeMcpServer({
				delivery: mode,
				poll: () => {
					started();
					return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
				},
				onStream: () => started(),
			});
			const manager = new MCPManager(process.cwd());
			const serverName = `clear-handler-${mode}`;
			manager.setOnEvent(() => {});
			manager.setOnEventCursor(() => {});
			try {
				await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
					enabled: true, subscriptions: [{ name: EVENT_NAME, mode }],
				})), `${mode} connection`);
				await withinHandlerChange(firstStarted.promise, `${mode} first subscription`);
				expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);

				manager.setOnEvent(undefined);
				expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
				if (mode === "push") {
					const cancelled = server.streamCancellations[0];
					if (!cancelled) throw new Error("Missing original push stream cancellation");
					await withinHandlerChange(cancelled, "old push stream cancellation");
				}

				manager.setOnEvent(() => {});
				await withinHandlerChange(secondStarted.promise, `${mode} renewed subscription`);
				expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
				expect(starts).toBe(2);
			} finally {
				await withinHandlerChange(manager.disconnectAll(), `${mode} manager cleanup`);
				server.stop();
			}
		}
	}, 30_000);

	// WHY: events/unsubscribe deletes by the canonical webhook tuple, not by
	// the old response ID. If re-enable sends a new subscribe while an older
	// unsubscribe is pending, the late removal deletes the fresh registration.
	it("waits for old webhook unsubscribe before re-enrolling the same callback", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);
		const unsubscribeEntered = Promise.withResolvers<void>();
		const releaseUnsubscribe = Promise.withResolvers<void>();
		const secondSubscription = Promise.withResolvers<void>();
		const firstCursor = Promise.withResolvers<void>();
		let unsubscribed = false;
		let subscribeCount = 0;
		const server = fakeMcpServer({
			delivery: "webhook",
			webhookSubscribe: async () => {
				subscribeCount++;
				if (subscribeCount === 2) {
					if (!unsubscribed) throw new Error("New webhook subscribed before prior key-based unsubscribe");
					secondSubscription.resolve();
				}
				return { id: `handler-clear-${subscribeCount}`, cursor: `cursor-${subscribeCount}`, refreshBefore: null };
			},
			webhookUnsubscribe: async () => {
				unsubscribeEntered.resolve();
				await releaseUnsubscribe.promise;
				unsubscribed = true;
				return {};
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEvent(() => {});
		manager.setOnEventCursor((_server, _key, cursor) => {
			if (cursor === "cursor-1") firstCursor.resolve();
		});
		const previousSecret = process.env.MCP_EVENTS_CONTRACT_SECRET;
		process.env.MCP_EVENTS_CONTRACT_SECRET = CALLBACK_SECRET;
		try {
			await withinHandlerChange(connect(manager, "reenroll-webhook", managerConfig(server, {
				enabled: true,
				subscriptions: [{
					name: EVENT_NAME, mode: "webhook",
					webhook: {
						callbackUrl: "https://callback.example.test/events/orders",
						secretRef: "$MCP_EVENTS_CONTRACT_SECRET",
						listenPort,
					},
				}],
			})), "initial webhook connection");
			await withinHandlerChange(firstCursor.promise, "initial webhook cursor");
			expect(manager.getActiveEventSubscriptionCount("reenroll-webhook")).toBe(1);
			manager.setOnEvent(undefined);
			await withinHandlerChange(unsubscribeEntered.promise, "outgoing webhook unsubscribe");
			manager.setOnEvent(() => {});
			// Confirm that the original key-based delete has not yet completed.
			// A second subscribe must only run once that delete is acknowledged.
			await delay(30);
			expect(server.requests.filter(request => request.method === "events/subscribe")).toHaveLength(1);
			releaseUnsubscribe.resolve();
			await withinHandlerChange(secondSubscription.promise, "webhook enrollment after unsubscribe");
			expect(subscribeCount).toBe(2);
			expect(unsubscribed).toBe(true);
			expect(manager.getActiveEventSubscriptionCount("reenroll-webhook")).toBe(1);
		} finally {
			releaseUnsubscribe.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "webhook re-enrollment cleanup");
			} finally {
				server.stop();
				if (previousSecret === undefined) delete process.env.MCP_EVENTS_CONTRACT_SECRET;
				else process.env.MCP_EVENTS_CONTRACT_SECRET = previousSecret;
			}
		}
	}, 20_000);


	// WHY: a single global handler-clear teardown barrier can block unrelated
	// event feeds behind a slow webhook unsubscribe. Distinct canonical keys
	// must re-enroll independently while the affected key waits for its old
	// unsubscribe. Synthetic loopback servers do not prove hosted MCP delivery.
	it("re-enrolls independent poll and webhook keys while a different unsubscribe is held", async () => {
		const slowName = EVENT_NAME;
		const independentName = "inventory/changed";
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);
		const initialSlow = Promise.withResolvers<void>();
		const initialIndependent = Promise.withResolvers<void>();
		const renewedSlow = Promise.withResolvers<void>();
		const renewedIndependent = Promise.withResolvers<void>();
		const initialPoll = Promise.withResolvers<void>();
		const renewedPoll = Promise.withResolvers<void>();
		const unsubscribeEntered = Promise.withResolvers<void>();
		const releaseUnsubscribe = Promise.withResolvers<void>();
		const subscriptions = new Map<string, number>();
		let polls = 0;
		const webhookServer = fakeMcpServer({
			delivery: "webhook",
			eventsList: async () => ({
				events: [slowName, independentName].map(name => ({
					name, description: "fake event", inputSchema: { type: "object" }, delivery: ["webhook"],
				})),
			}),
			webhookSubscribe: async params => {
				const name = String(params.name);
				const count = (subscriptions.get(name) ?? 0) + 1;
				subscriptions.set(name, count);
				return { id: "keyed-" + name + "-" + count, cursor: name + ":" + count, refreshBefore: null };
			},
			webhookUnsubscribe: async params => {
				if (params.name === slowName) {
					unsubscribeEntered.resolve();
					await releaseUnsubscribe.promise;
				}
				return {};
			},
		});
		const pollServer = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) initialPoll.resolve();
				if (polls === 2) renewedPoll.resolve();
				return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		const previousSecret = process.env.MCP_EVENTS_KEYED_SECRET;
		process.env.MCP_EVENTS_KEYED_SECRET = CALLBACK_SECRET;
		manager.setOnEvent(() => {});
		manager.setOnEventCursor((_server, _key, cursor) => {
			if (cursor === slowName + ":1") initialSlow.resolve();
			if (cursor === slowName + ":2") renewedSlow.resolve();
			if (cursor === independentName + ":1") initialIndependent.resolve();
			if (cursor === independentName + ":2") renewedIndependent.resolve();
		});
		try {
			await withinHandlerChange(manager.connectServers({
				"slow-webhooks": managerConfig(webhookServer, {
					enabled: true,
					subscriptions: [
						{ name: slowName, mode: "webhook", webhook: {
							callbackUrl: "https://callback.example.test/events/slow",
							secretRef: "$MCP_EVENTS_KEYED_SECRET",
							listenPort,
						} },
						{ name: independentName, mode: "webhook", webhook: {
							callbackUrl: "https://callback.example.test/events/independent",
							secretRef: "$MCP_EVENTS_KEYED_SECRET",
							listenPort,
						} },
					],
				}),
				"unrelated-poll": managerConfig(pollServer, {
					enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
				}),
			}, {}), "initial independent event connections");
			await withinHandlerChange(Promise.all([
				initialSlow.promise, initialIndependent.promise, initialPoll.promise,
			]), "initial three event subscriptions");
			expect(manager.getActiveEventSubscriptionCount()).toBe(3);

			manager.setOnEvent(undefined);
			expect(manager.getActiveEventSubscriptionCount()).toBe(0);
			await withinHandlerChange(unsubscribeEntered.promise, "old slow-key unsubscribe");
			manager.setOnEvent(() => {});
			// Neither the unrelated poll server nor the second webhook key
			// depends on the still-unacknowledged old slow-key unsubscribe.
			await withinHandlerChange(Promise.all([
				renewedIndependent.promise, renewedPoll.promise,
			]), "independent re-enrollment while old unsubscribe is unresolved");
			expect(subscriptions.get(slowName)).toBe(1);
			expect(subscriptions.get(independentName)).toBe(2);
			expect(polls).toBe(2);
			releaseUnsubscribe.resolve();
			await withinHandlerChange(renewedSlow.promise, "affected webhook after unsubscribe");
			expect(subscriptions.get(slowName)).toBe(2);
			expect(manager.getActiveEventSubscriptionCount()).toBe(3);
		} finally {
			releaseUnsubscribe.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "keyed event cleanup");
			} finally {
				webhookServer.stop();
				pollServer.stop();
				if (previousSecret === undefined) delete process.env.MCP_EVENTS_KEYED_SECRET;
				else process.env.MCP_EVENTS_KEYED_SECRET = previousSecret;
			}
		}
	}, 30_000);



	// WHY: setOnEvent(undefined) called by an in-flight callback previously
	// retained that callback's poll lifecycle in the same-key enrollment barrier.
	// A replacement handler awaited from that callback could never start. This
	// is a synthetic MCPManager/loopback repro, not Cloudflare or disk proof.
	it("allows a poll callback to clear and re-enable its own consumer without self-deadlock", async () => {
		const serverName = "reentrant-consumer-poll";
		const callbackCompleted = Promise.withResolvers<void>();
		const renewedPoll = Promise.withResolvers<void>();
		let polls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) {
					return {
						events: [event("reentrant-original", "stopped-event-cursor")],
						cursor: "stopped-page-cursor",
						hasMore: false,
						nextPollMs: 30_000,
					};
				}
				renewedPoll.resolve();
				return { events: [], cursor: "renewed-only", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		const recordedCursors: Array<string | null> = [];
		manager.setOnEventCursor((_name, _key, cursor) => recordedCursors.push(cursor));
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "reentrant-original") return;
			manager.setOnEvent(undefined);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			manager.setOnEvent(() => {});
			const nextStartup = manager.getEventStartupPromise(serverName);
			if (!nextStartup) throw new Error("Replacement MCP event startup was not registered");
			await withinHandlerChange(nextStartup, "reentrant poll replacement startup");
			callbackCompleted.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "reentrant poll initial connection");
			await withinHandlerChange(callbackCompleted.promise, "reentrant poll callback completion");
			await withinHandlerChange(renewedPoll.promise, "reentrant poll replacement request");
			expect(polls).toBe(2);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
			expect(recordedCursors).not.toContain("stopped-event-cursor");
			expect(recordedCursors).not.toContain("stopped-page-cursor");
		} finally {
			try {
				await withinHandlerChange(manager.disconnectAll(), "reentrant poll cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: bypassing every handler-clear processing barrier would fix the
	// callback deadlock but let an externally replaced handler start ahead of
	// the old pending acceptance. Preserve external draining as the control.
	it("externally replacing a poll consumer waits for its old in-flight acceptance", async () => {
		const serverName = "external-consumer-poll";
		const firstAcceptanceEntered = Promise.withResolvers<void>();
		const releaseFirstAcceptance = Promise.withResolvers<void>();
		const secondList = Promise.withResolvers<void>();
		const renewedPoll = Promise.withResolvers<void>();
		let polls = 0;
		let lists = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			eventsList: () => {
				lists++;
				if (lists === 2) secondList.resolve();
				return {
					events: [{ name: EVENT_NAME, description: "synthetic poll", inputSchema: { type: "object" }, delivery: ["poll"] }],
				};
			},
			poll: () => {
				polls++;
				if (polls === 1) {
					return {
						events: [event("external-original", "old-event-cursor")],
						cursor: "old-page-cursor",
						hasMore: false,
						nextPollMs: 30_000,
					};
				}
				renewedPoll.resolve();
				return { events: [], cursor: "renewed-only", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		const cursors: Array<string | null> = [];
		manager.setOnEventCursor((_name, _key, cursor) => cursors.push(cursor));
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId === "external-original") {
				firstAcceptanceEntered.resolve();
				await releaseFirstAcceptance.promise;
			}
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "external poll initial connection");
			await withinHandlerChange(firstAcceptanceEntered.promise, "old consumer acceptance");
			manager.setOnEvent(undefined);
			manager.setOnEvent(() => {});
			await withinHandlerChange(secondList.promise, "external replacement discovery");
			await delay(75); // Let the loopback server observe any wrongly premature poll request.
			expect(polls).toBe(1);
			releaseFirstAcceptance.resolve();
			await withinHandlerChange(renewedPoll.promise, "external poll after accepted callback drains");
			expect(polls).toBe(2);
			expect(cursors).not.toContain("old-event-cursor");
			expect(cursors).not.toContain("old-page-cursor");
		} finally {
			releaseFirstAcceptance.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "external replacement cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);


	// WHY: externally clearing the handler while a former callback is blocked
	// invalidates that callback's right to revive the old feed. Its subsequent
	// setter call must settle without making startup wait on the old lifecycle.
	it("does not let an obsolete callback re-enable after an external clear", async () => {
		const serverName = "external-clear-while-callback-pending";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const oldCompleted = Promise.withResolvers<void>();
		let polls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("obsolete-handler-event", "obsolete-event-cursor")],
					cursor: "obsolete-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		const persistedCursors: Array<string | null> = [];
		manager.setOnEventCursor((_name, _key, cursor) => persistedCursors.push(cursor));
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "obsolete-handler-event") return;
			oldEntered.resolve();
			await releaseOld.promise;
			// The external owner has already cleared this callback's epoch.
			// Do not create a fresh subscription or self-dependent startup.
			manager.setOnEvent(() => {});
			const startup = manager.getEventStartupPromise(serverName);
			if (startup) await withinHandlerChange(startup, "obsolete callback attempted re-enrollment");
			oldCompleted.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "initial external-clear poll server");
			await withinHandlerChange(oldEntered.promise, "in-flight obsolete callback");
			manager.setOnEvent(undefined);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			releaseOld.resolve();
			await withinHandlerChange(oldCompleted.promise, "obsolete callback completion");
			await delay(75);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			expect(polls).toBe(1);
			expect(persistedCursors).not.toContain("obsolete-event-cursor");
			expect(persistedCursors).not.toContain("obsolete-page-cursor");
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "obsolete callback cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: a callback belongs to the handler generation that started it. If
	// an external owner replaces the handler while this callback is waiting,
	// its late attempt to clear the consumer must not cancel the newer handler.
	it("does not let an obsolete callback clear an externally replaced consumer", async () => {
		const serverName = "external-replace-while-callback-pending";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const oldCompleted = Promise.withResolvers<void>();
		const freshDelivered = Promise.withResolvers<void>();
		let polls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("old-handler-event", "old-cursor")],
					cursor: "old-page-cursor", hasMore: true, nextPollMs: 0,
				};
				return {
					events: [event("new-handler-event", "fresh-cursor")],
					cursor: "fresh-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "old-handler-event") return;
			oldEntered.resolve();
			await releaseOld.promise;
			manager.setOnEvent(undefined);
			oldCompleted.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "initial external-replace poll server");
			await withinHandlerChange(oldEntered.promise, "old callback in flight");
			manager.setOnEvent((_name, occurrence) => {
				if (occurrence.eventId === "new-handler-event") freshDelivered.resolve();
			});
			releaseOld.resolve();
			await withinHandlerChange(oldCompleted.promise, "obsolete clear attempt");
			await withinHandlerChange(freshDelivered.promise, "new handler delivery");
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
			expect(polls).toBe(2);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "external-replace cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);


	// WHY: the generation fence prevents a stale callback from setting a
	// new handler, but an obsolete callback must not be able to stop the
	// externally installed successor through the async stopEvents entrypoint.
	// This synthetic poll test exercises the real manager, not a copied setter.
	it("does not let an obsolete callback stop a newer event consumer", async () => {
		const serverName = "stale-stop-while-new-consumer-active";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const staleStopSettled = Promise.withResolvers<void>();
		const successorDelivered = Promise.withResolvers<void>();
		let polls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("stale-stop-original", "original-cursor")],
					cursor: "original-page-cursor", hasMore: true, nextPollMs: 0,
				};
				if (polls === 2) return {
					events: [event("stale-stop-successor", "successor-cursor")],
					cursor: "successor-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "stale-stop-original") return;
			oldEntered.resolve();
			await releaseOld.promise;
			// This callback's handler revision was superseded externally.
			await manager.stopEvents();
			staleStopSettled.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "stale stop initial poll connection");
			await withinHandlerChange(oldEntered.promise, "obsolete callback entered");
			// Deliberately install the successor without clearing the feed. The
			// manager may continue the current subscription with the new callback.
			manager.setOnEvent((_name, occurrence) => {
				if (occurrence.eventId === "stale-stop-successor") successorDelivered.resolve();
			});
			releaseOld.resolve();
			await withinHandlerChange(staleStopSettled.promise, "obsolete stop settled");
			await withinHandlerChange(successorDelivered.promise, "successor event delivered");
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
			expect(polls).toBe(2);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "stale stop manager cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);


	// WHY: replacing an event consumer must also fence its cursor writer.
	// A paused obsolete callback can otherwise rebind persistence after the
	// current owner sets the authoritative successor callback. This drives
	// the real MCPManager with a disposable loopback poll server.
	it("does not let an obsolete callback replace a newer consumer's cursor writer", async () => {
		const serverName = "stale-cursor-after-event-replacement";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const staleSetterSettled = Promise.withResolvers<void>();
		const successorDelivered = Promise.withResolvers<void>();
		const successorCursorPersisted = Promise.withResolvers<void>();
		let polls = 0;
		let staleCursorWrites = 0;
		const successorCursors: Array<string | null> = [];
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("cursor-original", "original-occurrence-cursor")],
					cursor: "original-page-cursor", hasMore: true, nextPollMs: 0,
				};
				if (polls === 2) return {
					events: [event("cursor-successor", "successor-occurrence-cursor")],
					cursor: "successor-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "cursor-original") return;
			oldEntered.resolve();
			await releaseOld.promise;
			manager.setOnEventCursor(() => { staleCursorWrites++; });
			staleSetterSettled.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "stale cursor initial connection");
			await withinHandlerChange(oldEntered.promise, "obsolete cursor callback entered");
			manager.setOnEvent((_name, occurrence) => {
				if (occurrence.eventId === "cursor-successor") successorDelivered.resolve();
			});
			manager.setOnEventCursor((_name, _key, cursor) => {
				successorCursors.push(cursor);
				if (cursor === "successor-occurrence-cursor") successorCursorPersisted.resolve();
			});
			releaseOld.resolve();
			await withinHandlerChange(staleSetterSettled.promise, "obsolete cursor setter completed");
			await withinHandlerChange(successorDelivered.promise, "successor event delivery");
			await withinHandlerChange(successorCursorPersisted.promise, "successor durable cursor callback");
			expect(staleCursorWrites).toBe(0);
			expect(successorCursors).toContain("successor-occurrence-cursor");
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
			expect(polls).toBe(2);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "stale cursor manager cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);


	// WHY: an obsolete event callback can still run after a newer consumer is
	// installed. It must not overwrite the newer handler for durable gap and
	// termination controls. A poll with truncated=true exercises that real path.
	it("does not let an obsolete event callback replace the current gap-control handler", async () => {
		const serverName = "stale-control-writer";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const obsoleteSetterReturned = Promise.withResolvers<void>();
		const successorControlReceived = Promise.withResolvers<void>();
		let staleControls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => ({
				events: [event("control-original", "control-original-cursor")],
				cursor: "control-page-cursor",
				truncated: true,
				hasMore: false,
				nextPollMs: 30_000,
			}),
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEventControl(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "control-original") return;
			oldEntered.resolve();
			await releaseOld.promise;
			manager.setOnEventControl(() => { staleControls++; });
			obsoleteSetterReturned.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "stale control loopback connection");
			await withinHandlerChange(oldEntered.promise, "obsolete event callback entered");
			manager.setOnEvent(() => {});
			manager.setOnEventControl((_name, _key, control) => {
				if (control.type === "gap" && control.cursor === "control-page-cursor") {
					successorControlReceived.resolve();
				}
			});
			releaseOld.resolve();
			await withinHandlerChange(obsoleteSetterReturned.promise, "obsolete control setter returned");
			await withinHandlerChange(successorControlReceived.promise, "new consumer gap control");
			expect(staleControls).toBe(0);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "stale control manager cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: a stale callback must not replace a newer consumer's resume cursor
	// provider. A later re-enrollment must use the cursor that the new owner
	// supplied, not restart from the obsolete callback's saved position.
	it("does not let an obsolete event callback replace the current resume cursor provider", async () => {
		const serverName = "stale-resume-cursor-provider";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const obsoleteSetterReturned = Promise.withResolvers<void>();
		const successorPollStarted = Promise.withResolvers<void>();
		const requestedCursors: unknown[] = [];
		const server = fakeMcpServer({
			delivery: "poll",
			poll: params => {
				requestedCursors.push(params.cursor);
				if (requestedCursors.length === 1) return {
					events: [event("provider-original", "provider-original-event")],
					cursor: "provider-original-page", hasMore: false, nextPollMs: 30_000,
				};
				successorPollStarted.resolve();
				return { events: [], cursor: "provider-new-page", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setEventCursorProvider(() => "initial-resume-cursor");
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "provider-original") return;
			oldEntered.resolve();
			await releaseOld.promise;
			manager.setEventCursorProvider(() => "obsolete-resume-cursor");
			obsoleteSetterReturned.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "stale resume provider initial connection");
			await withinHandlerChange(oldEntered.promise, "obsolete resume provider callback entered");
			manager.setOnEvent(() => {});
			manager.setEventCursorProvider(() => "successor-resume-cursor");
			releaseOld.resolve();
			await withinHandlerChange(obsoleteSetterReturned.promise, "obsolete resume setter returned");
			manager.setOnEvent(undefined);
			manager.setOnEvent(() => {});
			await withinHandlerChange(successorPollStarted.promise, "new consumer poll after restart");
			expect(requestedCursors).toEqual(["initial-resume-cursor", "successor-resume-cursor"]);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "stale resume cursor manager cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: a bad callback URI was logged but the manager left an active event
	// subscription with no registration, retry or usable cursor. The consumer
	// must see an explicit failed state rather than a phantom live feed.
	it("refuses invalid webhook callbacks without leaving phantom active event subscriptions", async () => {
		const cases = [
			"not-a-webhook-url",
			"http://callback.example.test/events/unsafe",
			"https://user:password@callback.example.test/events/unsafe",
			"https://callback.example.test/events/unsafe#fragment",
		];
		const previousSecret = process.env.MCP_EVENTS_INVALID_CALLBACK_SECRET;
		process.env.MCP_EVENTS_INVALID_CALLBACK_SECRET = CALLBACK_SECRET;
		try {
			for (const [index, callbackUrl] of cases.entries()) {
				const server = fakeMcpServer({ delivery: "webhook" });
				const manager = new MCPManager(process.cwd());
				const serverName = `invalid-webhook-${index}`;
				const subscription = {
					name: EVENT_NAME,
					mode: "webhook" as const,
					webhook: {
						callbackUrl,
						secretRef: "$MCP_EVENTS_INVALID_CALLBACK_SECRET",
						listenPort: 0,
					},
				};
				manager.setOnEvent(() => {});
				manager.setOnEventCursor(() => {});
				try {
					await withinHandlerChange(
						connect(manager, serverName, managerConfig(server, {
							enabled: true, subscriptions: [subscription],
						})),
						`invalid callback ${index} server connection`,
					);
					const startup = manager.getEventStartupPromise(serverName);
					if (startup) await withinHandlerChange(startup, `invalid callback ${index} discovery`);
					expect(server.requests.some(request => request.method === "events/list")).toBe(true);
					expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
					expect(manager.getEventSubscriptionStatus(serverName, subscription)).toEqual({
						status: "failed",
						reason: expect.stringContaining("callback"),
					});
					expect(server.requests.some(request => request.method === "events/subscribe")).toBe(false);
				} finally {
					await withinHandlerChange(manager.disconnectAll(), `invalid callback ${index} cleanup`);
					server.stop();
				}
			}
		} finally {
			if (previousSecret === undefined) delete process.env.MCP_EVENTS_INVALID_CALLBACK_SECRET;
			else process.env.MCP_EVENTS_INVALID_CALLBACK_SECRET = previousSecret;
		}
	}, 30_000);


	// WHY: two distinct event configurations may supply one HTTPS callback
	// path. The second registration must be refused instead of remaining a
	// phantom active subscription or replacing the first verified route.
	it("keeps exactly one active webhook when different events claim the same callback path", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
		const listenPort = probe.port ?? 0;
		probe.stop(true);
		const names = [EVENT_NAME, "inventory/changed"];
		const server = fakeMcpServer({
			delivery: "webhook",
			eventsList: () => ({
				events: names.map(name => ({
					name,
					description: "fake callback event",
					inputSchema: { type: "object" },
					delivery: ["webhook"],
				})),
			}),
			webhookSubscribe: async params => ({
				id: `same-path-${String(params.name)}`,
				cursor: "accepted-one",
				refreshBefore: null,
			}),
		});
		const manager = new MCPManager(process.cwd());
		const callbackUrl = "https://callback.example.test/events/unique";
		const previousSecret = process.env.MCP_EVENTS_COLLIDING_CALLBACK_SECRET;
		process.env.MCP_EVENTS_COLLIDING_CALLBACK_SECRET = CALLBACK_SECRET;
		const accepted = Promise.withResolvers<void>();
		const subscriptions = names.map(name => ({
			name,
			mode: "webhook" as const,
			webhook: {
				callbackUrl,
				secretRef: "$MCP_EVENTS_COLLIDING_CALLBACK_SECRET",
				listenPort,
			},
		}));
		manager.setOnEvent(() => {});
		manager.setOnEventCursor(() => accepted.resolve());
		try {
			await withinHandlerChange(
				connect(manager, "colliding-callbacks", managerConfig(server, {
					enabled: true,
					subscriptions,
				})),
				"same-callback server connection",
			);
			await withinHandlerChange(accepted.promise, "first valid callback registration");
			let failures = subscriptions.map(subscription =>
				manager.getEventSubscriptionStatus("colliding-callbacks", subscription),
			);
			for (let i = 0; i < 50 && !failures.some(Boolean); i++) {
				await delay(20);
				failures = subscriptions.map(subscription =>
					manager.getEventSubscriptionStatus("colliding-callbacks", subscription),
				);
			}
			expect(failures.filter(Boolean)).toHaveLength(1);
			expect(failures.find(Boolean)?.reason).toContain("callback path");
			expect(manager.getActiveEventSubscriptionCount("colliding-callbacks")).toBe(1);
			expect(server.requests.filter(request => request.method === "events/subscribe")).toHaveLength(1);
		} finally {
			try {
				await withinHandlerChange(manager.disconnectAll(), "same-callback cleanup");
			} finally {
				server.stop();
				if (previousSecret === undefined) delete process.env.MCP_EVENTS_COLLIDING_CALLBACK_SECRET;
				else process.env.MCP_EVENTS_COLLIDING_CALLBACK_SECRET = previousSecret;
			}
		}
	}, 20_000);

	// WHY: stopEvents() is an external shutdown boundary, not just a local
	// subscription cancellation. A callback already in flight must not
	// repopulate the feed while an external stop awaits that callback's drain.
	// Gap: this synthetic poll contract does not exercise a live remote provider.
	it("does not let a callback resurrect event subscriptions during external stopEvents", async () => {
		const serverName = "external-stop-stale-consumer-restart";
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const oldSettled = Promise.withResolvers<void>();
		let polls = 0;
		let replacementDeliveries = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("stop-before-reenable", "old-occurrence-cursor")],
					cursor: "old-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				return {
					events: [event("should-not-restart", "new-occurrence-cursor")],
					cursor: "new-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "stop-before-reenable") return;
			oldEntered.resolve();
			await releaseOld.promise;
			manager.setOnEvent((_name, replacement) => {
				if (replacement.eventId === "should-not-restart") replacementDeliveries++;
			});
			const startup = manager.getEventStartupPromise(serverName);
			if (startup) await withinHandlerChange(startup, "obsolete restart after external stop");
			oldSettled.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "external-stop initial connection");
			await withinHandlerChange(oldEntered.promise, "external-stop original callback entered");
			const externalStop = manager.stopEvents();
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			releaseOld.resolve();
			await withinHandlerChange(oldSettled.promise, "old callback returned after external stop");
			await withinHandlerChange(externalStop, "external stop drained old callback");
			await delay(75);
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(0);
			expect(replacementDeliveries).toBe(0);
			expect(polls).toBe(1);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "external-stop test cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: the external stop fence cannot inadvertently prohibit a callback
	// deliberately stopping its own feed and starting a successor within
	// that same active callback scope. This keeps the existing self-stop path.
	it("lets the current callback deliberately restart after its own stopEvents", async () => {
		const serverName = "self-stop-then-restart";
		const restarted = Promise.withResolvers<void>();
		const secondDelivered = Promise.withResolvers<void>();
		let polls = 0;
		const server = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				polls++;
				if (polls === 1) return {
					events: [event("self-stop-original", "first-cursor")],
					cursor: "first-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				if (polls === 2) return {
					events: [event("self-stop-successor", "second-cursor")],
					cursor: "second-page-cursor", hasMore: false, nextPollMs: 30_000,
				};
				return { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (_name, occurrence) => {
			if (occurrence.eventId !== "self-stop-original") return;
			await withinHandlerChange(manager.stopEvents(), "callback-owned stopEvents");
			manager.setOnEvent((_name, replacement) => {
				if (replacement.eventId === "self-stop-successor") secondDelivered.resolve();
			});
			const startup = manager.getEventStartupPromise(serverName);
			if (startup) await withinHandlerChange(startup, "callback-owned restarted event subscription");
			restarted.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverName, managerConfig(server, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "self-stop initial connection");
			await withinHandlerChange(restarted.promise, "callback-owned stop and restart");
			await withinHandlerChange(secondDelivered.promise, "self-stop successor delivery");
			expect(manager.getActiveEventSubscriptionCount(serverName)).toBe(1);
			expect(polls).toBe(2);
		} finally {
			try {
				await withinHandlerChange(manager.disconnectAll(), "self-stop test cleanup");
			} finally {
				server.stop();
			}
		}
	}, 20_000);

	// WHY: a per-server disconnect waits for the old poll callback before it
	// removes the connection. That callback must not start a replacement feed on
	// the same server during the drain, while an unrelated server may still connect.
	// This synthetic loopback test cannot prove host-side socket recovery.
	it("does not re-enroll a disconnecting server while an unrelated event server continues", async () => {
		const oldEntered = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const oldSettled = Promise.withResolvers<void>();
		const independentDelivered = Promise.withResolvers<void>();
		const serverAName = "draining-event-server-A";
		const serverBName = "independent-event-server-B";
		let aPolls = 0;
		let bPolls = 0;
		const serverA = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				aPolls++;
				return aPolls === 1
					? { events: [event("A-in-flight", "A-original-cursor")], cursor: "A-original-page", hasMore: false, nextPollMs: 30_000 }
					: { events: [event("A-should-not-restart", "A-next-cursor")], cursor: "A-next-page", hasMore: false, nextPollMs: 30_000 };
			},
		});
		const serverB = fakeMcpServer({
			delivery: "poll",
			poll: () => {
				bPolls++;
				return bPolls === 1
					? { events: [event("B-unrelated", "B-cursor")], cursor: "B-page", hasMore: false, nextPollMs: 30_000 }
					: { events: [], cursor: null, hasMore: false, nextPollMs: 30_000 };
			},
		});
		const manager = new MCPManager(process.cwd());
		manager.setOnEventCursor(() => {});
		manager.setOnEvent(async (name, occurrence) => {
			if (name === serverBName && occurrence.eventId === "B-unrelated") {
				independentDelivered.resolve();
			}
			if (name !== serverAName || occurrence.eventId !== "A-in-flight") return;
			oldEntered.resolve();
			await releaseOld.promise;
			// The old connection is still in the manager while disconnect
			// waits for this very callback. Its attempted new subscription
			// must not reach events/poll after explicit disconnect began.
			manager.setOnEvent(() => {});
			const startup = manager.getEventStartupPromise(serverAName);
			if (startup) await withinHandlerChange(startup, "stale A restart during disconnect");
			oldSettled.resolve();
		});
		try {
			await withinHandlerChange(connect(manager, serverAName, managerConfig(serverA, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "A initial event connection");
			await withinHandlerChange(oldEntered.promise, "A original event callback");
			const disconnectA = manager.disconnectServer(serverAName);
			expect(manager.getActiveEventSubscriptionCount(serverAName)).toBe(0);
			await withinHandlerChange(connect(manager, serverBName, managerConfig(serverB, {
				enabled: true, subscriptions: [{ name: EVENT_NAME, mode: "poll" }],
			})), "B concurrent event connection");
			await withinHandlerChange(independentDelivered.promise, "independent B event delivery");
			releaseOld.resolve();
			await withinHandlerChange(oldSettled.promise, "A old callback released");
			await withinHandlerChange(disconnectA, "A disconnect completion");
			await delay(75);
			expect(aPolls).toBe(1);
			expect(manager.getActiveEventSubscriptionCount(serverAName)).toBe(0);
			expect(manager.getActiveEventSubscriptionCount(serverBName)).toBe(1);
			expect(bPolls).toBe(1);
		} finally {
			releaseOld.resolve();
			try {
				await withinHandlerChange(manager.disconnectAll(), "two-server disconnect race cleanup");
			} finally {
				serverA.stop();
				serverB.stop();
			}
		}
	}, 25_000);

});
