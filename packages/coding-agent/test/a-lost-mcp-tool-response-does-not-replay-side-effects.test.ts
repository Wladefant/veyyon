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


async function boundedUnknownOutcome<T>(pending: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Unknown-outcome tool result never settled")), 2_000);
	try {
		return await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

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


	it("reports an attempted direct call as unknown while reconnect never settles", async () => {
		const pendingReconnect = Promise.withResolvers<MCPServerConnection | null>();
		let effects = 0;
		let reconnects = 0;
		const tool = new MCPTool(connection(fakeTransport(async () => {
			effects++;
			throw new Error("ECONNRESET: TEST_ONLY_PEER_DIAGNOSTIC");
		})), writeTool, async () => {
			reconnects++;
			return pendingReconnect.promise;
		});
		const result = await boundedUnknownOutcome(
			tool.execute("direct-unsettled-reconnect", { value: FAKE_PRIVATE_ARG }, undefined, context),
		);
		expect(effects).toBe(1);
		expect(reconnects).toBe(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("outcome unknown");
		expect(JSON.stringify(result)).not.toContain(FAKE_PRIVATE_ARG);
		expect(JSON.stringify(result)).not.toContain("TEST_ONLY_PEER_DIAGNOSTIC");
		// No unresolved external network/process exists: this Promise is only
		// a fixture for the connection readiness that does not arrive.
		pendingReconnect.resolve(null);
	});

	it("reports an attempted deferred call as unknown while reconnect never settles", async () => {
		const pendingReconnect = Promise.withResolvers<MCPServerConnection | null>();
		let effects = 0;
		let reconnects = 0;
		const tool = new DeferredMCPTool(
			"write-fixture",
			writeTool,
			async () => connection(fakeTransport(async () => {
				effects++;
				throw new Error("fetch failed: TEST_ONLY_PEER_DIAGNOSTIC");
			})),
			undefined,
			async () => {
				reconnects++;
				return pendingReconnect.promise;
			},
		);
		const result = await boundedUnknownOutcome(
			tool.execute("deferred-unsettled-reconnect", { value: FAKE_PRIVATE_ARG }, undefined, context),
		);
		expect(effects).toBe(1);
		expect(reconnects).toBe(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("outcome unknown");
		expect(JSON.stringify(result)).not.toContain(FAKE_PRIVATE_ARG);
		expect(JSON.stringify(result)).not.toContain("TEST_ONLY_PEER_DIAGNOSTIC");
		pendingReconnect.resolve(null);
	});

	it("late recovery cannot overwrite a newer explicit direct-call recovery", async () => {
		const delayedFirstRecovery = Promise.withResolvers<MCPServerConnection | null>();
		let originalCalls = 0;
		let latestCalls = 0;
		let staleRecoveryCalls = 0;
		let reconnectionAttempts = 0;
		const original = connection(fakeTransport(async () => {
			originalCalls++;
			throw new Error("ECONNRESET");
		}));
		const latest = connection(fakeTransport(async () => {
			latestCalls++;
			return completedResult("latest recovered connection");
		}));
		const stale = connection(fakeTransport(async () => {
			staleRecoveryCalls++;
			return completedResult("wrong stale recovery");
		}));
		const tool = new MCPTool(original, writeTool, async () => {
			reconnectionAttempts++;
			return reconnectionAttempts === 1 ? delayedFirstRecovery.promise : latest;
		});
		const first = await boundedUnknownOutcome(tool.execute("first", {}, undefined, context));
		expect(first.isError).toBe(true);
		const second = await boundedUnknownOutcome(tool.execute("second-explicit", {}, undefined, context));
		expect(second.isError).toBe(true);
		expect(originalCalls).toBe(2);
		expect(reconnectionAttempts).toBe(2);
		delayedFirstRecovery.resolve(stale);
		// Drain late Promise reactions; the older recovery must not overwrite
		// the connection chosen by the newer explicit invocation.
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		const third = await boundedUnknownOutcome(tool.execute("third-explicit", {}, undefined, context));
		expect(third.isError).not.toBe(true);
		expect(third.content[0]).toEqual({ type: "text", text: "latest recovered connection" });
		expect(latestCalls).toBe(1);
		expect(staleRecoveryCalls).toBe(0);
	});

	// WHY: async local:// argument resolution yields between an explicit tool
	// invocation's connection snapshot and dispatch. A separate explicit call
	// may reconnect in that window; only that newer call owns its new transport.
	// The external MCP transports alone are simulated, not the tool wrapper.
	it("pins each explicit MCP call to its original transport while argument resolution yields", async () => {
		let originalCalls = 0;
		let recoveredCalls = 0;
		let reconnects = 0;
		const original = connection(fakeTransport(async () => {
			originalCalls++;
			throw new Error("ECONNRESET");
		}));
		const recovered = connection(fakeTransport(async () => {
			recoveredCalls++;
			return completedResult("explicit third call");
		}));
		const tool = new MCPTool(original, writeTool, async () => {
			reconnects++;
			return recovered;
		});

		// Recursing through many ordinary argument values drives the actual
		// asynchronous prepareOutboundArgs path, rather than mocking that method.
		// The later short invocation completes its reconnect before A dispatches.
		const slowArgs = {
			value: "first",
			additional: Array.from({ length: 192 }, (_, index) => `synthetic-${index}`),
		};
		const firstPending = tool.execute("first-long-preparation", slowArgs, undefined, context);
		const second = await boundedUnknownOutcome(
			tool.execute("second-short-preparation", { value: "second" }, undefined, context),
		);
		expect(second.isError).toBe(true);
		expect(originalCalls).toBe(1);
		expect(recoveredCalls).toBe(0);

		const first = await boundedUnknownOutcome(firstPending);
		expect(first.isError).toBe(true);
		expect(JSON.stringify(first)).toContain("outcome unknown");
		// The first invocation never silently migrates its attempted tools/call
		// to the replacement selected by the later explicit invocation.
		expect(originalCalls).toBe(2);
		expect(recoveredCalls).toBe(0);
		expect(reconnects).toBe(2);

		const third = await boundedUnknownOutcome(
			tool.execute("third-explicit", { value: "third" }, undefined, context),
		);
		expect(third.isError).not.toBe(true);
		expect(third.content[0]).toEqual({ type: "text", text: "explicit third call" });
		expect(recoveredCalls).toBe(1);
	});
});