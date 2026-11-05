import { describe, expect, it, spyOn } from "bun:test";
import { createServer, type Server } from "node:http";
import { logger } from "@veyyon/utils";
import { HttpTransport } from "../src/mcp/transports/http";

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 4_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withDisposableSSE<T>(
	payload: string,
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
		response.write("data: " + payload + "\n\n");
		// Keep the GET response open to test the actual reader, not EOF recovery.
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await bounded(listening.promise, "loopback SSE listen");
	const address = server.address();
	if (!address || typeof address === "string") {
		server.closeAllConnections();
		server.close();
		throw new Error("Failed to bind disposable SSE loopback");
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
			await bounded(transport.close(), "transport cleanup");
		} finally {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await bounded(closed.promise, "loopback server close");
		}
	}
}

// WHY: V8 JSON.parse SyntaxError text can quote *untrusted SSE data*. The
// persistent GET reader logs that error and passes it to onError; neither
// sink may receive fake peer bytes, even if the parser abandons that stream.
// This uses the actual HttpTransport, a real disposable HTTP server, and a
// logger spy placed BEFORE the malformed frame can arrive.
describe("MCP HTTP GET SSE malformed JSON diagnostics", () => {
	it("never forwards a malformed SSE frame fragment through logger or onError", async () => {
		const marker = "FAKE_PRIVATE_HTTP_SSE_FRAME_NEVER_LOG_987654321";
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			await withDisposableSSE(marker, async transport => {
				const errored = Promise.withResolvers<Error>();
				const observed: Error[] = [];
				transport.onError = error => {
					observed.push(error);
					errored.resolve(error);
				};
				await bounded(transport.startSSEListener(), "malformed SSE GET connection");
				const error = await bounded(errored.promise, "static SSE diagnostic");
				expect(observed).toHaveLength(1);
				expect(error.message).toBe("MCP HTTP SSE stream received malformed JSON");
				expect(error.stack ?? "").not.toContain("FAKE_PRIVA");
				expect(debug).toHaveBeenCalledWith("HTTP SSE stream error", {
					url: transport.url,
					error: "MCP HTTP SSE stream received malformed JSON",
				});
				expect(JSON.stringify(debug.mock.calls)).not.toContain("FAKE_PRIVA");
				expect(JSON.stringify(debug.mock.calls)).not.toContain(marker);
			});
		} finally {
			debug.mockRestore();
		}
	}, 15_000);

	it("still forwards ordinary well-formed notifications without an error", async () => {
		const json = JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: { from: "safe-fixture" },
		});
		await withDisposableSSE(json, async transport => {
			const notified = Promise.withResolvers<void>();
			const notices: unknown[] = [];
			const errors: Error[] = [];
			transport.onError = error => errors.push(error);
			transport.onNotification = (method, params) => {
				notices.push({ method, params });
				notified.resolve();
			};
			await bounded(transport.startSSEListener(), "valid SSE GET connection");
			await bounded(notified.promise, "valid SSE notification");
			expect(errors).toHaveLength(0);
			expect(notices).toEqual([
				{ method: "notifications/tools/list_changed", params: { from: "safe-fixture" } },
			]);
		});
	}, 15_000);
});
