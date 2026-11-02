import { describe, expect, it } from "bun:test";
import { StdioTransport } from "../src/mcp/transports/stdio";

// Only the external peer is synthetic; the owned stdio parser and callback
// dispatcher are exercised through a real StdioTransport subprocess.
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + label)), 5_000);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function createPeer(frames: unknown[]): StdioTransport {
	const program = [
		"const frames = " + JSON.stringify(frames) + ";",
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', chunk => {",
		"  input += chunk;",
		"  while (true) {",
		"    const index = input.indexOf('\\n');",
		"    if (index < 0) break;",
		"    const line = input.slice(0, index);",
		"    input = input.slice(index + 1);",
		"    const request = JSON.parse(line);",
		"    if (request.method !== 'tools/list') continue;",
		"    for (const frame of frames) process.stdout.write(JSON.stringify(frame) + '\\n');",
		"    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, result:{tools:[]} }) + '\\n');",
		"  }",
		"});",
	].join("\n");
	return new StdioTransport({ type: "stdio", command: process.execPath, args: ["--eval", program] });
}

describe("MCP stdio inbound peer method envelopes", () => {
	it("does not deliver malformed server requests or notifications from a mixed batch", async () => {
		const transport = createPeer([[
			{ jsonrpc: "1.0", id: 31, method: "sampling/createMessage", params: {} },
			{ jsonrpc: "2.0", id: 32, method: 42, params: {} },
			{ jsonrpc: "2.0", id: 33, method: "roots/list", params: [] },
			{ jsonrpc: "2.0", id: 34, method: "roots/list", params: null },
			{ jsonrpc: "2.0", id: null, method: "roots/list", params: {} },
			{ jsonrpc: "2.0", id: 35, method: "roots/list", result: {} },
			// An invalid method-bearing id:null hybrid must not fail pending client requests.
			{ jsonrpc: "2.0", id: null, method: "roots/list", error: { code: -32700, message: "synthetic" } },
			{ jsonrpc: "1.0", method: "notifications/tools/list_changed", params: {} },
			{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: [] },
			{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "valid" } },
			{ jsonrpc: "2.0", id: 0, method: "roots/list", params: { source: "valid" } },
		]]);
		const requests: Array<{ method: string; params: unknown }> = [];
		const notifications: Array<{ method: string; params: unknown }> = [];
		const gotRequest = Promise.withResolvers<void>();
		const gotNotification = Promise.withResolvers<void>();
		transport.onRequest = async (method, params) => {
			requests.push({ method, params });
			gotRequest.resolve();
			return { roots: [] };
		};
		transport.onNotification = (method, params) => {
			notifications.push({ method, params });
			gotNotification.resolve();
		};
		try {
			await bounded(transport.connect(), "synthetic stdio peer startup");
			await expect(
				bounded(transport.request("tools/list", {}, { timeoutMs: 3_000 }), "client tools/list reply"),
			).resolves.toEqual({ tools: [] });
			await bounded(Promise.all([gotRequest.promise, gotNotification.promise]), "valid peer callbacks");
			expect(requests).toEqual([{ method: "roots/list", params: { source: "valid" } }]);
			expect(notifications).toEqual([
				{ method: "notifications/tools/list_changed", params: { source: "valid" } },
			]);
		} finally {
			await bounded(transport.close(), "synthetic stdio peer teardown");
		}
	}, 15_000);

	it("keeps processing subsequent JSONL frames after an invalid method-bearing envelope", async () => {
		const transport = createPeer([
			{ jsonrpc: "1.0", id: "invalid", method: "sampling/createMessage", params: {} },
			{ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { source: "next" } },
		]);
		const requests: string[] = [];
		const notifications: string[] = [];
		const notified = Promise.withResolvers<void>();
		transport.onRequest = async method => {
			requests.push(method);
			return {};
		};
		transport.onNotification = (method, params) => {
			notifications.push(method + ":" + (params as { source: string }).source);
			notified.resolve();
		};
		try {
			await bounded(transport.connect(), "synthetic stdio peer startup");
			await expect(
				bounded(transport.request("tools/list", {}, { timeoutMs: 3_000 }), "following valid client response"),
			).resolves.toEqual({ tools: [] });
			await bounded(notified.promise, "following valid server notification");
			expect(requests).toEqual([]);
			expect(notifications).toEqual(["notifications/tools/list_changed:next"]);
		} finally {
			await bounded(transport.close(), "synthetic stdio peer teardown");
		}
	}, 15_000);
	// The special JSON-RPC id:null parse-error reply is a genuine response
	// only when it has no method. Do not confuse it with the rejected hybrid.
	it("still rejects the pending client call on a genuine unattributable JSON-RPC parse error", async () => {
		const transport = createPeer([
			{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "synthetic parse error" } },
		]);
		const errors: string[] = [];
		transport.onError = error => errors.push(error.message);
		try {
			await bounded(transport.connect(), "synthetic stdio parse-error peer startup");
			await expect(
				bounded(transport.request("tools/list", {}, { timeoutMs: 3_000 }), "genuine id:null failure"),
			).rejects.toThrow("MCP error -32700: synthetic parse error");
			expect(errors).toEqual(["MCP error -32700: synthetic parse error"]);
		} finally {
			await bounded(transport.close(), "synthetic stdio parse-error peer teardown");
		}
	}, 15_000);

});
