import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "../src/mcp/transports/http";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | undefined;
const controllers = new Map<string | number, ReadableStreamDefaultController<Uint8Array>>();

function notification(subscriptionId: string | number | undefined, marker: string): string {
	const metadata =
		subscriptionId === undefined ? {} : { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } };
	const occurrence = {
		eventId: marker,
		name: "events/test",
		timestamp: "2026-10-14T00:00:00.000Z",
		data: { marker },
		marker,
	};
	return `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/events/event", params: { ...occurrence, ...metadata } })}\n\n`;
}

function push(id: string | number, subscriptionId: string | number | undefined, marker: string): void {
	controllers.get(id)?.enqueue(encoder.encode(notification(subscriptionId, marker)));
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the HTTP stream contract");
		await Bun.sleep(1);
	}
}

afterEach(() => {
	for (const controller of controllers.values()) controller.close();
	controllers.clear();
	server?.stop(true);
	server = undefined;
});

describe("MCP Streamable HTTP streamRequest contract", () => {
	it("routes concurrent notifications by subscription id and drops unknown or missing ids", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = await request.json();
				if (!body || typeof body !== "object" || !("id" in body) || !("params" in body)) {
					return new Response("Invalid request", { status: 400 });
				}
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controllers.set(body.id as string | number, controller);
						controller.enqueue(encoder.encode(": open\n\n"));
					},
					cancel() {
						controllers.delete(body.id as string | number);
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const receivedA: string[] = [];
		const generalNotifications: Array<{ method: string; params: unknown }> = [];
		transport.onNotification = (method, params) => {
			generalNotifications.push({ method, params });
		};
		const receivedB: string[] = [];
		let allocatedA: string | number | undefined;
		let streamAId: string | number;
		const a = transport.streamRequest(
			"events/stream",
			{},
			message => {
				expect(allocatedA).toBe(streamAId);
				if (
					"params" in message &&
					message.params &&
					typeof message.params === "object" &&
					"marker" in message.params
				) {
					receivedA.push(String(message.params.marker));
				}
			},
			{
				onRequestId: id => {
					allocatedA = id;
				},
			},
		);
		streamAId = a.id;
		const b = transport.streamRequest("events/stream", {}, message => {
			if (
				"params" in message &&
				message.params &&
				typeof message.params === "object" &&
				"marker" in message.params
			) {
				receivedB.push(String(message.params.marker));
			}
		});
		try {
			await until(() => controllers.has(a.id) && controllers.has(b.id));
			controllers
				.get(a.id)
				?.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/events/list_changed" })}\n\n`,
					),
				);
			push(a.id, a.id, "a-only");
			push(a.id, b.id, "wrong-stream");
			push(a.id, "unknown-subscription", "unknown");
			push(a.id, undefined, "missing");
			push(b.id, b.id, "b-only");
			await until(() => receivedA.length === 1 && receivedB.length === 1 && generalNotifications.length === 1);
			expect(receivedA).toEqual(["a-only"]);
			expect(receivedB).toEqual(["b-only"]);
			expect(generalNotifications).toEqual([{ method: "notifications/events/list_changed", params: undefined }]);
		} finally {
			a.cancel();
			b.cancel();
			await Promise.all([a.done, b.done]);
			await transport.close();
		}
	});

	it("cancels only its own stream, settles done, and leaves the other stream receiving", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = await request.json();
				if (!body || typeof body !== "object" || !("id" in body))
					return new Response("Invalid request", { status: 400 });
				const id = body.id as string | number;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controllers.set(id, controller);
							controller.enqueue(encoder.encode(": open\n\n"));
						},
						cancel() {
							controllers.delete(id);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		const a = transport.streamRequest("events/stream", {}, () => receivedA.push("notification"));
		const b = transport.streamRequest("events/stream", {}, () => receivedB.push("notification"));
		try {
			await until(() => controllers.has(a.id) && controllers.has(b.id));
			a.cancel();
			await a.done;
			push(b.id, b.id, "b-after-cancel");
			await until(() => receivedB.length === 1);
			expect(receivedA).toEqual([]);
			expect(receivedB).toHaveLength(1);
			push(b.id, b.id, "b-still-active");
			await until(() => receivedB.length === 2);
			expect(receivedB).toHaveLength(2);
		} finally {
			b.cancel();
			await b.done;
			await transport.close();
		}
	});
	it("keeps an idle stream open beyond the configured request timeout", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(": open\n\n"));
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 10 });
		await transport.connect();
		let settled = false;
		const stream = transport.streamRequest("events/stream", {}, () => {}, { timeoutMs: 10 });
		void stream.done.then(() => {
			settled = true;
		});
		try {
			const idleStarted = performance.now();
			await until(() => settled || performance.now() >= idleStarted + 30);
			expect(settled).toBe(false);
		} finally {
			stream.cancel();
			await stream.done;
			await transport.close();
		}
	});

	it("settles done on a matching final JSON-RPC response while the SSE body stays open", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = await request.json();
				if (!body || typeof body !== "object" || !("id" in body))
					return new Response("Invalid request", { status: 400 });
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { accepted: true } })}\n\n`,
								),
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const stream = transport.streamRequest("events/stream", {}, () => {});
		try {
			await stream.done;
			expect(stream.id).toBeDefined();
		} finally {
			stream.cancel();
			await transport.close();
		}
	});

	it("preserves code and data from an initial JSON-RPC error response", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = await request.json();
				if (!body || typeof body !== "object" || !("id" in body))
					return new Response("Invalid request", { status: 400 });
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32041, message: "subscription denied", data: { reason: "disabled" } },
				});
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const stream = transport.streamRequest("events/stream", {}, () => {});
		try {
			await expect(stream.done).rejects.toMatchObject({ code: -32041, data: { reason: "disabled" } });
		} finally {
			stream.cancel();
			await transport.close();
		}
	});
});

function rawFrame(id: string | number, data: string): void {
	controllers.get(id)?.enqueue(encoder.encode(`data: ${data}\n\n`));
}

// WHY: A malformed member must not discard a valid batch notification or stop later frames; this covers invalid-frame recovery, but not every parser error shape.
describe("MCP HTTP stream invalid-frame handling", () => {
	it.each([
		["malformed JSON", "{not json"],
		["null JSON", "null"],
		["scalar JSON", "17"],
		[
			"invalid batch member",
			`[null,${JSON.stringify({ jsonrpc: "2.0", method: "notifications/events/event", params: { _meta: { "io.modelcontextprotocol/subscriptionId": "__stream_id__" }, marker: "after-invalid-member" } })}]`,
		],
	])("skips %s frames and continues delivering later valid notifications", async (name, invalidFrame) => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = await request.json();
				if (!body || typeof body !== "object" || !("id" in body))
					return new Response("Invalid request", { status: 400 });
				const id = body.id as string | number;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controllers.set(id, controller);
							controller.enqueue(encoder.encode(": open\n\n"));
						},
						cancel() {
							controllers.delete(id);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const received: string[] = [];
		const stream = transport.streamRequest("events/stream", {}, message => {
			if (
				"params" in message &&
				message.params &&
				typeof message.params === "object" &&
				"marker" in message.params
			) {
				received.push(String(message.params.marker));
			}
		});
		let doneSettled = false;
		void stream.done.then(
			() => {
				doneSettled = true;
			},
			() => {
				doneSettled = true;
			},
		);
		const expected =
			name === "invalid batch member"
				? ["before-invalid-frame", "after-invalid-member", "after-invalid-frame"]
				: ["before-invalid-frame", "after-invalid-frame"];
		try {
			await until(() => controllers.has(stream.id));
			push(stream.id, stream.id, "before-invalid-frame");
			rawFrame(stream.id, invalidFrame.replaceAll("__stream_id__", String(stream.id)));
			push(stream.id, stream.id, "after-invalid-frame");
			await until(() => received.length >= expected.length || doneSettled);
			expect(received).toEqual(expected);
			expect(doneSettled).toBe(false);
			push(stream.id, stream.id, "after-invalid-frame-and-check");
			await until(() => received.length >= expected.length + 1 || doneSettled);
			expect(received).toEqual([...expected, "after-invalid-frame-and-check"]);
			expect(doneSettled).toBe(false);
		} finally {
			stream.cancel();
			await stream.done.then(
				() => undefined,
				() => undefined,
			);
			await transport.close();
		}
	});
});
