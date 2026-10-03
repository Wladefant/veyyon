import { expect, test, vi } from "bun:test";
import http from "node:http";
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

function getPort(server: http.Server): number {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Invalid server address");
	}
	return address.port;
}

async function listenServer(server: http.Server): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	return getPort(server);
}

async function closeServer(server: http.Server): Promise<void> {
	if (!server.listening) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	server.closeAllConnections?.();
	server.close(() => resolve());
	await promise;
}

function extractJsonRpcId(bodyText: string): unknown {
	const parsed: unknown = JSON.parse(bodyText);
	if (parsed && typeof parsed === "object" && "id" in parsed) {
		return parsed.id;
	}
	return undefined;
}

function extractToolName(bodyText: string): string | undefined {
	const parsed: unknown = JSON.parse(bodyText);
	if (
		parsed &&
		typeof parsed === "object" &&
		"params" in parsed &&
		parsed.params &&
		typeof parsed.params === "object" &&
		"name" in parsed.params &&
		typeof parsed.params.name === "string"
	) {
		return parsed.params.name;
	}
	return undefined;
}

test.each([180_000, 0])("MCP proxy honors a transport deadline of %i beyond 60s", async timeout => {
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const id = extractJsonRpcId(Buffer.concat(chunks).toString("utf-8"));
		arrived.resolve();
		await release.promise;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: "Queued report completed" }],
				},
			}),
		);
	});
	const port = await listenServer(server);
	const config = { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, timeout };
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
		await closeServer(server);
		vi.restoreAllMocks();
	}
});

test("MCP proxy tool times out when transport authentication hook stalls", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(401, {
			"Content-Type": "application/json",
			"WWW-Authenticate": "Bearer",
		});
		res.end(JSON.stringify({ error: "Unauthorized" }));
	});
	const port = await listenServer(server);
	const timeout = 50;
	const config = { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, timeout };
	const transport = new HttpTransport(config);
	transport.onAuthError = () => Promise.withResolvers<Record<string, string> | null>().promise;
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

		const result = await proxy.execute("call_stall", {}, undefined, {} as CustomToolContext);
		expect(result.details?.isError).toBe(true);
		const stallContent = result.content[0];
		if (stallContent?.type !== "text") {
			throw new Error("Expected text content in stall result");
		}
		expect(stallContent.text).toMatch(/did not complete request "tools\/call" within 50ms/);
	} finally {
		await transport.close();
		await closeServer(server);
		vi.restoreAllMocks();
	}
});

test("MCP proxy tool aborts immediately when caller aborts during stalled authentication", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(401, {
			"Content-Type": "application/json",
			"WWW-Authenticate": "Bearer",
		});
		res.end(JSON.stringify({ error: "Unauthorized" }));
	});
	const port = await listenServer(server);
	const config = { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, timeout: 30_000 };
	const transport = new HttpTransport(config);
	const authHookEntered = Promise.withResolvers<void>();
	transport.onAuthError = () => {
		authHookEntered.resolve();
		return Promise.withResolvers<Record<string, string> | null>().promise;
	};
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

		const ac = new AbortController();
		const executePromise = proxy.execute("call_abort", {}, undefined, {} as CustomToolContext, ac.signal);
		await authHookEntered.promise;
		ac.abort();

		try {
			await executePromise;
			expect.unreachable("executePromise should throw ToolAbortError");
		} catch (e: unknown) {
			expect(e instanceof ToolAbortError).toBe(true);
		}
	} finally {
		await transport.close();
		await closeServer(server);
		vi.restoreAllMocks();
	}
});

test("MCP proxy tool ignores late auth hook resolution after deadline expiry", async () => {
	let requestCount = 0;
	const server = http.createServer((_req, res) => {
		requestCount++;
		res.writeHead(401, {
			"Content-Type": "application/json",
			"WWW-Authenticate": "Bearer",
		});
		res.end(JSON.stringify({ error: "Unauthorized" }));
	});
	const port = await listenServer(server);
	const timeout = 40;
	const config = { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, timeout };
	const transport = new HttpTransport(config);
	const authDeferred = Promise.withResolvers<Record<string, string> | null>();
	transport.onAuthError = () => authDeferred.promise;
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

		const result = await proxy.execute("call_late", {}, undefined, {} as CustomToolContext);
		expect(result.details?.isError).toBe(true);
		expect(requestCount).toBe(1);

		// Resolve the auth hook late after the proxy call already timed out
		authDeferred.resolve({ Authorization: "Bearer late-token" });
		await Promise.resolve();

		// Must not have initiated any retry request
		expect(requestCount).toBe(1);
	} finally {
		await transport.close();
		await closeServer(server);
		vi.restoreAllMocks();
	}
});

test("MCP proxy handles concurrent requests where one stalls and times out while another succeeds", async () => {
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const bodyText = Buffer.concat(chunks).toString("utf-8");
		const id = extractJsonRpcId(bodyText);
		const toolName = extractToolName(bodyText);

		if (toolName === "stall_tool") {
			res.writeHead(401, {
				"Content-Type": "application/json",
				"WWW-Authenticate": "Bearer",
			});
			res.end(JSON.stringify({ error: "Unauthorized" }));
		} else {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: { content: [{ type: "text", text: "success" }] },
				}),
			);
		}
	});
	const port = await listenServer(server);
	const timeout = 50;
	const config = { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, timeout };
	const transport = new HttpTransport(config);
	transport.onAuthError = () => Promise.withResolvers<Record<string, string> | null>().promise;
	const connection: MCPServerConnection = {
		name: "test-server",
		config,
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	};
	const manager = new MCPManager(process.cwd());
	const stallDef: MCPToolDefinition = {
		name: "stall_tool",
		description: "Stalling tool",
		inputSchema: { type: "object", properties: {} },
	};
	const okDef: MCPToolDefinition = {
		name: "ok_tool",
		description: "OK tool",
		inputSchema: { type: "object", properties: {} },
	};
	const tools = MCPTool.fromTools(connection, [stallDef, okDef]);
	vi.spyOn(manager, "getTools").mockReturnValue(tools);
	vi.spyOn(manager, "waitForConnection").mockResolvedValue(connection);

	try {
		await transport.connect();
		const proxyTools = createMCPProxyTools(manager);
		const stallProxy = proxyTools.find(t => t.mcpToolName === "stall_tool");
		const okProxy = proxyTools.find(t => t.mcpToolName === "ok_tool");
		if (!stallProxy?.execute || !okProxy?.execute) {
			throw new Error("Missing proxy execute implementation");
		}

		const [stallResult, okResult] = await Promise.all([
			stallProxy.execute("call_stall", {}, undefined, {} as CustomToolContext),
			okProxy.execute("call_ok", {}, undefined, {} as CustomToolContext),
		]);

		expect(stallResult.details?.isError).toBe(true);
		const stallContent = stallResult.content[0];
		if (stallContent?.type !== "text") {
			throw new Error("Expected text content in stall result");
		}
		expect(stallContent.text).toMatch(/did not complete request "tools\/call" within 50ms/);

		expect(okResult.details?.isError).not.toBe(true);
		expect(okResult.content).toEqual([{ type: "text", text: "success" }]);
	} finally {
		await transport.close();
		await closeServer(server);
		vi.restoreAllMocks();
	}
});
