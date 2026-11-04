import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "@veyyon/catalog/provider-models/openai-compat";
import type { ModelSpec } from "@veyyon/catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const XAI_MODELS_DEV_FIXTURE = {
	xai: {
		models: {
			"grok-4.5": {
				name: "Grok 4.5",
				tool_call: true,
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
				modalities: { input: ["text", "image"] },
				limit: { context: 500_000, output: 500_000 },
				cost: { input: 2, output: 6, cache_read: 0.3 },
			},
			"grok-code-fast-1": {
				name: "Grok Code Fast 1",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 256_000, output: 10_000 },
				cost: { input: 0.2, output: 1.5 },
			},
			"grok-build-0.1": {
				name: "Grok Build 0.1",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 256_000, output: 256_000 },
				cost: { input: 0, output: 0 },
			},
			"grok-4.20-0309-reasoning": {
				name: "Grok 4.20 (Reasoning)",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 2_000_000, output: 64_000 },
				cost: { input: 2, output: 6 },
			},
			"grok-2": {
				name: "Grok 2",
				tool_call: true,
				reasoning: false,
				modalities: { input: ["text"] },
				limit: { context: 131_072, output: 8192 },
				cost: { input: 2, output: 10 },
			},
		},
	},
};

describe("paid xAI Responses thinking policy", () => {
	it("bakes the effort-dial allowlist on stencil.so -> openai-responses mapping", () => {
		const mapped = mapModelsDevToModels(XAI_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "xai",
		);
		const byId = Object.fromEntries(mapped.map(model => [model.id, model]));

		expect(byId["grok-4.5"]?.api).toBe("openai-responses");
		expect(byId["grok-4.5"]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			omitReasoningEffort: false,
			reasoningEffortMap: { minimal: "low" },
		});
		expect(byId["grok-build-0.1"]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			omitReasoningEffort: false,
			reasoningEffortMap: { minimal: "low" },
		});
		for (const id of ["grok-code-fast-1", "grok-4.20-0309-reasoning"] as const) {
			expect(byId[id]?.reasoning, id).toBe(true);
			expect(byId[id]?.compat, id).toMatchObject({
				supportsReasoningEffort: false,
				omitReasoningEffort: true,
				reasoningEffortMap: { minimal: "low" },
			});
		}
		expect(byId["grok-2"]?.compat).toMatchObject({
			supportsReasoningEffort: false,
			omitReasoningEffort: true,
		});
	});

	it("strips stale thinking dials from off-allowlist paid xAI reasoners during generation", () => {
		const mapped = mapModelsDevToModels(XAI_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "xai",
		);
		// Snapshot-era Completions rows still carry a default effort ladder after the
		// api flip; the generator must not re-emit that dial for Responses.
		const snapshotStale = mapped.find(model => model.id === "grok-code-fast-1");
		expect(snapshotStale).toBeDefined();
		snapshotStale!.thinking = { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };

		applyGeneratedModelPolicies(mapped);
		const byId = Object.fromEntries(mapped.map(model => [model.id, model]));

		expect(byId["grok-4.5"]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low" },
		});
		for (const id of ["grok-code-fast-1", "grok-4.20-0309-reasoning"] as const) {
			expect(byId[id]?.reasoning, id).toBe(true);
			expect(byId[id]?.thinking, id).toBeUndefined();
			expect(byId[id]?.compat, id).toMatchObject({ supportsReasoningEffort: false });
		}
	});

	it("strips thinking dials from unmapped raw specs during applyGeneratedModelPolicies", () => {
		const rawModel: ModelSpec<"openai-responses"> = {
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium] },
			input: ["text"],
			cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 10_000,
		};
		applyGeneratedModelPolicies([rawModel]);
		expect(rawModel.thinking).toBeUndefined();
		expect(rawModel.compat?.supportsReasoningEffort).toBe(false);
		expect(rawModel.compat?.omitReasoningEffort).toBe(true);
	});
});
