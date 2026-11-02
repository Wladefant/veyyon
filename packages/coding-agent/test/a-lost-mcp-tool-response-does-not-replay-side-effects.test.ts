import { describe, expect, it } from "bun:test";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPToolDefinition, MCPTransport } from "../src/mcp/types";

// WHY: a tools/call can perform its side effect before the transport loses the
// reply. Reconnecting does not prove the first effect was rolled back, so an
// implicit second tools/call can perform it twice without another approval.
// The external MCP transport is simulated; production MCPTool/DeferredMCPTool
// dispatch and outcome formatting are exercised. An installed server's actual
// durable receipt reconciliation remains outside this synthetic regression.
const writeTool: MCPToolDefinition = {
	name: "write_once",
	description: "Synthetic side-effecting tool",
	inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
};
const context = {} as Parameters<MCPTool["execute"]>[3];
const FAKE_PRIVATE_ARG = "TEST_ONLY_MCP_PRIVATE_ARG_890";

function fakeTransport(dispatch: (...args: Parameters<MCPTransport["request"]>) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: dispatch as MCPTransport["request"],
		notify: async () => {},
		close: async () => {},
	};
}

function connection(transport: MCPTransport): MCPServerConnection {
	return {
		name: "write-fixture",
		config: { type: "stdio", command: "test-only" },
		serverInfo: { name: "write-fixture", version: "1" },
		capabilities: { tools: {} },
		transport,
	};
}

function completedResult(value: string): MCPToolCallResult {
	return { content: [{ type: "text", text: value }] };
}

describe("a lost MCP tools/call response is not permission to replay a side effect", () => {
	for (const hint of [undefined, true] as const) {
		it(`never duplicates a dispatched write after ECONNRESET (idempotent hint: ${String(hint)})`, async () => {
			let effects = 0;
			let oldCalls = 0;
			let refreshedCalls = 0;
			let reconnects = 0;
			const oldConnection = connection(fakeTransport(async () => {
				oldCalls++;
				effects++;
				// The external side effect has completed; only the reply is lost.
				throw new Error("ECONNRESET");
			}));
			const refreshedConnection = connection(fakeTransport(async () => {
				refreshedCalls++;
				effects++;
				return completedResult("accepted on explicit request");
			}));
			const toolDef = hint === undefined
				? writeTool
				: { ...writeTool, annotations: { idempotentHint: hint } };
			const tool = new MCPTool(oldConnection, toolDef, async () => {
				reconnects++;
				return refreshedConnection;
			});

			const first = await tool.execute("origin-1", { value: FAKE_PRIVATE_ARG }, undefined, context);
			expect(oldCalls).toBe(1);
			expect(refreshedCalls).toBe(0);
			expect(effects).toBe(1);
			expect(reconnects).toBe(1);
			expect(first.isError).toBe(true);
			expect(JSON.stringify(first)).toContain("outcome unknown");
			expect(JSON.stringify(first)).toContain("Do not automatically repeat");
			expect(JSON.stringify(first)).not.toContain("ECONNRESET");
			expect(JSON.stringify(first)).not.toContain(FAKE_PRIVATE_ARG);

			// A second *explicit* invocation remains possible on the refreshed
			// connection, but it must not be confused with the prior call.
			const second = await tool.execute("origin-2", { value: "second" }, undefined, context);
			expect(second.isError).not.toBe(true);
			expect(second.content[0]).toEqual({ type: "text", text: "accepted on explicit request" });
			expect(refreshedCalls).toBe(1);
			expect(effects).toBe(2);
			expect(reconnects).toBe(1);
		});
	}

	it("returns an unknown outcome without a reconnect callback rather than recommending blind retry", async () => {
		let effects = 0;
		const tool = new MCPTool(
			connection(fakeTransport(async () => {
				effects++;
				throw new Error("HTTP 503: synthetic upstream unavailable");
			})),
			writeTool,
		);
		const result = await tool.execute("origin-without-reconnect", {}, undefined, context);
		expect(effects).toBe(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("outcome unknown");
		expect(JSON.stringify(result)).not.toContain("synthetic upstream unavailable");
	});

	it("never replays a deferred tool after its first connection accepted the write", async () => {
		let oldCalls = 0;
		let refreshedCalls = 0;
		let reconnects = 0;
		let current = connection(fakeTransport(async () => {
			oldCalls++;
			throw new Error("fetch failed");
		}));
		const refreshed = connection(fakeTransport(async () => {
			refreshedCalls++;
			return completedResult("explicit only");
		}));
		const tool = new DeferredMCPTool(
			"write-fixture",
			writeTool,
			async () => current,
			undefined,
			async () => {
				reconnects++;
				current = refreshed;
				return refreshed;
			},
		);
		const first = await tool.execute("deferred-origin-1", {}, undefined, context);
		expect(oldCalls).toBe(1);
		expect(refreshedCalls).toBe(0);
		expect(reconnects).toBe(1);
		expect(first.isError).toBe(true);
		expect(JSON.stringify(first)).toContain("outcome unknown");

		const second = await tool.execute("deferred-origin-2", {}, undefined, context);
		expect(second.isError).not.toBe(true);
		expect(refreshedCalls).toBe(1);
		expect(second.content[0]).toEqual({ type: "text", text: "explicit only" });
	});

	it("permits a single first dispatch when the deferred connection failed before tools/call", async () => {
		let attempts = 0;
		let effects = 0;
		const recovered = connection(fakeTransport(async () => {
			effects++;
			return completedResult("first dispatch succeeded");
		}));
		const tool = new DeferredMCPTool(
			"write-fixture",
			writeTool,
			async () => {
				attempts++;
				throw new Error("MCP server not connected");
			},
			undefined,
			async () => recovered,
		);
		const result = await tool.execute("deferred-before-dispatch", {}, undefined, context);
		expect(attempts).toBe(1);
		expect(effects).toBe(1);
		expect(result.isError).not.toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "first dispatch succeeded" });
	});
	it("does not label a lost response as retryable after deferred pre-dispatch recovery", async () => {
		let connectionAttempts = 0;
		let sideEffects = 0;
		const recovered = connection(fakeTransport(async () => {
			sideEffects++;
			// The *first* tools/call occurs on the recovered transport; its
			// side effect commits, then the response disappears.
			throw new Error("ECONNRESET");
		}));
		const tool = new DeferredMCPTool(
			"write-fixture",
			writeTool,
			async () => {
				connectionAttempts++;
				throw new Error("MCP server not connected");
			},
			undefined,
			async () => recovered,
		);
		const result = await tool.execute("first-dispatch-reply-lost", { value: "once" }, undefined, context);
		expect(connectionAttempts).toBe(1);
		expect(sideEffects).toBe(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("outcome unknown");
		expect(JSON.stringify(result)).not.toContain("ECONNRESET");
	});

});