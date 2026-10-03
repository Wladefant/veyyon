import { expect, test, vi } from "bun:test";
import type { CustomTool, CustomToolContext } from "../src/extensibility/custom-tools/types";
import { MCPManager } from "../src/mcp/manager";
import { MCPTool } from "../src/mcp/tool-bridge";
import { HttpTransport } from "../src/mcp/transports/http";
import type { MCPRequestOptions, MCPServerConnection, MCPToolDefinition, MCPTransport } from "../src/mcp/types";
import { createMCPProxyTools } from "../src/task/executor";
import { ToolAbortError } from "../src/tools/core/tool-errors";

function createFakeConnection() {
	let capturedSignal: AbortSignal | undefined;
	const { promise: requestPromise, reject } = Promise.withResolvers<never>();
	let isRequestCalled = false;

	const transport: MCPTransport = {
		async request(_method: string, _params?: Record<string, unknown>, options?: MCPRequestOptions) {
			isRequestCalled = true;
			capturedSignal = options?.signal;
			if (capturedSignal?.aborted) {
				reject(new Error("aborted"));
				return requestPromise;
			}
			capturedSignal?.addEventListener("abort", () => {
				reject(new Error("aborted"));
			});
			return requestPromise;
		},
		async notify() {},
		async close() {},
		connected: true,
	};

	const connection: MCPServerConnection = {
		name: "test-server",
		config: { command: "test", args: [] },
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	};

	return {
		connection,
		getCapturedSignal: () => capturedSignal,
		requestPromise,
		rejectRequest: reject,
		requestCalled: () => isRequestCalled,
	};
}

/**
 * A source MCP tool that hangs until its signal aborts, standing in for the real
 * `MCPTool` whose `execute` performs the transport request.
 *
 * The proxy used to rebuild a raw `tools/call` against the connection, so these
 * tests captured the signal at a fake transport. It now delegates to the source
 * tool instead (upstream #6242), which is the boundary that owns harness-intent
 * stripping, local-URL resolution and reconnect retry, so the signal has to be
 * observed there. Every assertion is unchanged: the proxy must hand the source
 * a live signal, leave it unaborted while the call is in flight, and abort it on
 * caller abort or on the 60s Task timeout.
 */
function createHangingSourceTool(): {
	tool: CustomTool;
	getCapturedSignal: () => AbortSignal | undefined;
	executeCalled: () => boolean;
} {
	let capturedSignal: AbortSignal | undefined;
	let called = false;
	const tool = {
		name: "test_tool",
		label: "Test Tool",
		description: "A test tool",
		strict: false,
		mcpToolName: "test_tool",
		mcpServerName: "test-server",
		parameters: { type: "object", properties: {} },
		execute: (
			_id: string,
			_params: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
			signal?: AbortSignal,
		): Promise<never> => {
			called = true;
			capturedSignal = signal;
			const { promise, reject } = Promise.withResolvers<never>();
			if (signal?.aborted) reject(new ToolAbortError());
			else signal?.addEventListener("abort", () => reject(new ToolAbortError()));
			return promise;
		},
	} as unknown as CustomTool;
	return { tool, getCapturedSignal: () => capturedSignal, executeCalled: () => called };
}

function mockSourceTool(manager: MCPManager, connection: MCPServerConnection) {
	const toolDef: MCPToolDefinition = {
		name: "test_tool",
		description: "A test tool",
		inputSchema: { type: "object", properties: {} },
	};
	const tools = MCPTool.fromTools(connection, [toolDef]);
	vi.spyOn(manager, "getTools").mockReturnValue(tools);
	vi.spyOn(manager, "waitForConnection").mockResolvedValue(connection);
}

test("MCP proxy tool aborts underlying operation on caller abort", async () => {
	const fake = createFakeConnection();
	const manager = new MCPManager(process.cwd());

	const source = createHangingSourceTool();
	const toolsData: CustomTool[] = [source.tool];

	vi.spyOn(manager, "getTools").mockReturnValue(toolsData);
	vi.spyOn(manager, "waitForConnection").mockResolvedValue(fake.connection);

	const tools = createMCPProxyTools(manager);
	const proxyTool = tools[0];
	if (!proxyTool?.execute) {
		expect.unreachable("Tool execute method missing");
		return;
	}

	const ac = new AbortController();
	const executePromise = proxyTool.execute("call_1", {}, () => {}, {} as CustomToolContext, ac.signal);

	// Let the promise reach the source tool's execute
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

	expect(source.executeCalled()).toBe(true);
	const capturedSignal = source.getCapturedSignal();
	expect(capturedSignal).toBeDefined();
	if (!capturedSignal) return;
	expect(capturedSignal.aborted).toBe(false);

	ac.abort();

	try {
		await executePromise;
		expect.unreachable("executePromise should throw ToolAbortError");
	} catch (e: unknown) {
		expect(e instanceof ToolAbortError).toBe(true);
	}

	expect(capturedSignal.aborted).toBe(true);
});

test.each([180_000, 0])("MCP proxy honors a transport deadline of %i beyond 60s", async timeout => {
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const { id } = (await request.json()) as { id: number };
			arrived.resolve();
			await release.promise;
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: "Queued report completed" }],
				},
			});
		},
	});
	const config = { type: "http" as const, url: `http://127.0.0.1:${server.port}/mcp`, timeout };
	const transport = new HttpTransport(config);
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, {
		name: "test-server",
		config,
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	});
	try {
		await transport.connect();
		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		vi.useFakeTimers();
		const resultPromise = proxy.execute("queued-report", {}, undefined, {} as CustomToolContext);
		await arrived.promise;
		// Advance the actual proxy/transport timers while the socket is held open.
		// The former independent 60s watchdog discarded this server's answer.
		vi.advanceTimersByTime(61_000);
		release.resolve();
		const result = await resultPromise;
		expect(result.content).toEqual([{ type: "text", text: "Queued report completed" }]);
		expect(result.isError).not.toBe(true);
	} finally {
		vi.useRealTimers();
		release.resolve();
		await transport.close();
		server.stop(true);
		vi.restoreAllMocks();
	}
});
