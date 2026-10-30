import { vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { requireBundledModel } from "../../../agent/test/helpers";

/** A transport fault the retry machinery treats as transient: the provider hiccup. */
export const TRANSIENT_FAULT = "Error Code stream_read_error: stream_read_error";

/** The one tool the scripted model can call, so a turn either does tool work or only talks. */
export const NOTE_TOOL = "note";

export async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/**
 * A real `AgentSession` and `InteractiveMode` over a scripted provider, with the mode's goal
 * subscription installed by `init()`. The goal itself is not created here: a suite that needs one
 * creates it through `session.goalRuntime`, the path a `/goal` or a goal-tool create takes.
 */
export interface GoalSession {
	readonly session: AgentSession;
	readonly mode: InteractiveMode;
	/** The scripted provider; `calls` counts every model request. */
	readonly mock: MockModel;
	/** Every warning the mode put on screen, in order. */
	readonly warnings: string[];
	/** The last assistant stop reason of every `agent_end` the session emitted. */
	readonly stopReasons: Array<AssistantMessage["stopReason"] | undefined>;
	/**
	 * Arm the composer the way the interactive loop does and let the 800ms continuation timer
	 * fire. Returns the submission goal mode made, or `undefined` when it made none, and disarms
	 * the composer again in that case.
	 */
	awaitContinuation(): Promise<SubmittedUserInput | undefined>;
	/** Run a submission through the interactive loop's own submit path and wait for it to settle. */
	runSubmission(input: SubmittedUserInput): Promise<void>;
	/** An ordinary visible user turn, registered with the composer the way typing one is. */
	runUserTurn(text: string): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * Build a {@link GoalSession}. `responses` is the provider script, one entry per model call, so a
 * `throw` followed by content is one killed attempt and its retry. `overrides` win over the
 * defaults, which turn off everything that would open a turn of its own.
 */
export async function createGoalSession(
	responses: MockResponse[],
	overrides: Record<string, unknown> = {},
): Promise<GoalSession> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-session-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const model = requireBundledModel("openai", "gpt-5");

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"contextPromotion.enabled": false,
		"goal.enabled": true,
		"goal.continuationModes": ["interactive"],
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 50,
		"retry.maxRetries": 1,
		"retry.modelFallback": false,
		"todo.enabled": false,
		"todo.reminders": false,
		...overrides,
	});
	settings.setDefaultModel(`${model.provider}/${model.id}`);

	const noteTool: AgentTool = {
		name: NOTE_TOOL,
		label: "Note",
		description: "Record a note",
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "noted" }] }),
	};

	const mock = createMockModel({ responses });
	const agent = new Agent({
		getApiKey: () => "openai-test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [noteTool], messages: [] },
		streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map([[noteTool.name, noteTool]]),
		builtInToolNames: [NOTE_TOOL, "goal"],
	});

	// Retry delays are the provider's business, not a goal contract's.
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

	const stopReasons: Array<AssistantMessage["stopReason"] | undefined> = [];
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type !== "agent_end") return;
		const last = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		stopReasons.push(last?.stopReason);
	});

	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	const warnings: string[] = [];
	vi.spyOn(mode, "showWarning").mockImplementation(message => {
		warnings.push(message);
	});
	mode.ui.requestRender = vi.fn();
	await mode.init();
	await flushMicrotasks();

	const runSubmission = async (input: SubmittedUserInput): Promise<void> => {
		await submitInteractiveInput(mode, session, input);
		await session.waitForIdle();
		await flushMicrotasks();
	};

	return {
		session,
		mode,
		mock,
		warnings,
		stopReasons,
		async awaitContinuation() {
			vi.useFakeTimers();
			const submitted: SubmittedUserInput[] = [];
			void mode.getUserInput().then(input => submitted.push(input));
			await flushMicrotasks();
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			vi.useRealTimers();
			if (submitted.length === 0) mode.onInputCallback = undefined;
			return submitted.at(0);
		},
		runSubmission,
		runUserTurn: text => runSubmission(mode.startPendingSubmission({ text })),
		async dispose() {
			mode.stop();
			vi.useRealTimers();
			vi.restoreAllMocks();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}
