import { describe, expect, it } from "bun:test";
import type { AgentSideConnection, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createAcpClientBridge } from "@veyyon/coding-agent/modes/acp/acp-client-bridge";

describe("ACP client bridge permission requests", () => {
	it("forwards pending tool-call status to session/request_permission", async () => {
		let request: RequestPermissionRequest | undefined;
		const connection = {
			async requestPermission(params: RequestPermissionRequest) {
				request = params;
				return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {});

		await bridge.requestPermission!(
			{
				toolCallId: "call-1",
				toolName: "bash",
				title: "echo hi",
				kind: "execute",
				status: "pending",
				rawInput: { command: "echo hi" },
				content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
			},
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);

		expect(request?.toolCall).toMatchObject({
			toolCallId: "call-1",
			title: "echo hi",
			kind: "execute",
			status: "pending",
			rawInput: { command: "echo hi" },
			content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
		});
	});
});

// WHY: an ACP client may answer a permission dialog after the tool call was
// cancelled. A late selection must not regain permission. The test exercises
// the real bridge contract, with only the external client response deferred.
it("refuses a permission selection received after request cancellation", async () => {
	const clientEntered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			clientEntered.resolve();
			return reply.promise;
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-race", {});
	const abort = new AbortController();
	const request = bridge.requestPermission!(
		{ toolCallId: "call-race", toolName: "bash", title: "test-only command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		abort.signal,
	);
	await clientEntered.promise;
	abort.abort();
	reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
	expect(await request).toEqual({ outcome: "cancelled" });
});

it("retains a selected client permission while the request remains active", async () => {
	const connection = {
		async requestPermission(_params: RequestPermissionRequest) {
			return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-live", {});
	const abort = new AbortController();
	expect(
		await bridge.requestPermission!(
			{ toolCallId: "call-live", toolName: "bash", title: "test-only command" },
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
			abort.signal,
		),
	).toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
});

it("never contacts the ACP client for a previously aborted permission request", async () => {
	let clientRequests = 0;
	const connection = {
		async requestPermission(_params: RequestPermissionRequest) {
			clientRequests++;
			return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-cancelled", {});
	const abort = new AbortController();
	abort.abort();
	expect(
		await bridge.requestPermission!(
			{ toolCallId: "call-cancelled", toolName: "bash", title: "test-only command" },
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
			abort.signal,
		),
	).toEqual({ outcome: "cancelled" });
	expect(clientRequests).toBe(0);
});
