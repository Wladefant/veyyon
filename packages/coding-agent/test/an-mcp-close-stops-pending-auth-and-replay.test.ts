/**
 * WHY: closing legacy SSE cleared the deadline while auth still awaited a hook,
 * and retry argument rebuilding awaited outside both transport deadlines.
 * Real sockets exercise close, timeout and late continuation across both HTTP
 * transports. The external auth/rebuild promises deliberately cannot be canceled.
 */
import { describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import { HttpTransport, retainMCPToolArgsAttemptFactory } from "../src/mcp/transports/http";
import { LegacySseTransport } from "../src/mcp/transports/sse";

async function startServer(
	kind: "http" | "sse",
	timeout: number,
): Promise<{
	transport: HttpTransport | LegacySseTransport;
	posts: () => number;
	allowSuccess: () => void;
	fence: () => Promise<void>;
	stop: () => Promise<void>;
}> {
	let postCount = 0;
	let success = false;
	let stream: http.ServerResponse | undefined;
	const server = http.createServer(async (request, response) => {
		if (request.url === "/fence") {
			response.writeHead(204).end();
			return;
		}
		if (request.method === "GET") {
			stream = response;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write("event: endpoint\ndata: /messages\n\n");
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(204).end();
			return;
		}
		postCount++;
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		if (!success) {
			response.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}');
			return;
		}
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) throw new Error("missing request id");
		const message = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { resumed: true } });
		if (kind === "sse") {
			response.writeHead(202).end();
			stream?.write(`event: message\ndata: ${message}\n\n`);
		} else {
			response.writeHead(200, { "Content-Type": "application/json" }).end(message);
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not bind a port");
	const url = `http://127.0.0.1:${address.port}/mcp`;
	const transport =
		kind === "http"
			? new HttpTransport({ type: "http", url, timeout })
			: new LegacySseTransport({ type: "sse", url, timeout });
	return {
		transport,
		posts: () => postCount,
		allowSuccess: () => {
			success = true;
		},
		fence: async () => {
			const response = await fetch(`http://127.0.0.1:${address.port}/fence`);
			await response.body?.cancel();
		},
		stop: async () => {
			await transport.close();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			await closed.promise;
		},
	};
}

for (const kind of ["http", "sse"] as const) {
	describe(`${kind} pending auth lifecycle`, () => {
		it("close stops an unlimited pending auth call, suppresses late POST, and permits a fresh connection", async () => {
			const fixture = await startServer(kind, 0);
			const entered = Promise.withResolvers<void>();
			const refresh = Promise.withResolvers<Record<string, string> | null>();
			fixture.transport.onAuthError = () => {
				entered.resolve();
				return refresh.promise;
			};
			try {
				await fixture.transport.connect();
				const result = fixture.transport.request("tools/call", { name: "probe", arguments: {} });
				const settled = result.catch(error => error);
				await entered.promise;
				await fixture.transport.close();
				const error = await settled;
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("request did not reject on close");
				expect(error.message).toMatch(/closed|disconnected/);
				refresh.resolve({ Authorization: "Bearer late-fixture-token" });
				await fixture.fence();
				expect(fixture.posts()).toBe(1);
				fixture.allowSuccess();
				await fixture.transport.connect();
				expect(await fixture.transport.request<{ resumed: boolean }>("tools/list")).toEqual({ resumed: true });
			} finally {
				refresh.resolve(null);
				await fixture.stop();
			}
		}, 3000);

		it("deadline includes stalled retry arguments and a late rebuild never sends a second POST", async () => {
			const fixture = await startServer(kind, 40);
			const entered = Promise.withResolvers<void>();
			const rebuilt = Promise.withResolvers<Record<string, unknown>>();
			fixture.transport.onAuthError = async () => ({ Authorization: "Bearer refreshed-fixture-token" });
			const args = retainMCPToolArgsAttemptFactory({}, () => {
				entered.resolve();
				return rebuilt.promise;
			});
			try {
				await fixture.transport.connect();
				vi.useFakeTimers();
				const settled = fixture.transport
					.request("tools/call", { name: "probe", arguments: args })
					.catch(error => error);
				await entered.promise;
				vi.advanceTimersByTime(50);
				const error = await settled;
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("request did not reject at deadline");
				expect(error.message).toContain('did not complete request "tools/call" within 40ms');
				rebuilt.resolve({ rebuilt: true });
				await fixture.fence();
				expect(fixture.posts()).toBe(1);
			} finally {
				vi.useRealTimers();
				rebuilt.resolve({});
				await fixture.stop();
			}
		}, 3000);
	});
}
