import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@veyyon/ai/registry/oauth";
import { getEnvApiKey } from "@veyyon/ai/stream";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModels } from "@veyyon/catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models/descriptors";
import { abliterationModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl, ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";

const ORIGINAL_ENV = {
	ABLITERATION_API_KEY: Bun.env.ABLITERATION_API_KEY,
	ABLIT_KEY: Bun.env.ABLIT_KEY,
} as const;

afterEach(() => {
	for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
	vi.restoreAllMocks();
});

describe("Abliteration provider support", () => {
	test("resolves Abliteration and ABLIT API key environment fallbacks", () => {
		delete Bun.env.ABLITERATION_API_KEY;
		Bun.env.ABLIT_KEY = "abliteration-alias-key";
		expect(getEnvApiKey("abliteration")).toBe("abliteration-alias-key");

		Bun.env.ABLITERATION_API_KEY = "abliteration-test-key";
		expect(getEnvApiKey("abliteration")).toBe("abliteration-test-key");
	});

	test("registers descriptor, default model, and bundled abliterated models", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "abliteration");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("abliterated-model");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.abliteration).toBe("abliterated-model");

		const bundled = getBundledModels("abliteration");
		expect(bundled.map(model => model.id).sort()).toEqual([
			"abliterated-model",
			"abliterated-model-large",
			"abliterated-model-large-v2",
		]);

		// Documented wire surface: OpenAI responses route, per-model reasoning
		// ladders, documented context/output limits, and USD pricing with 10%
		// cache-read billing.
		const base = bundled.find(model => model.id === "abliterated-model")!;
		expect(base.api).toBe("openai-responses");
		expect(base.input).toEqual(["text", "image"]);
		expect(base.contextWindow).toBe(262_144);
		expect(base.maxTokens).toBe(262_134);
		expect(base.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(base.cost).toEqual({ input: 3, output: 3, cacheRead: 0.3, cacheWrite: 0 });

		const large = bundled.find(model => model.id === "abliterated-model-large")!;
		expect(large.input).toEqual(["text"]);
		expect(large.contextWindow).toBe(1_000_000);
		expect(large.maxTokens).toBe(999_990);
		expect(large.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(large.cost).toEqual({ input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 });

		const largeV2 = bundled.find(model => model.id === "abliterated-model-large-v2")!;
		// Large V2 documents exactly three reasoning modes with max as the
		// default and disable-shaped controls hidden behind low reasoning.
		expect(largeV2.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(largeV2.thinking?.defaultLevel).toBe(Effort.Max);
		expect(largeV2.thinking?.requiresEffort).toBe(true);

		for (const model of bundled) {
			expect((model.compat as ResolvedOpenAIResponsesCompat).includeEncryptedReasoning).toBe(false);
		}

		const provider = getOAuthProviders().find(item => item.id === "abliteration");
		expect(provider?.name).toBe("Abliteration");
	});

	test("discovers models from the Abliteration Models API with normalized base URL", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "abliterated-model" }, { id: "abliterated-model-next" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const options = abliterationModelManagerOptions({
			apiKey: "ak_test",
			baseUrl: "https://gateway.abliteration.test",
			fetch: fetchMock,
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.abliteration.test/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer ak_test" }),
			}),
		);
		expect(models?.map(model => model.id).sort()).toEqual(["abliterated-model", "abliterated-model-next"]);

		// Discovered rows for documented ids keep their curated ladder; unknown
		// discovered ids inherit the generic OpenAI reasoning-effort surface.
		const discoveredNext = models?.find(model => model.id === "abliterated-model-next");
		expect(discoveredNext?.reasoning).toBe(true);
		expect(discoveredNext?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		const discoveredBase = models?.find(model => model.id === "abliterated-model");
		expect(discoveredBase?.thinking?.efforts).toContain(Effort.XHigh);
	});

	test("falls back to bundled seed when discovery fails without a key", () => {
		const options = abliterationModelManagerOptions({ fetch: async () => new Response(null, { status: 503 }) });
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});
});
