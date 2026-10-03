import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import type { ModelSpec } from "@veyyon/catalog/types";

function baseSpec<TApi extends "openai-completions">(
	overrides: Partial<ModelSpec<TApi>> = {},
): ModelSpec<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as TApi,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
		...overrides,
	};
}

describe("buildModel kind and webSearch inheritance", () => {
	it("inherits webSearch from provider capability when not explicitly specified", () => {
		const cases = [
			["google", "gemini"],
			["google-antigravity", "gemini"],
			["anthropic", "anthropic"],
			["openai-codex", "codex"],
			["xai", "xai"],
			["xai-oauth", "xai"],
			["openrouter", "openrouter"],
		] as const;

		for (const [provider, expected] of cases) {
			const model = buildModel(baseSpec({ provider }));
			expect(model.webSearch).toBe(expected);
		}
	});

	it("leaves webSearch undefined for providers without native grounding", () => {
		const model = buildModel(baseSpec({ provider: "openai" }));
		expect(model.webSearch).toBeUndefined();
	});

	it("inherits kind for specialist providers (typesafe -> judge, web -> search)", () => {
		const typesafeModel = buildModel(baseSpec({ provider: "typesafe" }));
		expect(typesafeModel.kind).toBe("judge");

		const webModel = buildModel(baseSpec({ provider: "web" }));
		expect(webModel.kind).toBe("search");
	});

	it("leaves kind undefined for chat models (absent kind means chat)", () => {
		const chatModel = buildModel(baseSpec({ kind: "chat" }));
		expect(chatModel.kind).toBeUndefined();
	});

	it("preserves explicit specialist kind on model spec", () => {
		const imageModel = buildModel(baseSpec({ kind: "image" }));
		expect(imageModel.kind).toBe("image");
	});
});

describe("model-manager specialist runner preservation", () => {
	it("preserves authored specialist runners when authoritative dynamic discovery returns empty list", async () => {
		const chatModel = buildModel(
			baseSpec({ id: "chat-1", name: "Chat Model" }),
		);
		const runnerModel = buildModel(
			baseSpec({ id: "image-runner", name: "Image Runner", kind: "image" }),
		);

		const result = await resolveProviderModels({
			providerId: "test-provider",
			staticModels: [chatModel, runnerModel],
			strategy: "online",
			dynamicModelsAuthoritative: true,
			fetchDynamicModels: async () => [],
		});

		// Authoritative empty dynamic fetch drops chat models but keeps specialist runners
		expect(result.models.some((m) => m.id === "chat-1")).toBe(false);
		expect(result.models.some((m) => m.id === "image-runner")).toBe(true);
		expect(result.models.find((m) => m.id === "image-runner")?.kind).toBe(
			"image",
		);
	});

	it("preserves authored specialist runner when dynamic discovery model collides without explicit kind", async () => {
		const runnerModel = buildModel(
			baseSpec({
				id: "shared-id",
				name: "Authored Image Runner",
				kind: "image",
			}),
		);

		const result = await resolveProviderModels({
			providerId: "test-provider",
			staticModels: [runnerModel],
			strategy: "online",
			fetchDynamicModels: async () => [
				baseSpec({ id: "shared-id", name: "Dynamic Chat Collision" }),
			],
		});

		const matched = result.models.find((m) => m.id === "shared-id");
		expect(matched).toBeDefined();
		expect(matched?.kind).toBe("image");
		expect(matched?.name).toBe("Authored Image Runner");
	});

	it("allows dynamic discovery model to replace authored runner when explicit kind was present on spec", async () => {
		const runnerModel = buildModel(
			baseSpec({ id: "shared-id", name: "Old Runner", kind: "image" }),
		);

		const result = await resolveProviderModels({
			providerId: "test-provider",
			staticModels: [runnerModel],
			strategy: "online",
			fetchDynamicModels: async () => [
				baseSpec({ id: "shared-id", name: "Updated Runner", kind: "image" }),
			],
		});

		const matched = result.models.find((m) => m.id === "shared-id");
		expect(matched).toBeDefined();
		expect(matched?.kind).toBe("image");
		expect(matched?.name).toBe("Updated Runner");
	});

	it("retains both chat and specialist models when resolved offline without dynamic fetch", async () => {
		const chatModel = buildModel(
			baseSpec({ id: "chat-1", name: "Chat Model" }),
		);
		const runnerModel = buildModel(
			baseSpec({ id: "image-runner", name: "Image Runner", kind: "image" }),
		);

		const result = await resolveProviderModels({
			providerId: "test-provider",
			staticModels: [chatModel, runnerModel],
			strategy: "offline",
		});

		expect(result.models.some((m) => m.id === "chat-1")).toBe(true);
		expect(result.models.some((m) => m.id === "image-runner")).toBe(true);
	});
});
