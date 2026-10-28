import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { kNoAuth } from "@veyyon/coding-agent/config/auth-state";
import { resolveAgentModelChain } from "@veyyon/coding-agent/config/model-resolver";

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


interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
	suppressed?: readonly string[];
}

function createMockRegistry(options: MockRegistryOptions) {
	return {
		getAll: () => options.models,
		getAvailable: () => options.models.filter(model => options.authedProviders.has(model.provider)),
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
		isSelectorSuppressed: (selector: string) => options.suppressed?.includes(selector) ?? false,
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
			models: [unauthedTaskModel, third],
			authedProviders: new Set(["third-provider"]),
		});

		const result = await resolveAgentModelChain(
			["missing-provider/missing-model", "qwen3.6-plus-free", "third-provider/third-choice"],
			registry,
		);

		expect(result.model?.provider).toBe("third-provider");
		expect(result.model?.id).toBe("third-choice");
	});

	test("fails with per-member reasons when no configured member is usable", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
			suppressed: ["opencode-zen/qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
		});

		await expect(resolveAgentModelChain(
			["missing-provider/missing-model", "qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
		)).rejects.toThrow(/missing-provider\/missing-model.*not found.*qwen3\.6-plus-free.*suppressed.*deepseek\/deepseek-v4-pro.*suppressed/s);
	});

	test("does not select the parent when all configured models lack auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		await expect(resolveAgentModelChain(
			["qwen3.6-plus-free"],
			registry,
		)).rejects.toThrow(/qwen3\.6-plus-free.*missing working credentials/);
	});

	test("does not expose a thrown provider auth error", async () => {
		const secretLikeError = "provider rejected API key sk-fake-secret";
		const registry = {
			getAll: () => [unauthedTaskModel],
			getAvailable: () => [unauthedTaskModel],
			getApiKey: async () => {
				throw new Error(secretLikeError);
			},
			isSelectorSuppressed: () => false,
		};

		let surfacedError: unknown;
		try {
			await resolveAgentModelChain(["qwen3.6-plus-free"], registry);
		} catch (error) {
			surfacedError = error;
		}

		expect(surfacedError).toBeInstanceOf(Error);
		if (surfacedError instanceof Error) {
			expect(surfacedError.message).toContain("missing working credentials");
			expect(surfacedError.message).not.toContain("sk-fake-secret");
		}
	});

	test("rejects an authenticated catalog model excluded from available models", async () => {
		const registry = {
			getAll: () => [unauthedTaskModel],
			getAvailable: () => [],
			getApiKey: async () => "sk-test-token",
			isSelectorSuppressed: () => false,
		};

		await expect(resolveAgentModelChain(["qwen3.6-plus-free"], registry))
			.rejects.toThrow(/qwen3\.6-plus-free.*unavailable in the model registry/);
	});

	test("keeps keyless models usable", async () => {
		const registry = {
			getAll: () => [parentModel, unauthedTaskModel],
			getAvailable: () => [unauthedTaskModel],
			getApiKey: async (model: Model<Api>) =>
				model.provider === "opencode-zen" ? kNoAuth : "sk-test",
			isSelectorSuppressed: () => false,
		};

		const result = await resolveAgentModelChain(
			["qwen3.6-plus-free"], registry,
		);

		expect(result.model.provider).toBe("opencode-zen");
	});

	test("uses the third model when the first two selectors are quota-suppressed", async () => {
		const third = buildModel({
			id: "third-choice", name: "Third", api: "openai-completions",
			provider: "third-provider", baseUrl: "https://third.example",
			reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 8192,
		});
		const registry = {
			getAll: () => [parentModel, unauthedTaskModel, third],
			getAvailable: () => [parentModel, unauthedTaskModel, third],
			getApiKey: async (model: Model<Api>) =>
				model.provider === "third-provider" ? "sk-third" : "sk-test",
			isSelectorSuppressed: (selector: string) =>
				selector === "deepseek/deepseek-v4-pro" || selector === "opencode-zen/qwen3.6-plus-free",
		};

		const result = await resolveAgentModelChain(
			["deepseek/deepseek-v4-pro", "qwen3.6-plus-free", "third-provider/third-choice"],
			registry,
		);

		expect(result.model.provider).toBe("third-provider");
	});
});

describe("session-sticky OAuth resolution", () => {
	test("forwards sessionId when checking the configured member", async () => {
		let receivedSessionId: string | undefined;
		const registry = {
			getAll: () => [parentModel, unauthedTaskModel],
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (model.provider === "opencode-zen") receivedSessionId = sessionId;
				return sessionId ? "sk-resolved-token" : undefined;
			},
			isSelectorSuppressed: () => false,
		};

		const result = await resolveAgentModelChain(
			["qwen3.6-plus-free"], registry, undefined, "agent-session",
		);

		expect(receivedSessionId).toBe("agent-session");
		expect(result.model.provider).toBe("opencode-zen");
	});
});

