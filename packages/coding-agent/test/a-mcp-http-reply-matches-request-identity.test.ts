import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { HttpTransport } from "../src/mcp/transports/http";

type JsonRpcReply = Record<string, unknown> | readonly unknown[];
interface Fixture {
	transport: HttpTransport;
	setReply(reply: (id: string | number) => JsonRpcReply): void;
	setFormat(format: "json" | "sse"): void;
	setSessionHeader(value: string | null): void;
	seenSessionHeaders(): readonly (string | null)[];
	close(): Promise<void>;
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 3_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function closeServer(server: Server): Promise<void> {
	const stopped = Promise.withResolvers<void>();
	server.close(error => (error ? stopped.reject(error) : stopped.resolve()));
	server.closeAllConnections();
	await bounded(stopped.promise, "HTTP fixture shutdown");
}

async function startFixture(): Promise<Fixture> {
	let respond: (id: string | number) => JsonRpcReply = id => ({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: "accepted" }] },
	});
	let format: "json" | "sse" = "json";
	let nextSessionHeader: string | null = null;
	const incomingSessionHeaders: Array<string | null> = [];
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST" || request.url !== "/mcp") {
				response.writeHead(404).end();
				return;
			}
			let text = "";
			for await (const chunk of request) {
				text += Buffer.from(chunk).toString("utf8");
				if (text.length > 64 * 1024) throw new Error("Fixture request exceeded bounded input");
			}
			const call: unknown = JSON.parse(text);
			if (
				!call ||
				typeof call !== "object" ||
				!("id" in call) ||
				(typeof call.id !== "number" && typeof call.id !== "string")
			) throw new Error("Fixture expected a JSON-RPC request id");
			const sessionHeader = request.headers["mcp-session-id"];
			incomingSessionHeaders.push(typeof sessionHeader === "string" ? sessionHeader : null);
			const reply = respond(call.id);
			const sessionHeaders = nextSessionHeader ? { "Mcp-Session-Id": nextSessionHeader } : {};
			if (format === "sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream", ...sessionHeaders });
				response.end("data: " + JSON.stringify(reply) + "\n\n");
			} else {
				response.writeHead(200, { "Content-Type": "application/json", ...sessionHeaders });
				response.end(JSON.stringify(reply));
			}
		})().catch(() => {
			if (!response.headersSent) response.writeHead(400).end();
			else response.end();
		});
	});
	const opened = Promise.withResolvers<void>();
	server.once("error", opened.reject);
	server.listen(0, "127.0.0.1", opened.resolve);
	await bounded(opened.promise, "HTTP fixture listen");
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeServer(server);
		throw new Error("HTTP fixture has no local port");
	}
	const transport = new HttpTransport({
		type: "http",
		url: "http://127.0.0.1:" + address.port + "/mcp",
		timeout: 1_500,
	});
	await transport.connect();
	return {
		transport,
		setReply(next) { respond = next; },
		setFormat(next) { format = next; },
		setSessionHeader(next) { nextSessionHeader = next; },
		seenSessionHeaders() { return incomingSessionHeaders.slice(); },
		async close() {
			try {
				await bounded(transport.close(), "HTTP transport close");
			} finally {
				await closeServer(server);
			}
		},
	};
}

// WHY: HTTP 200 is not proof that an MCP JSON-RPC tool result belongs to the
// request we sent. Drive the production HTTP transport with a real loopback
// server; mocks of the response parser cannot expose wrong-id attribution.
// Gap: synthetic loopback does not prove remote proxy or live T3 behavior.
describe("MCP HTTP JSON-RPC reply correlation", () => {
	it("refuses stale, missing, null and wrong-type reply ids without returning tool results", async () => {
		const fixture = await startFixture();
		try {
			const marker = "FAKE_PRIVATE_RESULT_MUST_NOT_BE_LOGGED";
			const invalid: Array<[string, (id: string | number) => JsonRpcReply]> = [
				["stale", id => ({ jsonrpc: "2.0", id: String(id) + "-stale", result: { marker } })],
				["missing", () => ({ jsonrpc: "2.0", result: { marker } })],
				["null", () => ({ jsonrpc: "2.0", id: null, result: { marker } })],
				["wrong type", () => ({ jsonrpc: "2.0", id: 1, result: { marker } })],
			];
			for (const [label, reply] of invalid) {
				fixture.setReply(reply);
				const failure = await bounded(
					fixture.transport.request("tools/call", { name: label, arguments: {} }),
					label + " reply",
				).then(() => undefined, (error: unknown) => error);
				expect(failure).toBeInstanceOf(Error);
				if (!(failure instanceof Error)) throw new Error(label + " did not reject");
				expect(failure.message).toContain("JSON-RPC response");
				expect(failure.message).not.toContain(marker);
			}
		} finally {
			await fixture.close();
		}
	}, 20_000);

	it("rejects a wrong JSON-RPC version and non-object response without reading result data", async () => {
		const fixture = await startFixture();
		try {
			for (const reply of [
				(id: string | number): JsonRpcReply => ({ jsonrpc: "1.0", id, result: { accepted: false } }),
				(_id: string | number): JsonRpcReply => [1, 2, 3],
			]) {
				fixture.setReply(reply);
				await expect(bounded(fixture.transport.request("tools/list"), "invalid protocol response")).rejects.toThrow(
					"JSON-RPC response",
				);
			}
		} finally {
			await fixture.close();
		}
	}, 12_000);

	it("accepts a matching reply after rejecting a stale reply on the same transport", async () => {
		const fixture = await startFixture();
		try {
			fixture.setReply(id => ({ jsonrpc: "2.0", id: String(id) + "-other", result: { value: "wrong" } }));
			await expect(bounded(fixture.transport.request("tools/list"), "stale first reply")).rejects.toThrow(
				"JSON-RPC response",
			);
			fixture.setReply(id => ({
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: "accepted" }] },
			}));
			await expect(bounded(fixture.transport.request("tools/list"), "matching next reply")).resolves.toEqual({
				content: [{ type: "text", text: "accepted" }],
			});
		} finally {
			await fixture.close();
		}
	}, 12_000);

	// WHY: a matching request id alone does not make an envelope a result.
	// Missing or malformed result/error branches used to return undefined success.
	it("rejects matching-id responses without exactly one valid result or error", async () => {
		const fixture = await startFixture();
		try {
			const malformed: Array<[string, (id: string | number) => JsonRpcReply]> = [
				["neither", id => ({ jsonrpc: "2.0", id })],
				["both", id => ({ jsonrpc: "2.0", id, result: { accepted: false }, error: { code: -32603, message: "failed" } })],
				["null error", id => ({ jsonrpc: "2.0", id, error: null })],
				["string error", id => ({ jsonrpc: "2.0", id, error: "not an error object" })],
				["invalid error code", id => ({ jsonrpc: "2.0", id, error: { code: "-32603", message: "failed" } })],
				["missing error message", id => ({ jsonrpc: "2.0", id, error: { code: -32603 } })],
			];
			for (const [name, reply] of malformed) {
				fixture.setReply(reply);
				await expect(bounded(fixture.transport.request("tools/list"), "malformed " + name)).rejects.toThrow(
					"JSON-RPC response",
				);
			}
		} finally {
			await fixture.close();
		}
	}, 25_000);

	it("preserves null success and a valid server error on the same HTTP transport", async () => {
		const fixture = await startFixture();
		try {
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: null }));
			await expect(bounded(fixture.transport.request("tools/list"), "null success")).resolves.toBeNull();
			fixture.setReply(id => ({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "Synthetic method unavailable" },
			}));
			await expect(bounded(fixture.transport.request("tools/list"), "valid server error")).rejects.toThrow(
					"MCP error -32601: Synthetic method unavailable",
			);
		} finally {
			await fixture.close();
		}
	}, 12_000);

	// WHY: HTTP event-stream request ACKs also use JSON-RPC 2.0 envelopes.
	// Verifying the id without the version/result-error shape can accept a
	// stale or malformed envelope as successful subscription establishment.
	it("refuses invalid JSON event-stream acknowledgements despite HTTP 200 and a matching id", async () => {
		const fixture = await startFixture();
		try {
			const invalid: Array<[string, (id: string | number) => JsonRpcReply]> = [
				["wrong version", id => ({ jsonrpc: "1.0", id, result: {} })],
				["no result", id => ({ jsonrpc: "2.0", id })],
				["both result and error", id => ({
					jsonrpc: "2.0", id, result: {}, error: { code: -32603, message: "failed" },
				})],
				["null error", id => ({ jsonrpc: "2.0", id, error: null })],
				["wrong id", id => ({ jsonrpc: "2.0", id: String(id) + "-stale", result: {} })],
				["nonobject array", () => [1, 2, 3]],
			];
			for (const [name, response] of invalid) {
				fixture.setReply(response);
				const stream = fixture.transport.streamRequest("events/subscribe", { name }, () => {});
				await expect(bounded(stream.done, "invalid stream ACK " + name)).rejects.toThrow(
					"MCP event stream response",
				);
			}
		} finally {
			await fixture.close();
		}
	}, 25_000);

	it("accepts a correlated JSON event-stream result and preserves a valid server error", async () => {
		const fixture = await startFixture();
		let notifications = 0;
		try {
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { accepted: true } }));
			const good = fixture.transport.streamRequest("events/subscribe", {}, () => { notifications++; });
			await expect(bounded(good.done, "valid JSON stream ACK")).resolves.toBeUndefined();
			expect(notifications).toBe(0);
			fixture.setReply(id => ({
				jsonrpc: "2.0", id, error: { code: -32601, message: "Synthetic stream method unavailable" },
			}));
			const failed = fixture.transport.streamRequest("events/subscribe", {}, () => { notifications++; });
			await expect(bounded(failed.done, "JSON stream error")).rejects.toThrow(
					"MCP error -32601: Synthetic stream method unavailable",
			);
		} finally {
			await fixture.close();
		}
	}, 12_000);


	// WHY: MCP HTTP POST can return JSON-RPC results in text/event-stream.
	// A correct id alone must never validate the wrong JSON-RPC version,
	// multiple union arms or a malformed error, even when HTTP is 200.
	// This local fixture tests the real transport without remote MCP access.
	it("rejects malformed correlated SSE response envelopes without accepting tool results", async () => {
		const fixture = await startFixture();
		fixture.setFormat("sse");
		try {
			const invalid: Array<[string, (id: string | number) => JsonRpcReply]> = [
				["wrong version", id => ({ jsonrpc: "1.0", id, result: { untrusted: true } })],
				["both arms", id => ({ jsonrpc: "2.0", id, result: {}, error: { code: -32603, message: "fake" } })],
				["neither arm", id => ({ jsonrpc: "2.0", id })],
				["malformed error", id => ({ jsonrpc: "2.0", id, error: { code: "bad", message: "untrusted" } })],
				["null error", id => ({ jsonrpc: "2.0", id, error: null })],
			];
			for (const [label, response] of invalid) {
				fixture.setReply(response);
				const failure = await bounded(
					fixture.transport.request("tools/list", { selector: label }),
					"malformed SSE reply " + label,
				).then(() => undefined, (error: unknown) => error);
				expect(failure).toBeInstanceOf(Error);
				if (!(failure instanceof Error)) throw new Error(label + " was accepted");
				expect(failure.message).toContain("MCP HTTP SSE response");
				expect(failure.message).not.toContain("untrusted");
			}
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { accepted: true } }));
			await expect(bounded(fixture.transport.request("tools/list"), "valid SSE recovery")).resolves.toEqual({
				accepted: true,
			});
		} finally {
			await fixture.close();
		}
	}, 25_000);

	it("skips uncorrelated invalid SSE frames and still handles notifications and a valid reply", async () => {
		const fixture = await startFixture();
		fixture.setFormat("sse");
		const received: Array<{ method: string; params: unknown }> = [];
		fixture.transport.onNotification = (method, params) => received.push({ method, params });
		try {
			fixture.setReply(id => [
				null,
				{ jsonrpc: "2.0", method: "notifications/test", params: { message: "synthetic" } },
				{ jsonrpc: "2.0", id, result: { content: ["ok"] } },
			]);
			await expect(bounded(fixture.transport.request("tools/list"), "SSE notification with reply")).resolves.toEqual({
				content: ["ok"],
			});
			expect(received).toEqual([{ method: "notifications/test", params: { message: "synthetic" } }]);
		} finally {
			await fixture.close();
		}
	}, 12_000);

	it("preserves the correlated SSE server-error rejection path", async () => {
		const fixture = await startFixture();
		fixture.setFormat("sse");
		try {
			fixture.setReply(id => ({
				jsonrpc: "2.0", id, error: { code: -32601, message: "Synthetic SSE method unavailable" },
			}));
			await expect(bounded(fixture.transport.request("tools/list"), "valid SSE error")).rejects.toThrow(
				"MCP error -32601: Synthetic SSE method unavailable",
			);
		} finally {
			await fixture.close();
		}
	}, 12_000);



	// WHY: an unverified JSON-RPC initialization reply cannot assign the
	// MCP session used to identify all later requests. Header custody requires
	// an actual correlated successful initialization response, not HTTP 200.
	it("does not retain a session header from an invalid initialization response", async () => {
		const fixture = await startFixture();
		try {
			fixture.setSessionHeader("unrelated-session");
			fixture.setReply(id => ({ jsonrpc: "2.0", id: String(id) + "-wrong", result: { capabilities: {} } }));
			await expect(bounded(fixture.transport.request("initialize"), "invalid initialization id")).rejects.toThrow(
				"JSON-RPC response",
			);
			fixture.setSessionHeader(null);
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { tools: [] } }));
			await expect(bounded(fixture.transport.request("tools/list"), "request after invalid init")).resolves.toEqual({
				tools: [],
			});
			expect(fixture.seenSessionHeaders()).toEqual([null, null]);
		} finally {
			await fixture.close();
		}
	}, 12_000);

	it("accepts a verified initialization session but ignores tool-reply header rotation", async () => {
		const fixture = await startFixture();
		const initialization = {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "fixture", version: "1" },
		};
		try {
			fixture.setSessionHeader("accepted-session");
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: initialization }));
			await expect(bounded(fixture.transport.request("initialize"), "verified initialization")).resolves.toEqual(
				initialization,
			);
			fixture.setSessionHeader("different-session");
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { tools: [] } }));
			await expect(bounded(fixture.transport.request("tools/list"), "ordinary tool reply")).resolves.toEqual({
				tools: [],
			});
			fixture.setSessionHeader(null);
			await bounded(fixture.transport.request("tools/list"), "subsequent tool request");
			expect(fixture.seenSessionHeaders()).toEqual([null, "accepted-session", "accepted-session"]);
		} finally {
			await fixture.close();
		}
	}, 12_000);

	it("refuses non-visible-ASCII initialization session ids without persisting them", async () => {
		const fixture = await startFixture();
		try {
			fixture.setSessionHeader("bad session");
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { capabilities: {} } }));
			await expect(bounded(fixture.transport.request("initialize"), "invalid session header")).rejects.toThrow(
				"MCP initialization response has invalid session identifier",
			);
			fixture.setSessionHeader(null);
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { tools: [] } }));
			await bounded(fixture.transport.request("tools/list"), "tool after invalid header");
			expect(fixture.seenSessionHeaders()).toEqual([null, null]);
		} finally {
			await fixture.close();
		}
	}, 12_000);

	it("accepts a correlated SSE initialization session and ignores subscription ACK header changes", async () => {
		const fixture = await startFixture();
		const initialization = {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "fixture", version: "1" },
		};
		try {
			fixture.setFormat("sse");
			fixture.setSessionHeader("sse-session");
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: initialization }));
			await expect(bounded(fixture.transport.request("initialize"), "correlated SSE initialize")).resolves.toEqual(
				initialization,
			);
			fixture.setFormat("json");
			fixture.setSessionHeader("hijacked-subscription");
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { accepted: true } }));
			const subscribe = fixture.transport.streamRequest("events/subscribe", {}, () => {});
			await expect(bounded(subscribe.done, "subscription with session header")).resolves.toBeUndefined();
			fixture.setSessionHeader(null);
			fixture.setReply(id => ({ jsonrpc: "2.0", id, result: { tools: [] } }));
			await bounded(fixture.transport.request("tools/list"), "request after subscribe");
			expect(fixture.seenSessionHeaders()).toEqual([null, "sse-session", "sse-session"]);
		} finally {
			await fixture.close();
		}
	}, 15_000);

});
