import { afterEach, describe, expect, it, vi } from "bun:test";
import { createAgentRunMonitor } from "@veyyon/coding-agent/task/run-monitor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";

const agent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Do the task.",
	source: "bundled",
};

function createMonitor(modelId: string) {
	const monitor = createAgentRunMonitor({
		index: 0,
		id: "idle-test",
		agent,
		task: "test idle wait",
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: 0,
	});
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const sendUserMessage = vi.fn(async () => {});
	const abort = vi.fn(async () => {});
	const unsubscribe = vi.fn();
	const session = {
		model: { id: modelId },
		subscribe: vi.fn((callback: (event: AgentSessionEvent) => void) => {
			listener = callback;
			return unsubscribe;
		}),
		sendUserMessage,
		abort,
	} as unknown as AgentSession;
	monitor.setActiveSession(session);
	const detach = monitor.attach(session);
	return {
		monitor,
		session,
		sendUserMessage,
		abort,
		unsubscribe,
		detach,
		emit(event: AgentSessionEvent) {
			listener?.(event);
		},
	};
}

function toolStart(toolName: string, args: Record<string, unknown>, toolCallId = "wait-1"): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolName,
		toolCallId,
		args,
	} as AgentSessionEvent;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("run monitor idle-wait hints", () => {
	it("does not hint at five minutes, then hints once after the boundary without aborting", async () => {
		vi.useFakeTimers();
		const harness = createMonitor("openai/gpt-6.1-sol");
		harness.emit(toolStart("job", { op: "poll" }));
		vi.advanceTimersByTime(300_000); await flushMicrotasks();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1); await flushMicrotasks();
		await flushMicrotasks();
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"This wait has taken more than five minutes. If the wait can be delegated, hand it to a task/Luna child to poll while you continue useful work. Do not cancel the wait or make an extra request.",
			{ deliverAs: "steer" },
		);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(harness.monitor.abortSignal.aborted).toBe(false);
		harness.monitor.finish();
	});

	it.each(["gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra"])(
		"recognizes supported real model id %s",
		async modelId => {
			vi.useFakeTimers();
			const harness = createMonitor(modelId);
			harness.emit(toolStart("job", { op: "wait" }));
			vi.advanceTimersByTime(300_001); await flushMicrotasks();
			await flushMicrotasks();
			expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
			harness.monitor.finish();
		},
	);

	it.each([
		["job poll", "job", { op: "poll" }, true],
		["job wait", "job", { op: "wait" }, true],
		["job list", "job", { op: "list" }, false],
		["irc wait", "irc", { op: "wait" }, true],
		["irc awaited send", "irc", { op: "send", await: true }, true],
		["irc ordinary send", "irc", { op: "send", await: false }, false],
		["build slot run", "bash", { command: "python build_slot.py run test" }, true],
		["ordinary bash", "bash", { command: "python script.py" }, false],
		["actual job poll", "job", { poll: ["job-1"] }, true],
		["actual job default wait", "job", {}, true],
		["actual job list", "job", { list: true }, false],
		["actual job cancel", "job", { cancel: ["job-1"] }, false],
	] as const)("classifier: %s", async (_label, toolName, args, shouldHint) => {
		vi.useFakeTimers();
		const harness = createMonitor("gpt-6.1-sol");
		harness.emit(toolStart(toolName, args));
		vi.advanceTimersByTime(300_001); await flushMicrotasks();
		await flushMicrotasks();
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(shouldHint ? 1 : 0);
		harness.monitor.finish();
	});

	it.each(["luna", "gemini-3.8-flash", "google/gemini-3.8-flash"])(
		"does not hint for non-eligible model %s",
		async modelId => {
			vi.useFakeTimers();
			const harness = createMonitor(modelId);
			harness.emit(toolStart("job", { op: "poll" }));
			vi.advanceTimersByTime(300_001); await flushMicrotasks();
			expect(harness.sendUserMessage).not.toHaveBeenCalled();
			harness.monitor.finish();
		},
	);

	it("tracks concurrent waits independently and clears a completed wait", async () => {
		vi.useFakeTimers();
		const harness = createMonitor("gpt-6.1-sol");
		harness.emit(toolStart("job", { op: "poll" }, "first"));
		vi.advanceTimersByTime(200_000); await flushMicrotasks();
		harness.emit(toolStart("irc", { op: "wait" }, "second"));
		vi.advanceTimersByTime(100_001); await flushMicrotasks();
		await flushMicrotasks();
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		harness.emit({ type: "tool_execution_end", toolName: "irc", toolCallId: "second" } as AgentSessionEvent);
		vi.advanceTimersByTime(199_999); await flushMicrotasks();
		await flushMicrotasks();
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1); await flushMicrotasks();
		await flushMicrotasks();
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
		harness.monitor.finish();
	});

	it("clears pending waits on finish, detach, and active-session replacement", async () => {
		vi.useFakeTimers();
		const finishing = createMonitor("gpt-6.1-sol");
		finishing.emit(toolStart("job", { op: "poll" }));
		finishing.monitor.finish();
		vi.advanceTimersByTime(300_001); await flushMicrotasks();
		expect(finishing.sendUserMessage).not.toHaveBeenCalled();

		const detached = createMonitor("gpt-6.1-sol");
		detached.emit(toolStart("job", { op: "poll" }));
		detached.detach();
		vi.advanceTimersByTime(300_001); await flushMicrotasks();
		expect(detached.sendUserMessage).not.toHaveBeenCalled();

		const replaced = createMonitor("gpt-6.1-sol");
		replaced.emit(toolStart("job", { op: "poll" }));
		const replacement = { sendUserMessage: vi.fn(async () => {}) } as unknown as AgentSession;
		replaced.monitor.setActiveSession(replacement);
		vi.advanceTimersByTime(300_001); await flushMicrotasks();
		expect(replaced.sendUserMessage).not.toHaveBeenCalled();
		expect(replacement.sendUserMessage).not.toHaveBeenCalled();
		detached.monitor.finish();
		const aborted = createMonitor("gpt-6.1-sol");
		aborted.emit(toolStart("job", { poll: ["job-1"] }));
		aborted.monitor.requestAbort("signal");
		vi.advanceTimersByTime(300_001); await flushMicrotasks();
		expect(aborted.sendUserMessage).not.toHaveBeenCalled();
		aborted.monitor.finish();
		replaced.monitor.finish();
	});
});
