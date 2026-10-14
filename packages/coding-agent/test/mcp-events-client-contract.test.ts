import { describe, expect, it } from "bun:test";
import { listEvents, pollEvents } from "@veyyon/coding-agent/mcp/client";
import type { MCPServerConnection, MCPTransport } from "@veyyon/coding-agent/mcp/types";

function connection(capabilities: MCPServerConnection["capabilities"], response: unknown): MCPServerConnection {
	const methods: string[] = [];
	const transport: MCPTransport = {
		connected: true,
		async request<T>(method: string): Promise<T> {
			methods.push(method);
			return response as T;
		},
		async notify() {},
		async close() {},
	};
	return {
		name: "events-test",
		config: { type: "stdio", command: "unused" },
		transport,
		serverInfo: { name: "fake", version: "1" },
		capabilities,
	};
}

describe("MCP Events client primitives", () => {
	it("does not issue events/list when capability is absent", async () => {
		const server = connection({}, { events: [{ name: "unexpected", delivery: ["poll"] }] });
		expect(await listEvents(server)).toEqual([]);
	});

	it("lists advertised event descriptors and polls with the opaque cursor", async () => {
		const descriptor = {
			name: "change.created",
			delivery: ["poll"],
			inputSchema: { type: "object" },
			payloadSchema: { type: "object" },
		};
		const server = connection({ events: { listChanged: true } }, { events: [descriptor] });
		expect(await listEvents(server)).toEqual([descriptor]);

		const occurrence = {
			eventId: "event-1",
			name: "change.created",
			timestamp: "2026-10-14T00:00:00Z",
			data: { text: "untrusted" },
		};
		const pollServer = connection({ events: {} }, { events: [occurrence], cursor: "opaque-next" });
		expect(await pollEvents(pollServer, "change.created", {}, "opaque-start")).toEqual({
			events: [occurrence],
			cursor: "opaque-next",
		});
	});
});
