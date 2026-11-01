import { afterEach, describe, expect, it, vi } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { logger } from "@veyyon/utils";
import { callMCP, parseSSE, redactUrlForLog } from "@veyyon/coding-agent/mcp/json-rpc";

describe("redactUrlForLog", () => {
	it("keeps the endpoint while removing untrusted URL credential and query values", () => {
		const redacted = redactUrlForLog("https://test-user:test-only-password@mcp.example.test/mcp?apiKey=TEST_ONLY_API&tenant=TEST_ONLY_TENANT&tenant=TEST_ONLY_SECOND#TEST_ONLY_FRAGMENT");
		expect(redacted).toBe("https://mcp.example.test/mcp");
		for (const marker of ["test-only-password", "TEST_ONLY_API", "TEST_ONLY_TENANT", "TEST_ONLY_SECOND", "TEST_ONLY_FRAGMENT"]) {
			expect(redacted).not.toContain(marker);
		}
	});

	it("does not reflect unparseable URLs that may themselves contain credentials", () => {
		expect(redactUrlForLog("TEST_ONLY_PRIVATE_PREFIX?apiKey=TEST_ONLY_TOKEN")).toBe("(invalid MCP URL)");
	});
});

describe("parseSSE", () => {
	it("skips non-JSON data lines (keep-alives) and returns the first JSON payload", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("returns null when nothing parses", () => {
		expect(parseSSE("data: ping\nnot json either")).toBeNull();
	});
});


// WHY: a failed MCP request is likely to contain private input and server output.
// The HTTP operation must preserve those bytes on the wire, but neither them
// nor an arbitrary status reason may be written to persistent diagnostics.
// Gap: this does not audit other MCP transports or secret-bearing URL paths.
const FAKE_PARAMETER = "TEST_ONLY_JSON_RPC_PRIVATE_ARGUMENT";
const FAKE_RESPONSE = "TEST_ONLY_PRIVATE_MALFORMED_RESPONSE";
const FAKE_STATUS = "TEST_ONLY_PRIVATE_HTTP_STATUS_REASON";
const FAKE_QUERY = "TEST_ONLY_PRIVATE_QUERY_VALUE";

afterEach(() => {
	vi.restoreAllMocks();
});

async function withinMcpFixture<T>(work: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 5_000);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withMcpFixture(
	handle: (req: IncomingMessage, res: ServerResponse) => void,
	run: (origin: string) => Promise<void>,
): Promise<void> {
	const server = createServer(handle);
	try {
		server.listen(0, "127.0.0.1");
		await withinMcpFixture(once(server, "listening"), "MCP loopback listener");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a loopback TCP port");
		await run("http://127.0.0.1:" + address.port);
	} finally {
		if (server.listening) {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections();
			await withinMcpFixture(closed, "MCP loopback cleanup");
		}
	}
}

describe("a failed direct MCP request keeps sensitive payloads out of logs", () => {
	it("does not log caller arguments, malformed response bytes, query values or status reason", async () => {
		const logged: string[] = [];
		vi.spyOn(logger, "error").mockImplementation((message, context) => {
			logged.push(JSON.stringify({ message, context }));
		});

		await withMcpFixture((req, res) => {
			if (req.url?.startsWith("/status")) {
				res.writeHead(503, FAKE_STATUS);
				res.end("upstream error");
			} else {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("not-json: " + FAKE_RESPONSE);
			}
		}, async origin => {
			const statusUrl = origin + "/status?tenant=" + FAKE_QUERY + "&tenant=TEST_ONLY_SECOND_QUERY";
			const statusMessage = await withinMcpFixture(
				callMCP(statusUrl, "tools/call", { payload: FAKE_PARAMETER }).then(
					() => { throw new Error("Expected 503 response to fail"); },
					(error: unknown) => error instanceof Error ? error.message : String(error),
				),
				"rejected MCP status",
			);
			expect(statusMessage).toContain("HTTP 503");
			expect(statusMessage).not.toContain(FAKE_STATUS);
			expect(statusMessage).not.toContain(FAKE_QUERY);
			await expect(withinMcpFixture(
				callMCP(origin + "/malformed", "tools/list", { payload: FAKE_PARAMETER }),
				"malformed MCP response",
			)).rejects.toThrow(/neither JSON nor a JSON-RPC SSE frame/);
		});

		expect(logged).toHaveLength(2);
		const diagnostics = logged.join("\n");
		for (const marker of [FAKE_PARAMETER, FAKE_RESPONSE, FAKE_STATUS, FAKE_QUERY, "TEST_ONLY_SECOND_QUERY"]) {
			expect(diagnostics).not.toContain(marker);
		}
		expect(diagnostics).toContain("HTTP 503");
		expect(diagnostics).toContain("Failed to parse MCP response");
	}, 20_000);

	it("still transmits the exact tool arguments and returns a valid JSON-RPC result", async () => {
		let received: { method: string; params: Record<string, unknown> } | undefined;
		await withMcpFixture((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", chunk => { body += chunk; });
			req.on("end", () => {
				const parsed = JSON.parse(body) as { id: string; method: string; params: Record<string, unknown> };
				received = { method: parsed.method, params: parsed.params };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { accepted: true } }));
			});
		}, async origin => {
			const result = await withinMcpFixture(callMCP(origin + "/success", "tools/call", {
				payload: FAKE_PARAMETER,
				nested: { retained: true },
			}), "successful MCP response");
			expect(result.result).toEqual({ accepted: true });
		});
		expect(received).toEqual({
			method: "tools/call",
			params: { payload: FAKE_PARAMETER, nested: { retained: true } },
		});
	}, 20_000);
});
