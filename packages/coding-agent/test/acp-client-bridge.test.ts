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

// Bind test observation to a finite phase: a failure to enter the real
// client boundary must fail rather than strand the entire test runner.
async function withinPermissionPhase<T>(work: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + phase)), 4_000);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

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
	try {
		await withinPermissionPhase(clientEntered.promise, "ACP permission request entry");
		abort.abort();
		reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
		expect(await withinPermissionPhase(request, "cancelled permission result")).toEqual({ outcome: "cancelled" });
	} finally {
		abort.abort();
		reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
	}
}, 12_000);

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


// WHY: the ACP editor may synchronously abort a request while returning an
// already rejected promise. Cancellation must beat its transport failure in
// the bridge result; ordinary non-aborted transport errors stay observable.
// A fake editor cannot prove the real client dismissed its permission modal.
it("returns cancelled when synchronous client abort races an already-rejected editor reply", async () => {
	const controller = new AbortController();
	let calls = 0;
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			calls++;
			controller.abort();
			return Promise.reject(new Error("synthetic ACP editor disconnect"));
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-immediate-abort-reject", {});
	const request = bridge.requestPermission!(
		{ toolCallId: "aborted-rejected-permission", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	expect(await withinPermissionAbortPhase(request, "synchronous abort and rejection")).toEqual({ outcome: "cancelled" });
	expect(calls).toBe(1);
}, 8_000);

it("returns cancelled when the editor synchronously aborts and throws before returning a promise", async () => {
	const controller = new AbortController();
	let calls = 0;
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			calls++;
			controller.abort();
			throw new Error("synthetic ACP permission call threw");
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-sync-abort-throw", {});
	const request = bridge.requestPermission!(
		{ toolCallId: "aborted-throw-permission", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	expect(await withinPermissionAbortPhase(request, "synchronous abort and throw")).toEqual({ outcome: "cancelled" });
	expect(calls).toBe(1);
}, 8_000);

it("still reports a client transport rejection while the caller remains active", async () => {
	const controller = new AbortController();
	let calls = 0;
	const connection = {
		requestPermission(_params: RequestPermissionRequest) {
			calls++;
			return Promise.reject(new Error("synthetic active editor failure"));
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-unaborted-reject", {});
	const request = bridge.requestPermission!(
		{ toolCallId: "active-rejection-permission", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	await expect(withinPermissionAbortPhase(request, "active editor rejection")).rejects.toThrow(
		"synthetic active editor failure",
	);
	expect(controller.signal.aborted).toBe(false);
	expect(calls).toBe(1);
}, 8_000);

it.each(["abort first", "reply first"])("refuses a stale permission selection when %s precedes continuation", async order => {
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<{ outcome: { outcome: "selected"; optionId: string } }>();
	const connection = {
		requestPermission(_request: RequestPermissionRequest) {
			entered.resolve();
			return reply.promise;
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-stale-selection", {});
	const controller = new AbortController();
	const permission = bridge.requestPermission!(
		{ toolCallId: "stale-selection", toolName: "bash", title: "synthetic command" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		controller.signal,
	);
	try {
		await withinPermissionAbortPhase(entered.promise, "stale selection RPC entry");
		if (order === "abort first") controller.abort();
		reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
		if (order === "reply first") controller.abort();
		expect(await withinPermissionAbortPhase(permission, "stale selection cancellation")).toEqual({
			outcome: "cancelled",
		});
	} finally {
		controller.abort();
		reply.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
	}
}, 10_000);

it("does not contact the editor for an already-aborted permission request", async () => {
	let requests = 0;
	const connection = {
		async requestPermission(_request: RequestPermissionRequest) {
			requests++;
			return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
		},
	} as unknown as AgentSideConnection;
	const controller = new AbortController();
	controller.abort();
	const bridge = createAcpClientBridge(connection, "session-pre-aborted", {});
	expect(
		await withinPermissionAbortPhase(
			bridge.requestPermission!(
				{ toolCallId: "pre-aborted", toolName: "bash", title: "synthetic command" },
				[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
				controller.signal,
			),
			"pre-aborted permission result",
		),
	).toEqual({ outcome: "cancelled" });
	expect(requests).toBe(0);
});

it("preserves the selected permission option and kind while the caller remains active", async () => {
	const connection = {
		async requestPermission(_request: RequestPermissionRequest) {
			return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
		},
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, "session-active-selection", {});
	const controller = new AbortController();
	expect(
		await withinPermissionAbortPhase(
			bridge.requestPermission!(
				{ toolCallId: "active-selection", toolName: "bash", title: "synthetic command" },
				[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
				controller.signal,
			),
			"active permission selection",
		),
	).toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
});
