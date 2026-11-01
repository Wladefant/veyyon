import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { HttpTransport } from "../src/mcp/transports/http";

type JsonRpcReply = Record<string, unknown> | readonly unknown[];
interface Fixture {
	transport: HttpTransport;
	setReply(reply: (id: string | number) => JsonRpcReply): void;
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
			const reply = respond(call.id);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(reply));
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
});
