import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | undefined;
const controllers = new Map<string | number, ReadableStreamDefaultController<Uint8Array>>();

function notification(subscriptionId: string | number | undefined, marker: string): string {
	const params = subscriptionId === undefined ? {} : { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } };
	return `data: ${JSON.stringify({ jsonrpc: "2.0", method: "events/changed", params: { ...params, marker } })}\n\n`;
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
		const receivedB: string[] = [];
		const a = transport.streamRequest("events/subscribe", {}, message => {
			if ("params" in message && message.params && typeof message.params === "object" && "marker" in message.params) {
				receivedA.push(String(message.params.marker));
			}
		});
		const b = transport.streamRequest("events/subscribe", {}, message => {
			if ("params" in message && message.params && typeof message.params === "object" && "marker" in message.params) {
				receivedB.push(String(message.params.marker));
			}
		});
		try {
			await until(() => controllers.has(a.id) && controllers.has(b.id));
			push(a.id, a.id, "a-only");
			push(a.id, b.id, "wrong-stream");
			push(a.id, "unknown-subscription", "unknown");
			push(a.id, undefined, "missing");
			push(b.id, b.id, "b-only");
			await until(() => receivedA.length === 1 && receivedB.length === 1);
			expect(receivedA).toEqual(["a-only"]);
			expect(receivedB).toEqual(["b-only"]);
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
				if (!body || typeof body !== "object" || !("id" in body)) return new Response("Invalid request", { status: 400 });
				const id = body.id as string | number;
				return new Response(new ReadableStream<Uint8Array>({
					start(controller) {
						controllers.set(id, controller);
						controller.enqueue(encoder.encode(": open\n\n"));
					},
					cancel() { controllers.delete(id); },
				}), { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 1_000 });
		await transport.connect();
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		const a = transport.streamRequest("events/subscribe", {}, () => receivedA.push("notification"));
		const b = transport.streamRequest("events/subscribe", {}, () => receivedB.push("notification"));
		try {
			await until(() => controllers.has(a.id) && controllers.has(b.id));
			a.cancel();
			await a.done;
			
			push(a.id, a.id, "after-cancel");
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
});
