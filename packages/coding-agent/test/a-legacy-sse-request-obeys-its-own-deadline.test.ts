import { expect, it } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { LegacySseTransport } from "../src/mcp/transports/sse";

interface RequestSeen {
	id: string | number;
	method: string;
}

interface SseFixture {
	transport: LegacySseTransport;
	requestSeen: Promise<RequestSeen>;
	respond(id: string | number): void;
	close(): Promise<void>;
}

// WHY: the legacy SSE transport used the server-wide default even when a caller
// selected an explicit per-request deadline. These tests exercise real GET SSE +
// POST JSON-RPC and observe pending-request completion. They do not establish a
// live T3/ACP route or a physical provider's cancellation behavior.
async function within<T>(operation: Promise<T>, label: string, ms: number): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error("Fixture phase " + label + " did not finish within " + ms + "ms")),
		ms,
	);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function closeLoopback(server: Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	server.closeAllConnections();
	await within(closed.promise, "HTTP server close", 3_000);
}

async function startFixture(configuredTimeout: number): Promise<SseFixture> {
	let stream: ServerResponse | undefined;
	const requestSeen = Promise.withResolvers<RequestSeen>();
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method === "GET" && request.url === "/events") {
				stream = response;
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				response.write("event: endpoint\ndata: /messages\n\n");
				return;
			}
			if (request.method === "POST" && request.url === "/messages") {
				let body = "";
				for await (const chunk of request) {
					body += Buffer.from(chunk).toString("utf8");
					if (body.length > 64 * 1024) throw new Error("Synthetic request exceeded fixture bound");
				}
				const parsed: unknown = JSON.parse(body);
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("id" in parsed) ||
					(typeof parsed.id !== "number" && typeof parsed.id !== "string") ||
					!("method" in parsed) ||
					typeof parsed.method !== "string"
				) {
					throw new Error("Synthetic JSON-RPC request shape is invalid");
				}
				requestSeen.resolve({ id: parsed.id, method: parsed.method });
				response.writeHead(202).end();
				return;
			}
			response.writeHead(404).end();
		})().catch(() => {
			if (!response.headersSent) response.writeHead(400).end();
			else response.end();
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await within(listening.promise, "HTTP server listen", 3_000);
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeLoopback(server);
		throw new Error("Synthetic loopback listener has no port");
	}
	const transport = new LegacySseTransport({
		type: "sse",
		url: "http://127.0.0.1:" + address.port + "/events",
		timeout: configuredTimeout,
	});
	try {
		await within(transport.connect(), "legacy SSE endpoint handshake", 4_000);
	} catch (error) {
		await transport.close().catch(() => undefined);
		await closeLoopback(server);
		throw error;
	}

	return {
		transport,
		requestSeen: requestSeen.promise,
		respond(id) {
			if (!stream || stream.destroyed) throw new Error("Synthetic SSE stream is unavailable");
			const message = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "delivered" }] } };
			stream.write("event: message\ndata: " + JSON.stringify(message) + "\n\n");
		},
		async close() {
			try {
				await within(transport.close(), "transport close", 3_000);
			} finally {
				await closeLoopback(server);
			}
		},
	};
}

it("uses a shorter explicit deadline for a stalled legacy SSE request", async () => {
	const fixture = await startFixture(1_500);
	try {
		const request = fixture.transport.request("tools/call", { name: "held", arguments: {} }, { timeoutMs: 120 });
		void request.catch(() => undefined);
		expect((await within(fixture.requestSeen, "POST arrival", 1_000)).method).toBe("tools/call");
		const failure = await within(request, "explicit deadline", 800).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error("Expected explicit deadline rejection");
		expect(failure.message).toContain("120ms");
	} finally {
		await fixture.close();
	}
}, 12_000);

it("allows an explicitly deadline-free legacy SSE request to finish after the configured timeout", async () => {
	const fixture = await startFixture(600);
	try {
		const request = fixture.transport.request<{ content: Array<{ type: string; text: string }> }>(
			"tools/call",
			{ name: "delegated", arguments: {} },
			{ timeoutMs: 0 },
		);
		void request.catch(() => undefined);
		const seen = await within(fixture.requestSeen, "POST arrival", 1_000);
		expect(seen.method).toBe("tools/call");
		await sleep(850);
		fixture.respond(seen.id);
		expect(await within(request, "zero-deadline reply", 2_000)).toEqual({
			content: [{ type: "text", text: "delivered" }],
		});
	} finally {
		await fixture.close();
	}
}, 12_000);

it("retains the configured timeout when the legacy SSE caller gives no override", async () => {
	const fixture = await startFixture(500);
	try {
		const request = fixture.transport.request("tools/call", { name: "held", arguments: {} });
		void request.catch(() => undefined);
		expect((await within(fixture.requestSeen, "POST arrival", 1_000)).method).toBe("tools/call");
		await expect(within(request, "configured default timeout", 1_500)).rejects.toThrow("500ms");
	} finally {
		await fixture.close();
	}
}, 12_000);
