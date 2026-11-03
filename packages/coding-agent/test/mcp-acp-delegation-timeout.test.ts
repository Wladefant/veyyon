import { describe, expect, it } from "bun:test";
import { callTool, listTools } from "@veyyon/coding-agent/mcp/client";
import { resolveMCPTimeoutMs } from "@veyyon/coding-agent/mcp/timeout";
import { HttpTransport } from "@veyyon/coding-agent/mcp/transports/http";
import type { MCPRequestOptions, MCPServerConnection, MCPTransport } from "@veyyon/coding-agent/mcp/types";

const toolResult = { content: [{ text: "child finished", type: "text" as const }] };

function makeConnection(provider?: string): { connection: MCPServerConnection; calls: Array<{ method: string; params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> } {
	const calls: Array<{ method: string; params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> = [];
	const transport = {
		connected: true,
		request: async <T>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> => {
			calls.push({ method, params, options });
			return (method === "tools/call" ? toolResult : { tools: [] }) as T;
		},
		notify: async () => {},
		close: async () => {},
	} satisfies MCPTransport;
	return {
		connection: {
			name: "child",
			config: { command: "child", args: [] },
			...(provider ? { _source: { provider, providerName: provider, path: "test", level: "project" as const } } : {}),
			serverInfo: { name: "child", version: "1" },
			capabilities: { tools: {} },
			transport,
		},
		calls,
	};
}

describe("ACP delegated tool call deadlines", () => {
	it("disables the transport deadline, preserves caller cancellation, and returns the child result", async () => {
		const { connection, calls } = makeConnection("acp");
		const controller = new AbortController();
		const expected = { ...toolResult, content: [{ text: "completed", type: "text" as const }] };
		(connection.transport.request as (method: string, params?: Record<string, unknown>, options?: MCPRequestOptions) => Promise<unknown>) = async (
			method,
			params,
			options,
		) => {
			calls.push({ method, params, options });
			return expected;
		};

		await expect(callTool(connection, "delegate", { task: "work" }, { signal: controller.signal })).resolves.toBe(expected);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("tools/call");
		expect(calls[0]?.options).toEqual({ signal: controller.signal, timeoutMs: 0 });
	});

	it("does not replace a non-ACP timeout and keeps the default timeout", async () => {
		const { connection, calls } = makeConnection("native");
		const options = { timeoutMs: 1250 };
		await callTool(connection, "inspect", {}, options);
		expect(calls[0]?.options).toBe(options);
		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	it("honors an explicit timeout for ACP calls", async () => {
		const { connection, calls } = makeConnection("acp");
		const options = { timeoutMs: 2400 };
		await callTool(connection, "inspect", {}, options);
		expect(calls[0]?.options).toBe(options);
	});

	it("does not disable the deadline for ACP tool listing", async () => {
		const { connection, calls } = makeConnection("acp");
		await listTools(connection);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("tools/list");
		expect(calls[0]?.options).toBeUndefined();
	});

	it("keeps abort propagation through the pending child request", async () => {
		const { connection, calls } = makeConnection("acp");
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		let aborted!: () => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			aborted = () => reject(received?.reason);
		});
		(connection.transport.request as (method: string, params?: Record<string, unknown>, options?: MCPRequestOptions) => Promise<unknown>) = (
			method,
			params,
			options,
		) => {
			calls.push({ method, params, options });
			received = options?.signal;
			received?.addEventListener("abort", aborted, { once: true });
			return cancellation;
		};

		const pending = callTool(connection, "delegate", {}, { signal: controller.signal });
		controller.abort(new Error("parent cancelled"));
		await expect(pending).rejects.toThrow("parent cancelled");
		expect(received).toBe(controller.signal);
		expect(calls[0]?.options?.timeoutMs).toBe(0);
	});
	it("only ACP calls outlive a real HTTP transport's default deadline", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const { id } = (await request.json()) as { id: string | number };
				// A real delay is required to cross HttpTransport's actual AbortController deadline; fake timers do not drive fetch.
				await Bun.sleep(140);
				return Response.json({ jsonrpc: "2.0", id, result: toolResult });
			},
		});
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const makeLiveConnection = async (provider: string): Promise<{ connection: MCPServerConnection; transport: HttpTransport }> => {
			const transport = new HttpTransport({ type: "http", url, timeout: 60 });
			await transport.connect();
			const { connection } = makeConnection(provider);
			connection.transport = transport;
			return { connection, transport };
		};

		try {
			const acp = await makeLiveConnection("acp");
			try {
				await expect(callTool(acp.connection, "delegate")).resolves.toEqual(toolResult);
			} finally {
				await acp.transport.close();
			}

			const native = await makeLiveConnection("native");
			try {
				await expect(callTool(native.connection, "delegate")).rejects.toThrow("within 60ms");
			} finally {
				await native.transport.close();
			}

			const explicitlyTimedAcp = await makeLiveConnection("acp");
			try {
				await expect(callTool(explicitlyTimedAcp.connection, "delegate", {}, { timeoutMs: 60 })).rejects.toThrow(
					"within 60ms",
				);
			} finally {
				await explicitlyTimedAcp.transport.close();
			}
		} finally {
			server.stop(true);
		}
	});
});
