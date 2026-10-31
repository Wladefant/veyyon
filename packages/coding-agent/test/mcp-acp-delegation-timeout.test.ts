import { describe, expect, it } from "bun:test";
import { callTool, listTools } from "@veyyon/coding-agent/mcp/client";
import { resolveMCPTimeoutMs } from "@veyyon/coding-agent/mcp/timeout";
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
			...(provider ? { _source: { provider, providerName: provider, path: "test", level: "native" as const } } : {}),
			serverInfo: { name: "child", version: "1" },
			capabilities: { tools: {} },
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
});
