import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { HttpTransport } from "../src/mcp/transports/http";

type SSEFrame = unknown;

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 4_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withLiveSSE<T>(
	frames: SSEFrame[],
	run: (transport: HttpTransport) => Promise<T>,
): Promise<T> {
	const server: Server = createServer((request, response) => {
		if (request.method !== "GET" || request.url !== "/mcp") {
			response.writeHead(202).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		});
		for (const frame of frames) response.write("data: " + JSON.stringify(frame) + "\n\n");
		// Keep the real GET listener open; losing it before the valid frame is
		// delivered is a failure, not a normal end-of-stream.
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await bounded(listening.promise, "disposable SSE fixture listen");
	const address = server.address();
	if (!address || typeof address === "string") {
		server.closeAllConnections();
		server.close();
		throw new Error("Disposable SSE server did not bind an IPv4 loopback port");
	}
	const transport = new HttpTransport({
		type: "http",
		url: "http://127.0.0.1:" + address.port + "/mcp",
		timeout: 1_500,
	});
	try {
		await transport.connect();
		return await run(transport);
	} finally {
		try {
			await bounded(transport.close(), "client transport cleanup");
		} finally {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await bounded(closed.promise, "disposable SSE server close");
		}
	}
}

// WHY: persistent HTTP GET event listeners must validate *every* untrusted
// decoded SSE value. A null or scalar JSON frame must not crash the decoder
// and discard the legitimate notification queued behind it on the same socket.
// These are real HttpTransport callbacks over a disposable node:http server,
// not mocks of the production dispatch method.
describe("MCP persistent HTTP SSE frame validation", () => {
	it("skips null and scalar JSON frames while retaining a subsequent valid notification", async () => {
		await withLiveSSE(
			[
				null,
				42,
				{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "fixture" } },
			],
			async transport => {
				const received = Promise.withResolvers<void>();
				const notices: Array<{ method: string; params: unknown }> = [];
				const errors: string[] = [];
				transport.onError = error => errors.push(error.message);
				transport.onNotification = (method, params) => {
					notices.push({ method, params });
					received.resolve();
				};
				await bounded(transport.startSSEListener(), "SSE GET connection");
				await bounded(received.promise, "notification after malformed frames");
				expect(notices).toEqual([
					{ method: "notifications/tools/list_changed", params: { source: "fixture" } },
				]);
				expect(errors).toEqual([]);
			},
		);
	}, 15_000);

	it("never invokes a client request for invalid-version SSE batch elements", async () => {
		await withLiveSSE(
			[[
				{ jsonrpc: "1.0", id: 71, method: "sampling/createMessage", params: { ignored: true } },
				{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "batch" } },
				{ jsonrpc: "2.0", id: 72, method: "sampling/createMessage", params: { accepted: true } },
			]],
			async transport => {
				const gotNotification = Promise.withResolvers<void>();
				const gotRequest = Promise.withResolvers<void>();
				const requests: unknown[] = [];
				const notifications: unknown[] = [];
				transport.onNotification = (method, params) => {
					notifications.push({ method, params });
					gotNotification.resolve();
				};
				transport.onRequest = async (method, params) => {
					requests.push({ method, params });
					gotRequest.resolve();
					return { synthetic: true };
				};
				await bounded(transport.startSSEListener(), "SSE GET batch connection");
				await bounded(Promise.all([gotNotification.promise, gotRequest.promise]), "valid batch members");
				expect(requests).toEqual([
					{ method: "sampling/createMessage", params: { accepted: true } },
				]);
				expect(notifications).toEqual([
					{ method: "notifications/tools/list_changed", params: { source: "batch" } },
				]);
			},
		);
	}, 15_000);

	// A JSON-RPC batch contains flat message objects, not recursively nested
	// arrays. A malformed nested member must not reach callbacks, and ignoring
	// it must not discard a valid flat sibling or the next SSE event.
	it("rejects nested SSE batch envelopes without dropping valid later frames", async () => {
		const method = "notifications/tools/list_changed";
		await withLiveSSE(
			[
				[
					[[[{ jsonrpc: "2.0", method, params: { source: "nested-invalid" } }]]],
					{ jsonrpc: "2.0", method, params: { source: "flat-valid" } },
				],
				{ jsonrpc: "2.0", method, params: { source: "next-event" } },
			],
			async transport => {
				const received: Array<{ method: string; params: unknown }> = [];
				const errors: string[] = [];
				const nextEventReceived = Promise.withResolvers<void>();
				transport.onError = error => errors.push(error.message);
				transport.onNotification = (name, params) => {
					received.push({ method: name, params });
					if ((params as { source?: string })?.source === "next-event") nextEventReceived.resolve();
				};
				await bounded(transport.startSSEListener(), "SSE GET nested-batch connection");
				await bounded(nextEventReceived.promise, "notification after malformed nested batch");
				expect(received).toEqual([
					{ method, params: { source: "flat-valid" } },
					{ method, params: { source: "next-event" } },
				]);
				expect(errors).toEqual([]);
			},
		);
	}, 15_000);
});
