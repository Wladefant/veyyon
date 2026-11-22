import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { PHASE_WATCHDOG_LIMITS_MS } from "@veyyon/coding-agent/task/run-monitor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { logger } from "@veyyon/utils";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

async function advanceTimersAndFlush(durationMs: number): Promise<void> {
	vi.advanceTimersByTime(durationMs);
	await Promise.resolve();
	await Promise.resolve();
}

describe("runSubprocess startup diagnostics", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "agent-startup-diag",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};
	it("records transcript open independently from launch-grant persistence while keeping sessionOpenMs inclusive", async () => {
		const debugSpy = vi.spyOn(logger, "debug");
		let now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const session = createMockSession(({ emit }) => {
			emit(yieldSuccessEvent({ ok: true }, "timing-split"));
		});
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			now += 5;
			return createSessionResult(session);
		});

		const withGrant = await runSubprocess({
			...baseOptions,
			id: "agent-timing-with-grant",
			settings: Settings.isolated({ "agent.maxRuntimeMs": 0 }),
			beforeChildStart: async () => {
				now += 25;
			},
		});
		expect(withGrant.exitCode).toBe(0);
		const withGrantCall = debugSpy.mock.calls.find(
			([message, context]) =>
				message === "agent launch timing" &&
				(context as Record<string, unknown> | undefined)?.id === "agent-timing-with-grant",
		);
		expect(withGrantCall).toBeDefined();
		const withGrantTiming = withGrantCall![1] as Record<string, number | undefined>;
		expect(typeof withGrantTiming.transcriptOpenMs).toBe("number");
		expect(typeof withGrantTiming.launchGrantMs).toBe("number");
		expect(withGrantTiming.launchGrantMs!).toBeGreaterThanOrEqual(15);
		expect(typeof withGrantTiming.sessionOpenMs).toBe("number");
		expect(withGrantTiming.sessionOpenMs!).toBeGreaterThanOrEqual(
			withGrantTiming.transcriptOpenMs! + withGrantTiming.launchGrantMs! - 2,
		);

		const withoutGrant = await runSubprocess({
			...baseOptions,
			id: "agent-timing-without-grant",
			settings: Settings.isolated({ "agent.maxRuntimeMs": 0 }),
		});
		expect(withoutGrant.exitCode).toBe(0);

		const withoutGrantCall = debugSpy.mock.calls.find(
			([message, context]) =>
				message === "agent launch timing" &&
				(context as Record<string, unknown> | undefined)?.id === "agent-timing-without-grant",
		);
		expect(withoutGrantCall).toBeDefined();
		const withoutGrantTiming = withoutGrantCall![1] as Record<string, number | undefined>;
		expect(typeof withoutGrantTiming.transcriptOpenMs).toBe("number");
		expect(withoutGrantTiming.launchGrantMs).toBeUndefined();
		expect(typeof withoutGrantTiming.sessionOpenMs).toBe("number");
	});

	it("reports the concrete setup phase when the session-initializing watchdog expires during launch-grant persistence", async () => {
		vi.useFakeTimers();
		let markGrantStarted!: () => void;
		const grantStarted = new Promise<void>(resolve => {
			markGrantStarted = resolve;
		});
		let releaseGrant!: () => void;
		const grantGate = new Promise<void>(resolve => {
			releaseGrant = resolve;
		});

		const run = runSubprocess({
			...baseOptions,
			id: "agent-stall-launch-grant",
			settings: Settings.isolated({ "agent.maxRuntimeMs": 0 }),
			beforeChildStart: async () => {
				markGrantStarted();
				await grantGate;
			},
		});

		await grantStarted;
		await advanceTimersAndFlush(PHASE_WATCHDOG_LIMITS_MS["session-initializing"] - 1);
		await advanceTimersAndFlush(1);
		releaseGrant();

		const result = await run;
		expect(result.terminalOutcome).toBe("stalled");
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("stalled");
		expect(result.abortReason).toContain("record-launch-grant");
	});

	it("reports create-session and still disposes a late-resolving session when the watchdog expires", async () => {
		vi.useFakeTimers();
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>(resolve => {
			markCreateStarted = resolve;
		});
		let releaseCreate!: () => void;
		const createGate = new Promise<void>(resolve => {
			releaseCreate = resolve;
		});
		const session = createMockSession(() => {});
		const disposeSpy = vi.spyOn(session, "dispose");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			markCreateStarted();
			await createGate;
			return createSessionResult(session);
		});

		const run = runSubprocess({
			...baseOptions,
			id: "agent-stall-create-session",
			settings: Settings.isolated({ "agent.maxRuntimeMs": 0 }),
		});

		await createStarted;
		await advanceTimersAndFlush(PHASE_WATCHDOG_LIMITS_MS["session-initializing"]);
		const result = await run;
		expect(result.terminalOutcome).toBe("stalled");
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("stalled");
		expect(result.abortReason).toContain("create-session");

		releaseCreate();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit upstream cancellation during setup classified as cancelled", async () => {
		const controller = new AbortController();
		let markGrantStarted!: () => void;
		const grantStarted = new Promise<void>(resolve => {
			markGrantStarted = resolve;
		});
		let releaseGrant!: () => void;
		const grantGate = new Promise<void>(resolve => {
			releaseGrant = resolve;
		});

		const run = runSubprocess({
			...baseOptions,
			id: "agent-cancel-during-setup",
			settings: Settings.isolated({ "agent.maxRuntimeMs": 0 }),
			signal: controller.signal,
			beforeChildStart: async () => {
				markGrantStarted();
				await grantGate;
			},
		});

		await grantStarted;
		controller.abort("operator stopped");
		const result = await run;
		releaseGrant();

		expect(result.terminalOutcome).toBe("cancelled");
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toBe("operator stopped");
	});
});
