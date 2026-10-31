/**
 * The follow-ups a turn arms when it ends and the prompt stays idle: the idle compaction and the idle recap line,
 * and their cancellation when the controller is disposed.
 *
 * Subject: `modes/terminal/controllers/idle-follow-ups.ts`, driven through `EventController`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { ...emptyUsage(), input: 200, output: 10, totalTokens: 210 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ContextOptions = {
	contextTokens?: number;
	editorText?: string;
	goalObjective?: string;
	isCompacting?: boolean;
	isStreaming?: boolean;
	runIdleCompaction?: () => void;
	runEphemeralTurn?: (args: {
		promptText: string;
		signal?: AbortSignal;
	}) => Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
	sessionName?: string;
	showStatus?: (message: string, options?: { dim?: boolean }) => void;
	todoPhases?: InteractiveModeContext["todoPhases"];
};

function createContext(options: ContextOptions = {}): InteractiveModeContext {
	const runIdleCompaction = options.runIdleCompaction ?? (() => {});
	const runEphemeralTurn =
		options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() }));
	const goalState = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	const context = {
		isInitialized: true,
		loadingAnimation: undefined as { stop(): void } | undefined,
		clearWorkingLoader(): boolean {
			const self = this as { loadingAnimation?: { stop(): void } };
			if (!self.loadingAnimation) return false;
			self.loadingAnimation.stop();
			self.loadingAnimation = undefined;
			return true;
		},
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		settledToolCalls: new Set<string>(),
		flushPendingModelSwitch: async () => {},
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn() },
		statusLine: {
			invalidate: vi.fn(),
			markActivityStart: vi.fn(),
			markActivityEnd: vi.fn(),
			refreshGitStatus: vi.fn(),
		},
		editor: { getText: () => options.editorText ?? "" },
		sessionManager: { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		showStatus: options.showStatus ?? (() => {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			isStreaming: options.isStreaming ?? false,
			// Predictions off, so a finished turn does not reach the composer predictor.
			settings: { get: (key: string) => (key === "composer.predictions.mode" ? "off" : false) },
			runIdleCompaction,
			runEphemeralTurn,
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: options.contextTokens ?? 210 }),
			getGoalModeState: () => goalState,
			agent: { state: { messages: [createAssistantMessage()] } },
		},
		get viewSession() {
			return (this as typeof context).session;
		},
		clearTransientSessionUi: () => {},
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		clearPinnedError: () => {},
		ensureLoadingAnimation: () => {},
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return context;
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	/** Plays a finished turn and lets `ms` pass, returning how many idle compactions ran. */
	async function idleCompactionsAfter(
		ms: number,
		options: ContextOptions = {},
		between?: (context: InteractiveModeContext, controller: EventController) => Promise<void>,
	): Promise<number> {
		let runs = 0;
		const context = createContext({ ...options, runIdleCompaction: () => void runs++ });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		await between?.(context, controller);
		vi.advanceTimersByTime(ms);
		controller.dispose();
		return runs;
	}

	it("runs the idle compaction once its timeout passes with the context over the threshold", async () => {
		expect(await idleCompactionsAfter(59_999)).toBe(0);
		expect(await idleCompactionsAfter(60_000)).toBe(1);
	});

	it("arms no idle compaction while the context is under the threshold", async () => {
		expect(await idleCompactionsAfter(60_000, { contextTokens: 99 })).toBe(0);
		expect(await idleCompactionsAfter(60_000, { contextTokens: 100 })).toBe(1);
	});

	it("arms no idle compaction while the editor holds a draft", async () => {
		expect(await idleCompactionsAfter(60_000, { editorText: "draft" })).toBe(0);
	});

	it("drops an armed idle compaction when a turn is streaming by the time it fires", async () => {
		const runs = await idleCompactionsAfter(60_000, {}, async context => {
			(context.session as { isStreaming: boolean }).isStreaming = true;
		});
		expect(runs).toBe(0);
	});

	it("cancels the armed idle compaction when the next turn starts", async () => {
		const runs = await idleCompactionsAfter(60_000, {}, async (_context, controller) => {
			await controller.handleEvent({ type: "agent_start" });
		});
		expect(runs).toBe(0);
	});

	it("anchors the recap on the goal before the session name", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "compaction.idleEnabled": false, "completion.notify": "off", "recap.idleSeconds": 1 },
		});
		const prompts: string[] = [];
		const context = createContext({
			goalObjective: "Ship the parser",
			sessionName: "Fix login flow",
			runEphemeralTurn: async args => {
				prompts.push(args.promptText);
				return { replyText: "", assistantMessage: createAssistantMessage() };
			},
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		controller.dispose();

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Ship the parser");
		expect(prompts[0]).not.toContain("Fix login flow");
	});

	it("emits an LLM-generated recap after the default four-minute delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		let capturedPrompt = "";
		const runEphemeralTurn = vi.fn(async (args: { promptText: string; signal?: AbortSignal }) => {
			capturedPrompt = args.promptText;
			return {
				replyText: "Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
				assistantMessage: createAssistantMessage(),
			};
		});
		const context = createContext({
			sessionName: "Fix login flow",
			showStatus,
			runEphemeralTurn,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(239_999);
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		// Live goal/title and the active todo task anchor the recap prompt the snapshot can't guarantee.
		expect(capturedPrompt).toContain("Fix login flow");
		expect(capturedPrompt).toContain("Wire focused tests");

		expect(showStatus).toHaveBeenCalledTimes(1);
		const [message, options] = showStatus.mock.calls[0] ?? [];
		expect(Bun.stripANSI(message ?? "")).toBe(
			"※ recap: Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
		);
		expect(options).toEqual({ dim: false });
		controller.dispose();
	});

	it("keeps the idle recap silent when disabled", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 1,
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const prompts: string[] = [];
		const context = createContext({
			sessionName: "Fix login flow",
			showStatus,
			// A reply that would paint a recap, so silence comes from the setting and not from an empty reply.
			runEphemeralTurn: async args => {
				prompts.push(args.promptText);
				return { replyText: "Reworking the login flow.", assistantMessage: createAssistantMessage() };
			},
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(prompts).toEqual([]);
		expect(showStatus).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("keeps the idle recap silent while the editor has a draft", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.idleSeconds": 1,
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const context = createContext({
			editorText: "draft",
			sessionName: "Fix login flow",
			showStatus,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);

		expect(showStatus).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("aborts the in-flight recap and drops its late reply when disposed", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		let receivedSignal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn((args: { promptText: string; signal?: AbortSignal }) => {
			receivedSignal = args.signal;
			return promise;
		});
		const context = createContext({ sessionName: "Fix login flow", showStatus, runEphemeralTurn });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(240_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(receivedSignal?.aborted).toBe(false);

		controller.dispose();
		expect(receivedSignal?.aborted).toBe(true);

		// A reply that lands after cancellation must not paint a stale recap.
		resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(showStatus).not.toHaveBeenCalled();
	});
});
