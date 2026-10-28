/**
 * WHY: a Streamable HTTP server binds every request after `initialize` to the session it assigned
 * in `Mcp-Session-Id`, and an operator's configured headers (auth, routing) must reach the server on
 * every request. The transport sends five kinds of request — a JSON-RPC request, a notification,
 * the answer to a server-to-client request, the SSE listener's GET and the closing DELETE — and each
 * once assembled its own headers. A kind that dropped the session id was rejected by the server
 * as sessionless; a kind that dropped the configured headers went out unauthenticated.
 *
 * The class closed: every request kind carries the configured headers and, once assigned, the
 * session id; POSTs carry the JSON-RPC content headers and a configured header replaces the
 * transport's own; the legacy SSE transport's POSTs carry the configured headers before and after
 * an auth refresh.
 *
 * WHAT IT DOES NOT CATCH: a request kind added to either transport is not swept; it joins this
 * table by hand. Header values the server rejects for other reasons are out of scope.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

interface Seen {
	kind: string;
	headers: Headers;
}

function sseFrame(message: unknown): Uint8Array {
	return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

describe("the Streamable HTTP transport", () => {
	it("sends the configured headers on every request kind and the assigned session on every one after it", async () => {
		const seen: Seen[] = [];
		const answered = Promise.withResolvers<void>();
		const listening = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					seen.push({ kind: "listen", headers: req.headers });
					listening.resolve();
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(": open\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (req.method === "DELETE") {
					seen.push({ kind: "close", headers: req.headers });
					return new Response(null, { status: 200 });
				}
				const body = (await req.json()) as { id?: string | number; method?: string };
				if (body.method === "initialize") {
					seen.push({ kind: "initialize", headers: req.headers });
					return Response.json(
						{ jsonrpc: "2.0", id: body.id, result: {} },
						{ headers: { "Mcp-Session-Id": "session-1" } },
					);
				}
				if (body.method === "tools/list") {
					seen.push({ kind: "request", headers: req.headers });
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(sseFrame({ jsonrpc: "2.0", id: "server-1", method: "ping" }));
							controller.enqueue(sseFrame({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
							controller.close();
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}
				if (body.method === undefined && body.id === "server-1") {
					seen.push({ kind: "answer", headers: req.headers });
					answered.resolve();
					return new Response(null, { status: 202 });
				}
				seen.push({ kind: "notify", headers: req.headers });
				return new Response(null, { status: 202 });
			},
		});

		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 2_000,
			headers: { "X-Route": "blue", "Content-Type": "application/json; charset=utf-8" },
		});
		transport.onRequest = async () => ({});
		await transport.connect();
		await transport.request("initialize");
		await transport.request("tools/list");
		await answered.promise;
		await transport.notify("notifications/initialized");
		await transport.startSSEListener();
		await listening.promise;
		await transport.close();

		expect(seen.map(s => s.kind)).toEqual(["initialize", "request", "answer", "notify", "listen", "close"]);
		for (const { kind, headers } of seen) {
			expect(headers.get("x-route"), kind).toBe("blue");
			expect(headers.get("mcp-session-id"), kind).toBe(kind === "initialize" ? null : "session-1");
		}
		const posts = seen.filter(s => s.kind !== "listen" && s.kind !== "close");
		for (const { kind, headers } of posts) {
			expect(headers.get("content-type"), kind).toBe("application/json; charset=utf-8");
			expect(headers.get("accept"), kind).toBe("application/json, text/event-stream");
		}
		expect(seen.find(s => s.kind === "listen")?.headers.get("accept")).toBe("text/event-stream");
	});
});

describe("the legacy HTTP+SSE transport", () => {
	it("sends the configured headers on a POST and the refreshed ones on its auth retry", async () => {
		const posts: Headers[] = [];
		let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				posts.push(req.headers);
				const body = (await req.json()) as { id: string | number };
				if (posts.length === 1) return new Response("expired", { status: 401 });
				stream?.enqueue(sseFrame({ jsonrpc: "2.0", id: body.id, result: {} }));
				return new Response(null, { status: 202 });
			},
		});

		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 2_000,
			headers: { Authorization: "Bearer stale", "X-Route": "blue" },
		});
		transport.onAuthError = async () => ({ Authorization: "Bearer fresh", "X-Route": "green" });
		await transport.connect();
		try {
			await transport.request("tools/list");
		} finally {
			await transport.close();
		}

		expect(posts.map(h => [h.get("authorization"), h.get("x-route"), h.get("content-type")])).toEqual([
			["Bearer stale", "blue", "application/json"],
			["Bearer fresh", "green", "application/json"],
		]);
	});
});
