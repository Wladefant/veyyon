import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import {
	createAgentRunMonitor,
	PHASE_WATCHDOG_LIMITS_MS,
	WATCHDOG_TRANSPORT_SLACK_MS,
} from "@veyyon/coding-agent/task/run-monitor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

const agent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Do the task.",
	source: "bundled",
};

function createMonitor(options?: { model?: Record<string, unknown>; settings?: Settings }) {
	const monitor = createAgentRunMonitor({
		index: 0,
		id: "phase-test",
		agent,
		task: "test phase watchdog",
		settings: options?.settings,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: 0,
	});
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const abort = vi.fn(async () => {});
	const session = {
		model: options?.model ?? { id: "test-model" },
		subscribe: vi.fn((callback: (event: AgentSessionEvent) => void) => {
			listener = callback;
			return vi.fn();
		}),
		abort,
	} as unknown as AgentSession;
	monitor.setActiveSession(session);
	monitor.attach(session);
	activeMonitors.push(monitor);
	return {
		monitor,
		abort,
		emit(event: AgentSessionEvent) {
			listener?.(event);
		},
	};
}

function event(type: string, fields: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...fields } as AgentSessionEvent;
}

const activeMonitors: Array<{ finish: () => void }> = [];

afterEach(() => {
	for (const { finish } of activeMonitors.splice(0)) finish();
	vi.useRealTimers();
});

describe("run monitor phase supervision", () => {
	it("allows the provider default first-response window before declaring a stall", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("agent_start"));
		emit(event("turn_start"));
		vi.advanceTimersByTime(299_999);
		expect(monitor.abortSignal.aborted).toBe(false);
		monitor.finish();
	});

	it("renews the watchdog for nonempty thinking deltas", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("message_start", { message: { role: "assistant", content: [] } }));
		vi.advanceTimersByTime(299_999);
		emit(
			event("message_update", {
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
			}),
		);
		vi.advanceTimersByTime(120_001);
		expect(monitor.abortSignal.aborted).toBe(false);
		monitor.finish();
	});

	it("renews the watchdog when a retry changes the active model", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("agent_start"));
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.startup - 1);
		emit(event("retry_fallback_applied", { from: "first", to: "fallback" }));
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.startup - 1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("does not recover into a session that is still streaming after abort", async () => {
		vi.useFakeTimers();
		const { monitor } = createMonitor();
		monitor.setActiveSession({
			isStreaming: true,
			abort: async () => {},
		} as unknown as AgentSession);
		monitor.requestAbort("stalled");
		await monitor.waitForActiveSessionAbort();
		expect(monitor.prepareStallRecovery()).toBe(false);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("aborts a startup run at the five-minute no-progress boundary", () => {
		vi.useFakeTimers();
		const { monitor } = createMonitor();

		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.startup - 1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("does not renew the streaming watchdog for unchanged non-text updates", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("message_start", { message: { role: "assistant", content: [] } }));
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.streaming - 1);
		emit(
			event("message_update", {
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "thinking_start" },
			}),
		);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("does not renew the child watchdog for unchanged task updates", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("tool_execution_start", { toolName: "task", toolCallId: "child-1", args: { task: "delegate" } }));
		const details = { results: [], totalDurationMs: 0 };
		emit(event("tool_execution_update", { toolName: "task", toolCallId: "child-1", partialResult: { details } }));
		vi.advanceTimersByTime(1_799_999);
		emit(
			event("tool_execution_update", {
				toolName: "task",
				toolCallId: "child-1",
				partialResult: { details: { results: [], totalDurationMs: 0 } },
			}),
		);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("renews the child watchdog when task details change", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("tool_execution_start", { toolName: "task", toolCallId: "child-1", args: { task: "delegate" } }));
		emit(
			event("tool_execution_update", {
				toolName: "task",
				toolCallId: "child-1",
				partialResult: { details: { results: [], totalDurationMs: 0 } },
			}),
		);
		vi.advanceTimersByTime(1_799_999);
		emit(
			event("tool_execution_update", {
				toolName: "task",
				toolCallId: "child-1",
				partialResult: { details: { results: [], totalDurationMs: 1 } },
			}),
		);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1_799_999);
		expect(monitor.abortSignal.aborted).toBe(true);
		monitor.finish();
	});

	it("resets the streaming stall clock on real progress events, but not display heartbeats", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("message_start", { message: { role: "assistant", content: [] } }));
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.streaming - 1);
		emit(event("message_update", { message: { role: "assistant", content: [{ type: "text", text: "working" }] } }));
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.streaming - 2);
		monitor.scheduleProgress(true);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("uses the tool-running window instead of the shorter streaming window", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("tool_execution_start", { toolName: "read", toolCallId: "read-1", args: { path: "file.ts" } }));
		vi.advanceTimersByTime(899_999);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("gives a nested task child the thirty-minute wait window", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("tool_execution_start", { toolName: "task", toolCallId: "child-1", args: { task: "delegate" } }));
		vi.advanceTimersByTime(1_799_999);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("keeps resetting on repeated progress and clears the watchdog on finish", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("message_start", { message: { role: "assistant", content: [] } }));
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.streaming - 1);
			emit(
				event("message_update", { message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] } }),
			);
			expect(monitor.abortSignal.aborted).toBe(false);
		}
		monitor.finish();
		vi.advanceTimersByTime(PHASE_WATCHDOG_LIMITS_MS.streaming);
		expect(monitor.abortSignal.aborted).toBe(false);
		expect(monitor.abortKind()).toBeUndefined();
	});

	it("scales the streaming watchdog above an elevated provider first-event timeout", () => {
		vi.useFakeTimers();
		const previous = process.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS;
		process.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "420000";
		try {
			const { monitor, emit } = createMonitor();
			emit(event("agent_start"));
			vi.advanceTimersByTime(420_000 + WATCHDOG_TRANSPORT_SLACK_MS - 1);
			expect(monitor.abortSignal.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(monitor.abortSignal.aborted).toBe(true);
			expect(monitor.abortKind()).toBe("stalled");
			monitor.finish();
		} finally {
			if (previous === undefined) delete process.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS;
			else process.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = previous;
		}
	});

	it("scales the startup and streaming watchdogs from model.compat.streamIdleTimeoutMs", () => {
		vi.useFakeTimers();
		const { monitor } = createMonitor({
			model: { id: "slow-local-model", compat: { streamIdleTimeoutMs: 420_000 } },
		});
		vi.advanceTimersByTime(420_000 + WATCHDOG_TRANSPORT_SLACK_MS - 1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});

	it("scales the streaming watchdog from providers.streamIdleTimeoutSeconds settings", () => {
		vi.useFakeTimers();
		const settings = Settings.isolated({ "providers.streamIdleTimeoutSeconds": 420 });
		const { monitor, emit } = createMonitor({ settings });
		emit(event("agent_start"));
		vi.advanceTimersByTime(420_000 + WATCHDOG_TRANSPORT_SLACK_MS - 1);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		monitor.finish();
	});
});
