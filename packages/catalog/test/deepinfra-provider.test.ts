import { describe, expect, test } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@veyyon/catalog/provider-models/descriptors";
import { deepinfraModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@veyyon/catalog/types";

const DISCOVERY_URL =
	"https://api.deepinfra.com/v1/openai/models?filter=with_meta&sort_by=omp";

describe("DeepInfra provider catalog", () => {
	test("registers descriptor with keyless authoritative discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(
			(item) => item.providerId === "deepinfra",
		);
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
		expect(descriptor?.catalogDiscovery?.envVars).toContain(
			"DEEPINFRA_API_KEY",
		);
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.deepinfra).toBe(
			"deepseek-ai/DeepSeek-V4-Flash-0731",
		);
	});

	test("maps chat models, capturing pricing, cache reads, vision, and effort", async () => {
		const requests: string[] = [];
		const fetchMock: FetchImpl = async (input) => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{
						id: "vendor/vlm-reasoner",
						metadata: {
							context_length: 262144,
							max_tokens: 131072,
							pricing: {
								input_tokens: 0.68,
								output_tokens: 3.4,
								cache_read_tokens: 0.136,
							},
							tags: ["chat", "vision", "reasoning_effort"],
						},
					},
					{ id: "vendor/tts-only", metadata: { tags: ["tts"] } },
				],
			});
		};
		const options = deepinfraModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(requests).toEqual([DISCOVERY_URL]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const model = models?.[0];
		expect(model?.id).toBe("vendor/vlm-reasoner");
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
		expect(model?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(model?.cost).toEqual({
			input: 0.68,
			output: 3.4,
			cacheRead: 0.136,
			cacheWrite: 0,
		});
		expect(model?.contextWindow).toBe(262144);
		expect(model?.maxTokens).toBe(131072);
	});
	test("returns null on network error (negative control)", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("Network error");
		};
		expect(
			await deepinfraModelManagerOptions({
				fetch: fetchMock,
			}).fetchDynamicModels?.(),
		).toBeNull();
	});
});
