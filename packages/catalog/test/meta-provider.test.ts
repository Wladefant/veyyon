import { describe, expect, test } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { CATALOG_PROVIDERS, DEFAULT_MODEL_PER_PROVIDER } from "@veyyon/catalog/provider-models/descriptors";
import {
	META_MUSE_STATIC_MODELS,
	MUSE_CODE_STATIC_MODELS,
	metaModelManagerOptions,
	museCodeModelManagerOptions,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl, ThinkingConfig } from "@veyyon/catalog/types";

const MUSE_SPARK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
}

describe("Meta Model API provider", () => {
	test("ships Muse Spark static models with documented Responses capabilities", () => {
		expect(META_MUSE_STATIC_MODELS.map(model => model.id)).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
		]);

		const options = metaModelManagerOptions();
		expect(options.providerId).toBe("meta");
		expect(options.staticModels).toEqual(META_MUSE_STATIC_MODELS);
	});

	test("prefers Meta's documented key name while accepting the provider-specific alias", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "meta");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.1",
			envVars: ["MODEL_API_KEY", "META_API_KEY"],
			catalogDiscovery: { label: "Meta Model API" },
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.meta).toBe("muse-spark-1.1");
	});

	test("live discovery keeps seeded capabilities for ids Meta lists without metadata", async () => {
		const options = metaModelManagerOptions({
			apiKey: "meta-key",
			fetch: async () => modelListResponse(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-image-1.0"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get("muse-spark-1.3")).toMatchObject({
			name: "Muse Spark 1.3",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: MUSE_SPARK_THINKING,
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		});
		// Image/voice SKUs on the same roster are not chat models.
		expect(byId.has("muse-image-1.0")).toBe(false);
	});
});

describe("Muse Code subscription provider", () => {
	test("exposes a distinct provider with subscription-scoped Muse models", async () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "muse-code");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.3",
			dynamicModelsAuthoritative: true,
		});
		expect(DEFAULT_MODEL_PER_PROVIDER["muse-code"]).toBe("muse-spark-1.3");
		expect(descriptor).not.toHaveProperty("envVars");

		let requestHeaders = new Headers();
		const fetchModels: FetchImpl = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return modelListResponse(["muse-spark-1.3", "muse-image-1.0", "muse-voice-1.0"]);
		};
		const options = museCodeModelManagerOptions({
			apiKey: "LLM|subscription-key",
			fetch: fetchModels,
		});
		expect(options.providerId).toBe("muse-code");
		expect(options.staticModels).toEqual(MUSE_CODE_STATIC_MODELS);
		expect(MUSE_CODE_STATIC_MODELS.every(model => model.provider === "muse-code")).toBe(true);
		const discovered = await options.fetchDynamicModels?.();
		expect(requestHeaders.get("Authorization")).toBe("Bearer LLM|subscription-key");
		expect(requestHeaders.get("x-api-version")).toBe("1.0.0");
		expect(discovered).toEqual([
			expect.objectContaining({
				id: "muse-spark-1.3",
				provider: "muse-code",
				reasoning: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				maxTokens: 131_072,
			}),
		]);
	});

	test("exposes thinking on bundled rows", () => {
		for (const provider of ["muse-code", "meta"] as const) {
			for (const id of [
				"muse-spark-1.1",
				"muse-spark-1.2",
				"muse-spark-1.2-contributor",
				"muse-spark-1.3",
				"muse-spark-1.3-contributor",
			]) {
				expect(getBundledModel(provider, id)?.thinking?.efforts).toEqual([
					Effort.Minimal,
					Effort.Low,
					Effort.Medium,
					Effort.High,
					Effort.XHigh,
				]);
			}
		}
	});
});
