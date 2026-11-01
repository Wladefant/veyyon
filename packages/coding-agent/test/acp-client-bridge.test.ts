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

// WHY: a cancelled tool must not remain blocked behind a client permission
// dialog whose external RPC will never respond. These tests exercise the
// real ACP ClientBridge with only the external editor response deferred.
// They do not claim to cancel the editor's visible modal.
async function withinPermissionAbortPhase<T>(operation: Promise<T>, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for " + label)), 3_000);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it("settles a cancelled ACP permission before an unresponsive client sends any reply", async () => {
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
	let calls = 0;
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			calls++;
			entered.resolve();
			return reply.promise;
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-never-answer", {});
	const controller = new AbortController();
	const request = bridge.requestPermission!(
		{ toolCallId: "unresponsive-permission", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	void request.catch(() => undefined);
	try {
		await withinPermissionAbortPhase(entered.promise, "ACP permission RPC entry");
		controller.abort();
		expect(await withinPermissionAbortPhase(request, "local permission cancellation")).toEqual({
			outcome: "cancelled",
		});
		expect(calls).toBe(1);
	} finally {
		controller.abort();
		// Clean up only the owned fake. The real client may remain unanswered.
		reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
	}
}, 10_000);

it("observes a client rejection delivered after the local permission was cancelled", async () => {
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			entered.resolve();
			return reply.promise;
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-late-reject", {});
	const controller = new AbortController();
	const request = bridge.requestPermission!(
		{ toolCallId: "late-reject", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	void request.catch(() => undefined);
	try {
		await withinPermissionAbortPhase(entered.promise, "late rejection permission RPC");
		controller.abort();
		expect(await withinPermissionAbortPhase(request, "cancelled before client error")).toEqual({
			outcome: "cancelled",
		});
	} finally {
		controller.abort();
		reply.reject(new Error("Synthetic editor permission request disconnected after cancellation"));
	}
	// Give the late rejection a turn to propagate. The test runner reports
	// unhandled rejected promises; the bridge must already have observed it.
	const settled = Promise.withResolvers<void>();
	setImmediate(settled.resolve);
	await withinPermissionAbortPhase(settled.promise, "late client rejection observation");
}, 10_000);

it("starts a live ACP permission RPC synchronously, before its caller can abort the returned promise", async () => {
	const selected = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
	let requests = 0;
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			requests++;
			return selected.promise;
		},
	} as unknown as AgentSideConnection;
	const controller = new AbortController();
	const bridge = createAcpClientBridge(connection, "session-eager-send", {});
	const pending = bridge.requestPermission!(
		{ toolCallId: "eager-permission", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	void pending.catch(() => undefined);
	try {
		// A normal bridge request historically sends the permission RPC
		// immediately, not in a queued microtask that may run after abort.
		expect(requests).toBe(1);
		controller.abort();
		expect(await withinPermissionAbortPhase(pending, "eager permission cancellation")).toEqual({
			outcome: "cancelled",
		});
	} finally {
		controller.abort();
		selected.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
	}
}, 10_000);
