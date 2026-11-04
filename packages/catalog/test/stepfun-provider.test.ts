import { afterEach, describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { getProviderDefinition } from "@veyyon/ai/registry/registry";
import { getBundledModels } from "@veyyon/catalog/models";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import { isStepfunChatModelId, stepfunModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl, ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { Effort } from "@veyyon/model";

/** StepFun's documented three-tier ladder; the relay-host default spans minimal…xhigh. */
const STEPFUN_LADDER = [Effort.Low, Effort.Medium, Effort.High];

const ORIGINAL_STEPFUN_API_KEY = process.env.STEPFUN_API_KEY;

afterEach(() => {
	if (ORIGINAL_STEPFUN_API_KEY === undefined) {
		delete process.env.STEPFUN_API_KEY;
	} else {
		process.env.STEPFUN_API_KEY = ORIGINAL_STEPFUN_API_KEY;
	}
	vi.restoreAllMocks();
});

function bundledStepfunModels() {
	return getBundledModels("stepfun");
}

describe("StepFun provider support", () => {
	test("registers the provider, its STEPFUN_API_KEY fallback, and a login flow", () => {
		process.env.STEPFUN_API_KEY = "stepfun-test-key";
		expect(getEnvApiKey("stepfun")).toBe("stepfun-test-key");
		delete process.env.STEPFUN_API_KEY;
		expect(getEnvApiKey("stepfun")).toBeUndefined();

		const descriptor = CATALOG_PROVIDERS.find(item => item.id === "stepfun");
		expect(descriptor?.defaultModel).toBe("step-5-preview");
		expect(descriptor?.envVars).toEqual(["STEPFUN_API_KEY"]);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);

		const provider = getProviderDefinition("stepfun");
		expect(provider?.name).toBe("StepFun");
	});

	test("keeps StepFun's own effort ladder instead of the relay-host minimal…xhigh default", () => {
		for (const model of bundledStepfunModels()) {
			expect(model.thinking?.mode).toBe("effort");
			expect(model.thinking?.efforts).toEqual(STEPFUN_LADDER);
			expect(model.reasoning).toBe(true);
		}
	});

	test("pins StepFun's published limits and pricing rather than relay-host rows", () => {
		const byId = new Map(bundledStepfunModels().map(model => [model.id, model]));

		expect(byId.get("step-5-preview")?.contextWindow).toBe(1_000_000);
		expect(byId.get("step-5-preview")?.maxTokens).toBe(1_000_000);
		for (const id of ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"]) {
			expect(byId.get(id)?.contextWindow).toBe(256_000);
			expect(byId.get(id)?.maxTokens).toBe(256_000);
		}

		expect(byId.get("step-5-preview")?.cost).toEqual({ input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 0 });
		expect(byId.get("step-3.7-flash")?.cost).toEqual({ input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 });
		expect(byId.get("step-3.5-flash")?.cost).toEqual({ input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 });

		expect(byId.get("step-5-preview")?.input).toEqual(["text", "image"]);
		expect(byId.get("step-3.7-flash")?.input).toEqual(["text", "image"]);
		expect(byId.get("step-3.5-flash")?.input).toEqual(["text"]);

		for (const model of bundledStepfunModels()) {
			const compat = model.compat as ResolvedOpenAICompat;
			expect(compat?.maxTokensField).toBe("max_tokens");
			expect(compat?.supportsReasoningEffort).toBe(true);
		}
	});

	test("discovery keeps chat models and drops the audio/image SKUs StepFun interleaves in /v1/models", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "step-5-preview", owned_by: "stepai", max_input_tokens: 1024000 },
							{ id: "stepaudio-3-tts", owned_by: "stepai" },
							{ id: "stepaudio-2.5-asr", owned_by: "stepai" },
							{ id: "step-image-edit-2", owned_by: "stepai" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const models = await stepfunModelManagerOptions({
			apiKey: "stepfun-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["step-5-preview"]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.stepfun.ai/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer stepfun-key" }),
			}),
		);

		const discovered = models?.[0];
		expect(discovered?.reasoning).toBe(true);
		expect(discovered?.thinking?.efforts).toEqual(STEPFUN_LADDER);
		expect(discovered?.cost).toEqual({ input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 0 });
		expect(discovered?.contextWindow).toBe(1_000_000);
		expect(discovered?.maxTokens).toBe(1_000_000);
	});

	test("roster exclusion classifies StepFun's non-chat SKUs without touching chat ids", () => {
		expect(isStepfunChatModelId("step-5-preview")).toBe(true);
		expect(isStepfunChatModelId("STEP-5-PREVIEW")).toBe(true);
		expect(isStepfunChatModelId("stepaudio-3-tts")).toBe(false);
		expect(isStepfunChatModelId("stepaudio-2.5-chat")).toBe(false);
		expect(isStepfunChatModelId("step-image-edit-2")).toBe(false);
		expect(isStepfunChatModelId("step-tts-2")).toBe(false);
		expect(isStepfunChatModelId("   ")).toBe(false);
	});
});
