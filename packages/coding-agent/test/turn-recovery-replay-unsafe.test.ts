import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Model, Provider, Usage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { hasReplayUnsafeOutput } from "@veyyon/coding-agent/session/failed-turn";
import {
	RetryFallback,
	type RetryFallbackHost,
	type RetryFallbackSession,
} from "@veyyon/coding-agent/session/runtime/retry-fallback";
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
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createFallback(fallbackChains?: Record<string, string[]>): RetryFallback {
		const settings = Settings.isolated({
			"retry.enabled": true,
			"retry.modelFallback": true,
			...(fallbackChains ? { "retry.fallbackChains": fallbackChains } : {}),
		});
		const session: RetryFallbackSession = {
			agent: { state: { messages: [] } } as never,
			sessionManager: undefined as never,
			settings,
			modelRegistry,
			model,
			thinkingLevel: undefined,
			setThinkingLevel: () => {},
			configuredThinkingLevel: () => undefined,
			thinkingLevelCeiling: () => undefined,
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
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		});
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }]);
		expect(fallback.hardErrorEligible(message)).toBe(true);
	});

	it("excludes a failed turn with partial non-whitespace text from fallback candidates", () => {
		const fallback = createFallback({
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		});
		const message = makeMessage([{ type: "text", text: "partial visible output" }]);
		expect(fallback.hardErrorEligible(message)).toBe(false);
	});
});
