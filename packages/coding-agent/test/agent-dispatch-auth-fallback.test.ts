import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { kNoAuth } from "@veyyon/coding-agent/config/auth-state";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@veyyon/coding-agent/config/model-resolver";

/**
 * Ordered task-model resolution must stay inside the configured chain. A
 * parent model is not an implicit candidate when the configured chain fails.
 */


const parentModel: Model<Api> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedTaskModel: Model<Api> = buildModel({
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const sharedModel: Model<Api> = buildModel({
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
	suppressed?: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
	isSelectorSuppressed(selector: string): boolean;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
		isSelectorSuppressed: (selector: string) => options.suppressed?.has(selector) ?? false,
	} as unknown as ModelLookupRegistry & {
		getApiKey(model: Model<Api>): Promise<string | undefined>;
		isSelectorSuppressed(selector: string): boolean;
	};
}

describe("ordered agent model auth resolution", () => {
	test("selects the third configured member when earlier members are unavailable", async () => {
		const third = buildModel({
			id: "third-choice", name: "Third", api: "openai-completions",
			provider: "third-provider", baseUrl: "https://third.example",
			reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 8192,
		});
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel, third],
			authedProviders: new Set(["deepseek", "third-provider"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["missing-provider/missing-model", "qwen3.6-plus-free", "third-provider/third-choice"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.model?.provider).toBe("third-provider");
		expect(result.model?.id).toBe("third-choice");
		expect(result.authFallbackUsed).toBe(false);
	});

	test("fails with per-member reasons when no configured member is usable", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
			suppressed: ["opencode-zen/qwen3.6-plus-free"],
		});

		await expect(resolveModelOverrideWithAuthFallback(
			["missing-provider/missing-model", "qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			"deepseek/deepseek-v4-pro",
			registry,
		)).rejects.toThrow(/missing-provider\/missing-model.*not found.*qwen3\.6-plus-free.*suppressed.*deepseek\/deepseek-v4-pro.*outside configured chain/s);
	});

	test("does not select the parent when all configured models lack auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		await expect(resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		)).rejects.toThrow(/qwen3\.6-plus-free.*missing working credentials/);
	});

	test("keeps keyless models usable", async () => {
		const registry = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) =>
				model.provider === "opencode-zen" ? kNoAuth : "sk-test",
			isSelectorSuppressed: () => false,
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"], "deepseek/deepseek-v4-pro", registry,
		);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.authFallbackUsed).toBe(false);
	});
});

describe("session-sticky OAuth resolution", () => {
	test("forwards sessionId when checking the configured member", async () => {
		let receivedSessionId: string | undefined;
		const registry = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (model.provider === "opencode-zen") receivedSessionId = sessionId;
				return sessionId ? "sk-resolved-token" : undefined;
			},
			isSelectorSuppressed: () => false,
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"], "deepseek/deepseek-v4-pro", registry, undefined, "agent-session",
		);

		expect(receivedSessionId).toBe("agent-session");
		expect(result.model?.provider).toBe("opencode-zen");
	});
});

