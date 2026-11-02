import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { createAgentRunMonitor } from "@veyyon/coding-agent/task/run-monitor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

const agent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Do the task.",
	source: "bundled",
};

function createMonitor() {
	const monitor = createAgentRunMonitor({
		index: 0,
		id: "phase-test",
		agent,
		task: "test phase watchdog",
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: 0,
	});
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const abort = vi.fn(async () => {});
	const session = {
		model: { id: "test-model" },
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
	it("aborts a startup run at the two-minute no-progress boundary", () => {
		vi.useFakeTimers();
		const { monitor, abort } = createMonitor();

		vi.advanceTimersByTime(119_999);
		expect(monitor.abortSignal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.abortKind()).toBe("stalled");
		expect(abort).toHaveBeenCalledTimes(1);
		monitor.finish();
	});

	it("resets the streaming stall clock on real progress events, but not display heartbeats", () => {
		vi.useFakeTimers();
		const { monitor, emit } = createMonitor();
		emit(event("message_start", { message: { role: "assistant", content: [] } }));
		vi.advanceTimersByTime(179_999);
		emit(event("message_update", { message: { role: "assistant", content: [{ type: "text", text: "working" }] } }));
		vi.advanceTimersByTime(179_998);
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
			vi.advanceTimersByTime(179_999);
			emit(
				event("message_update", { message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] } }),
			);
			expect(monitor.abortSignal.aborted).toBe(false);
		}
		monitor.finish();
		vi.advanceTimersByTime(180_000);
		expect(monitor.abortSignal.aborted).toBe(false);
		expect(monitor.abortKind()).toBeUndefined();
	});
});
