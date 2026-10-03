import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.disableLoopMode("Loop mode disabled.");
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/**
	 * The invariant every test below rests on, asserted at the choke point rather
	 * than through one of its symptoms. `getUserInput` installs the input callback
	 * and arms the loop and goal timers with no `await` in front of them. An
	 * `async` guard that early-returns still yields a microtask, and in that tick
	 * there is no callback for an arriving submission to reach and no timer armed
	 * for the loop; the compact test below is the symptom that showed it, but a
	 * later refactor can reintroduce the await without touching loop mode at all.
	 */
	it("installs the input callback before it yields, so no submission lands in a gap", () => {
		vi.useFakeTimers();
		mode.loopModeEnabled = true;
		mode.loopPrompt = "armed synchronously";

		void mode.getUserInput();

		expect(mode.onInputCallback).toBeDefined();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});
	it("Esc ends the live turn, suspends resubmission, and resumes only with a manual prompt", async () => {
		// Only the external provider stream is faked; loop timers, pause, editor dispatch and session abort are real.
		const started = Promise.withResolvers<void>();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session.agent.streamFn = (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("working") });
				options?.signal?.addEventListener(
					"abort",
					() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...createAssistantMessage("interrupted"), stopReason: "aborted" },
						});
					},
					{ once: true },
				);
				started.resolve();
			});
			return stream;
		};
		const turn = session.prompt("captured loop body");
		await started.promise;
		expect(session.isStreaming).toBe(true);
		vi.useFakeTimers();
		mode.loopModeEnabled = true;
		mode.loopPrompt = "captured loop body";
		const pending = mode.startPendingSubmission({ text: "deferred loop body", customType: "loop" });
		const controller = new InputController(mode);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));
		mode.editor.onEscape?.();
		await turn;
		expect(session.isStreaming).toBe(false);
		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopPrompt).toBeUndefined();
		vi.advanceTimersByTime(1600);
		expect(pending.cancelled).toBe(true);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);
		mode.editor.onSubmit?.("new manual body");
		for (let tick = 0; tick < 20 && resolved.length === 0; tick++) await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("new manual body");
		expect(mode.loopPrompt).toBe("new manual body");
		const repeated: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => repeated.push(input));
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(repeated).toHaveLength(1);
		expect(repeated[0].text).toBe("new manual body");
	}, 30000);
});
