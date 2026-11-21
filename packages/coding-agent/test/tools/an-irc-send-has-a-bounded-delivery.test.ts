/**
 * WHY:
 * A non-await `irc send` returned only after every bus receipt settled. The
 * bus revives a parked recipient before its hand-off, and that revival (or a
 * durable hand-off) has no deadline of its own, so the sending agent's tool
 * call hung for as long as the revival did. The sender did not ask for a
 * reply, so nothing it was waiting on justified that hang.
 *
 * The receipt wait now has its own bound and honours the caller's abort. When
 * either fires first, the call returns what it knows and says the delivery is
 * still under way. It does not say the delivery failed, and it does not invite
 * a resend. The leg the bus started keeps running.
 *
 * Time is driven by fake timers. The advance below is far longer than the
 * product bound, so the test does not depend on the bound's exact value.
 *
 * What this does NOT catch:
 * - Real lifecycle revival timing. The gate below stands in for it.
 * - The await path's reply window, which has its own suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type IrcLogEntry, IrcBus, type IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type IrcDetails, IrcTool } from "@veyyon/coding-agent/tools/agent/irc";

/** Well past any receipt bound: a bounded call has returned by now, an unbounded one has not. */
const PAST_ANY_BOUND_MS = 60_000;

/** Outcome of one tool call, filled in when it settles. */
type Tracked = { result?: AgentToolResult<IrcDetails>; error?: unknown };

function makePeer(onDeliver?: (msg: IrcMessage) => void): AgentSession {
	const session = {
		deliverIrcMessage: async (msg: IrcMessage) => {
			onDeliver?.(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	};
	return session as unknown as AgentSession;
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

function textOf(result: AgentToolResult<IrcDetails>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

async function passReceiptDeadline(): Promise<void> {
	vi.advanceTimersByTime(PAST_ANY_BOUND_MS);
	// The deadline, race, cleanup and tool result each settle in a microtask.
	for (let step = 0; step < 12; step++) await Promise.resolve();
}

describe("a non-await irc send returns on a bounded receipt wait", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
	let releaseRevival: () => void;

	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: makePeer(), status: "running" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	/** A parked recipient whose revival does not finish until the test releases it. */
	function gateParkedRevival(): void {
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", session: null, status: "parked" });
		const gate = Promise.withResolvers<void>();
		releaseRevival = gate.resolve;
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async id => {
			await gate.promise;
			const session = makePeer();
			registry.attachSession(id, session);
			registry.setStatus(id, "idle");
			return session;
		});
	}

	function track(pending: Promise<AgentToolResult<IrcDetails>>): Tracked {
		const tracked: Tracked = {};
		pending.then(
			result => {
				tracked.result = result;
			},
			error => {
				tracked.error = error;
			},
		);
		return tracked;
	}

	it("returns a pending receipt as still under way when the revival outlasts the bound", async () => {
		gateParkedRevival();
		const tool = new IrcTool(makeToolSession(registry, "Main"));
		try {
			const call = track(tool.execute("call-1", { op: "send", to: "Worker", message: "ping" }));
			await passReceiptDeadline();

			// Without a bound this stays undefined: the call waits on the gated revival.
			expect(call.result, "the send call did not return while the revival was gated").toBeDefined();
			expect(call.error).toBeUndefined();
			const result = call.result as AgentToolResult<IrcDetails>;
			expect(result.isError).toBeFalsy();
			expect(result.details?.receipts).toEqual([]);
			expect(textOf(result)).toMatch(/No receipt within/);
			expect(textOf(result)).toMatch(/Worker/);
			expect(textOf(result)).toMatch(/do not resend/);
			expect(textOf(result)).not.toMatch(/failed/);
		} finally {
			releaseRevival();
		}
	});

	it("still completes the leg the bound left running", async () => {
		gateParkedRevival();
		const tool = new IrcTool(makeToolSession(registry, "Main"));
		// Subscribed before the send, so the leg's own traffic line cannot be missed.
		const legLogged = new Promise<IrcLogEntry>(resolve => {
			const unsubscribe = bus.onMessage(entry => {
				if (entry.message.to !== "Worker") return;
				unsubscribe();
				resolve(entry);
			});
		});
		try {
			const call = track(tool.execute("call-1", { op: "send", to: "Worker", message: "ping" }));
			await passReceiptDeadline();
			expect(call.result, "the send call did not return while the revival was gated").toBeDefined();

			releaseRevival();
			const entry = await legLogged;
			expect(entry.message.body).toBe("ping");
			expect(entry.outcome).toBe("revived");
		} finally {
			releaseRevival();
		}
	});

	it("reports an interrupted call as still under way when its signal aborts", async () => {
		gateParkedRevival();
		const tool = new IrcTool(makeToolSession(registry, "Main"));
		const controller = new AbortController();
		try {
			const call = track(
				tool.execute("call-1", { op: "send", to: "Worker", message: "ping" }, controller.signal),
			);
			controller.abort(new Error("steering"));
			await passReceiptDeadline();

			expect(call.result, "the send call did not return after its signal aborted").toBeDefined();
			expect(call.error).toBeUndefined();
			const result = call.result as AgentToolResult<IrcDetails>;
			expect(result.isError).toBeFalsy();
			expect(textOf(result)).toMatch(/The call was interrupted for Worker/);
			expect(textOf(result)).toMatch(/do not resend/);
			expect(textOf(result)).not.toMatch(/failed/);
		} finally {
			releaseRevival();
		}
	});

	it("keeps a quick successful hand-off truthful and unchanged", async () => {
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", session: makePeer(), status: "running" });
		const tool = new IrcTool(makeToolSession(registry, "Main"));

		const result = await tool.execute("call-1", { op: "send", to: "Worker", message: "ping" });

		expect(result.isError).toBeFalsy();
		expect(result.details?.receipts).toEqual([{ to: "Worker", outcome: "injected" }]);
		expect(textOf(result)).toMatch(/Delivered to 1 peer\(s\):/);
		expect(textOf(result)).toMatch(/- Worker: injected/);
		expect(textOf(result)).not.toMatch(/No receipt within/);
	});
});
