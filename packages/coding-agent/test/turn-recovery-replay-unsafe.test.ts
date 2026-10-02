import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Model, Provider, Usage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { hasReplayUnsafeOutput } from "@veyyon/coding-agent/session/failed-turn";
import {
	RetryFallback,
	type RetryFallbackHost,
	type RetryFallbackSession,
} from "@veyyon/coding-agent/session/runtime/retry-fallback";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages" as Api,
		provider: "anthropic" as Provider,
		model: "claude-sonnet-4-5",
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function makeFireworksFastMessage(
	content: AssistantMessage["content"],
	errorMessage = "router unavailable",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions" as Api,
		provider: "fireworks" as Provider,
		model: "deepseek-v3-fast",
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type RetryFallbackAppliedEvent = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;

function trackSessionEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
	fallbackAppliedEvents: RetryFallbackAppliedEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	const fallbackAppliedEvents: RetryFallbackAppliedEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retryStartEvents.push(event);
		if (event.type === "auto_retry_end") retryEndEvents.push(event);
		if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
	});
	return { retryStartEvents, retryEndEvents, fallbackAppliedEvents };
}

describe("turn recovery replay-unsafe output classification", () => {
	it("treats a failed turn with partial non-whitespace text as replay-unsafe", () => {
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(true);
	});

	it("treats a thinking-only partial turn as replay-safe", () => {
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(false);
	});

	it("treats a whitespace-only text partial as replay-safe", () => {
		const message = makeMessage([{ type: "text", text: "   \n\n  " }]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(false);
	});

	it("keeps an empty-content error replay-safe", () => {
		const message = makeMessage([]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(false);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const message = makeMessage([
			{ type: "thinking", thinking: "Reasoning before the visible answer." },
			{ type: "text", text: "The answer is 42." },
		]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(true);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const message = makeMessage([
			{ type: "thinking", thinking: "Long reasoning." },
			{ type: "text", text: "  " },
		]);
		expect(hasReplayUnsafeOutput(message, [])).toBe(false);
	});

	it("treats a tool-call with executed result in context as replay-unsafe", () => {
		const message = makeMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }]);
		const context: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		expect(hasReplayUnsafeOutput(message, context)).toBe(true);
	});
});

describe("RetryFallback replay safety filtering", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-replay-unsafe-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		await authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		await authStorage.setRuntimeApiKey("openai", "openai-test-key");
		await authStorage.setRuntimeApiKey("fireworks", "fireworks-test-key");

		const modelsYmlContent = `providers:
  fireworks:
    baseUrl: "https://api.fireworks.ai/inference/v1"
    apiKey: "fireworks-test-key"
    models:
      - id: "deepseek-v3"
        name: "DeepSeek V3"
        api: "openai-completions"
        contextWindow: 128000
        maxTokens: 64000
      - id: "deepseek-v3-fast"
        name: "DeepSeek V3 Fast"
        api: "openai-completions"
        contextWindow: 128000
        maxTokens: 64000
`;
		await fs.promises.writeFile(tempDir.join("models.yml"), modelsYmlContent, "utf-8");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createFallback(options?: { model?: Model; fallbackChains?: Record<string, string[]> }): RetryFallback {
		const activeModel = options?.model ?? model;
		const settings = Settings.isolated({
			"retry.enabled": true,
			"retry.modelFallback": true,
			...(options?.fallbackChains ? { "retry.fallbackChains": options.fallbackChains } : {}),
		});
		const session: RetryFallbackSession = {
			agent: { state: { messages: [] } } as never,
			sessionManager: undefined as never,
			settings,
			modelRegistry,
			model: activeModel,
			thinkingLevel: undefined,
			setThinkingLevel: () => {},
			configuredThinkingLevel: () => undefined,
			sessionId: "test-session",
		};
		const host: RetryFallbackHost = {
			emitSessionEvent: async () => {},
			setModelWithProviderSessionReset: () => {},
			classify: () => 0,
		};
		return new RetryFallback(session, host);
	}

	it("finds a replay-safe failed turn fallback-eligible when a fallback chain is configured (positive control)", () => {
		const fallback = createFallback({
			fallbackChains: {
				[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
			},
		});
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }]);
		expect(fallback.hardErrorEligible(message)).toBe(true);
	});

	it("excludes a failed turn with partial non-whitespace text from fallback candidates", () => {
		const fallback = createFallback({
			fallbackChains: {
				[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
			},
		});
		const message = makeMessage([{ type: "text", text: "partial visible output" }]);
		expect(fallback.hardErrorEligible(message)).toBe(false);
	});

	it("excludes a Fireworks Fast failed turn with partial non-whitespace text from base fallback", () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const fallback = createFallback({ model: fastModel });
		const message = makeFireworksFastMessage([{ type: "text", text: "Already visible answer" }]);
		expect(fallback.fireworksFastEligible(message)).toBe(false);
	});

	it("finds a Fireworks Fast failed turn with thinking-only content eligible for base fallback (positive control)", () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const fallback = createFallback({ model: fastModel });
		const message = makeFireworksFastMessage([{ type: "thinking", thinking: "deep reasoning before router error" }]);
		expect(fallback.fireworksFastEligible(message)).toBe(true);
	});

	it("finds a Fireworks Fast failed turn with whitespace-only text eligible for base fallback", () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const fallback = createFallback({ model: fastModel });
		const message = makeFireworksFastMessage([{ type: "text", text: "   \n\t  " }]);
		expect(fallback.fireworksFastEligible(message)).toBe(true);
	});

	it("finds a Fireworks Fast failed turn with empty content eligible for base fallback", () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const fallback = createFallback({ model: fastModel });
		const message = makeFireworksFastMessage([]);
		expect(fallback.fireworksFastEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with an unexecuted tool call from base fallback (preserving tool restrictions)", () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const fallback = createFallback({ model: fastModel });
		const message = makeFireworksFastMessage([
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
		]);
		expect(fallback.fireworksFastEligible(message)).toBe(false);
	});
});

describe("AgentSession transient-error recovery replay safety", () => {
	const gptModel = getBundledModel("openai", "gpt-4o-mini");
	if (!gptModel) throw new Error("Expected bundled openai/gpt-4o-mini model");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-transient-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		await authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("disallows retry when a failed turn streamed partial visible text on transient error", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: ["partial visible output that already reached the user"],
					stopReason: "error",
					errorMessage: "rate limit exceeded retry-after-ms=5",
				},
				{
					content: ["should never be requested because turn is replay-unsafe"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: gptModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${gptModel.provider}/${gptModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(1);
		expect(mock.calls).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(session.isRetrying).toBe(false);

		const lastMsg = session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("error");
			expect(lastMsg.content).toEqual([
				{ type: "text", text: "partial visible output that already reached the user" },
			]);
		}
		await session.dispose();
	});

	it("retries and recovers when a failed turn streamed thinking-only content on transient error", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "thinking", thinking: "thinking before transient error" }],
					stopReason: "error",
					errorMessage: "rate limit exceeded retry-after-ms=5",
				},
				{
					content: ["recovered answer on retry"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: gptModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${gptModel.provider}/${gptModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);

		const lastMsg = session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("stop");
			expect(lastMsg.content).toEqual([{ type: "text", text: "recovered answer on retry" }]);
		}
		await session.dispose();
	});

	it("retries and recovers when a failed turn has whitespace-only text on transient error", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: ["   \n\t  "],
					stopReason: "error",
					errorMessage: "rate limit exceeded retry-after-ms=5",
				},
				{
					content: ["recovered answer after whitespace retry"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: gptModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${gptModel.provider}/${gptModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		await session.dispose();
	});

	it("retries and recovers when a failed turn has empty content on transient error", async () => {
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [],
					stopReason: "error",
					errorMessage: "rate limit exceeded retry-after-ms=5",
				},
				{
					content: ["recovered answer after empty retry"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: gptModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${gptModel.provider}/${gptModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		await session.dispose();
	});
});

describe("AgentSession Fireworks Fast recovery replay safety", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-fireworks-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		await authStorage.setRuntimeApiKey("fireworks", "fireworks-test-key");

		const modelsYmlContent = `providers:
  fireworks:
    baseUrl: "https://api.fireworks.ai/inference/v1"
    apiKey: "fireworks-test-key"
    models:
      - id: "deepseek-v3"
        name: "DeepSeek V3"
        api: "openai-completions"
        contextWindow: 128000
        maxTokens: 64000
      - id: "deepseek-v3-fast"
        name: "DeepSeek V3 Fast"
        api: "openai-completions"
        contextWindow: 128000
        maxTokens: 64000
`;
		await fs.promises.writeFile(tempDir.join("models.yml"), modelsYmlContent, "utf-8");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("disallows Fireworks Fast base-model fallback when the failed turn streamed visible text", async () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: ["Already visible answer before router died"],
					stopReason: "error",
					errorMessage: "router unavailable",
				},
				{
					content: ["should not be called on base model"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: fastModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${fastModel.provider}/${fastModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, fallbackAppliedEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["fireworks/deepseek-v3-fast"]);
		expect(mock.calls).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(session.model?.id).toBe("deepseek-v3-fast");

		const lastMsg = session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("error");
			expect(lastMsg.content).toEqual([{ type: "text", text: "Already visible answer before router died" }]);
		}
		await session.dispose();
	});

	it("degrades Fireworks Fast to base model and recovers when the failed turn has thinking-only content", async () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "thinking", thinking: "reasoning before router failure" }],
					stopReason: "error",
					errorMessage: "router unavailable",
				},
				{
					content: ["recovered on base model"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: fastModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${fastModel.provider}/${fastModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents, fallbackAppliedEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["fireworks/deepseek-v3-fast", "fireworks/deepseek-v3"]);
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: "fireworks/deepseek-v3-fast",
				to: "fireworks/deepseek-v3",
				role: "fireworks-fast",
			},
		]);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.model?.id).toBe("deepseek-v3");

		const lastMsg = session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("stop");
			expect(lastMsg.content).toEqual([{ type: "text", text: "recovered on base model" }]);
		}
		await session.dispose();
	});

	it("disallows Fireworks Fast base-model fallback when turn contains an unexecuted tool call", async () => {
		const fastModel = modelRegistry.find("fireworks", "deepseek-v3-fast");
		if (!fastModel) throw new Error("Expected deepseek-v3-fast in registry");
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
					stopReason: "error",
					errorMessage: "router unavailable",
				},
				{
					content: ["should not be called on base model"],
					stopReason: "stop",
				},
			],
		});
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: {
				model: fastModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (reqModel, ctx, opts) => {
				requestedModels.push(`${reqModel.provider}/${reqModel.id}`);
				return mock.stream(reqModel, ctx, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${fastModel.provider}/${fastModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, fallbackAppliedEvents } = trackSessionEvents(session);

		await session.prompt("test prompt");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["fireworks/deepseek-v3-fast"]);
		expect(mock.calls).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(fallbackAppliedEvents).toHaveLength(0);
		await session.dispose();
	});
});
