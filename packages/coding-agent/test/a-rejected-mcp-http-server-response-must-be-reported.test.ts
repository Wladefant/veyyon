import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { logger } from "@veyyon/utils";
import { HttpTransport } from "../src/mcp/transports/http";

// WHY: HTTP rejections resolved fetch and silently dropped peer-request replies, including an auth retry.
// Exercise the real persistent GET dispatcher and response POST against a disposable server.
// This covers final HTTP acknowledgement, not network outages or legacy SSE transport.
afterEach(() => {
	for (const restore of restorers) restore();
	restorers.length = 0;
});
const restorers: Array<() => void> = [];

// Real HTTP I/O needs an independent deadline so silent response loss terminates.
// Fake clocks cannot advance socket completion; successful runs await the warning event without a delay.
async function bounded<T>(work: Promise<T>): Promise<T> {
	const limit = Promise.withResolvers<never>();
	const timer = setTimeout(() => limit.reject(new Error("MCP reply acknowledgement was not reported")), 2_000);
	try {
		return await Promise.race([work, limit.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("a rejected MCP HTTP server response is reported once", () => {
	for (const statuses of [[503], [401, 502]]) {
		it(`reports final HTTP ${statuses.at(-1)} after ${statuses.length} physical POSTs`, async () => {
			const warnings: Array<Record<string, unknown> | undefined> = [];
			const warned = Promise.withResolvers<void>();
			const spy = spyOn(logger, "warn").mockImplementation((message, fields) => {
				if (!message.startsWith("Could not deliver a response to an MCP server request")) return;
				warnings.push(fields);
				warned.resolve();
			});
			restorers.push(() => spy.mockRestore());
			const replies: unknown[] = [];
			let getStream: ServerResponse | undefined;
			const server = createServer((request, response) => {
				if (request.method === "GET") {
					getStream = response;
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "peer-reply", method: "roots/list" })}\n\n`);
					return;
				}
				if (request.method !== "POST") { response.writeHead(202).end(); return; }
				let body = "";
				request.setEncoding("utf8");
				request.on("data", chunk => { body += chunk; });
				request.on("end", () => {
					replies.push(JSON.parse(body));
					response.writeHead(statuses[replies.length - 1] ?? 500).end("fake-private-response-body");
				});
			});
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(0, "127.0.0.1", listening.resolve);
			await bounded(listening.promise);
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No loopback port");
			const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${address.port}/mcp`, timeout: 1_000 });
			let refreshes = 0;
			transport.onRequest = async () => ({ roots: [] });
			if (statuses.length > 1) transport.onAuthError = async () => { refreshes++; return {}; };
			try {
				await transport.connect();
				await bounded(warned.promise);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]).toMatchObject({ requestId: "peer-reply", responseKind: "result" });
				expect(String(warnings[0]?.error)).toContain(String(statuses.at(-1)));
				expect(JSON.stringify(warnings)).not.toContain("fake-private-response-body");
				expect(replies).toEqual(statuses.map(() => ({ jsonrpc: "2.0", id: "peer-reply", result: { roots: [] } })));
				expect(refreshes).toBe(statuses.length - 1);
			} finally {
				await transport.close();
				getStream?.destroy();
				server.closeAllConnections();
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				await closed.promise;
			}
		}, 10_000);
	}
});
