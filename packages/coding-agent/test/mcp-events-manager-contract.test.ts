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

});
