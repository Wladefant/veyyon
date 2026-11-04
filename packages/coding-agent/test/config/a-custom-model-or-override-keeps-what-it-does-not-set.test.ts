/**
 * A models.yml patch changes the fields it names and nothing else. `config/model-patch.ts` applies
 * every patch: a `modelOverrides` entry over a built model, a custom model definition finalized
 * against the bundled reference for its id, and provider-level compat over discovered models.
 *
 * The class: a patch that resets a field it did not name (a partial price zeroing the rest, a
 * provider compat record replacing the model's own), a custom model that ignores the bundled
 * reference for a field it left unset, standalone defaults that drift, and a retired variant id
 * that re-binds its override while a live model still holds that id.
 *
 * What it does not catch: how the registry orders these layers, which `model-registry.test.ts`
 * drives through models.yml. The bundled reference and the variant alias table are spied, so a
 * change to bundled catalog rows cannot turn this suite red or green.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import * as identity from "@veyyon/catalog/identity";
import * as variantCollapse from "@veyyon/catalog/variant-collapse";
import {
	applyModelOverride,
	applyProviderCompat,
	type CustomModelOverlay,
	finalizeCustomModel,
	resolveModelOverrideWithAliases,
} from "@veyyon/coding-agent/config/model-patch";
import type { ModelOverride } from "@veyyon/coding-agent/config/models-config-schema";

function model(spec: Partial<ModelSpec<Api>> = {}): Model<Api> {
	return buildModel({
		id: "base-model",
		name: "Base Model",
		api: "openai-completions",
		provider: "demo",
		baseUrl: "https://demo.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 },
		contextWindow: 64_000,
		maxTokens: 4_096,
		...spec,
	} as ModelSpec<Api>);
}

const overlay: CustomModelOverlay = {
	id: "custom-model",
	provider: "demo",
	api: "openai-completions",
	baseUrl: "https://demo.invalid/v1",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a custom model", () => {
	it("takes the standalone defaults when no bundled model shares its id", () => {
		vi.spyOn(identity, "resolveBundledModelReference").mockReturnValue(undefined);

		const built = finalizeCustomModel(overlay, { useDefaults: true });

		expect(built.name).toBe("custom-model");
		expect(built.contextWindow).toBe(128_000);
		expect(built.maxTokens).toBe(16_384);
		expect(built.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(built.input).toEqual(["text"]);
		expect(built.reasoning).toBe(false);
	});

	it("fills what it leaves unset from the bundled model that shares its id", () => {
		const reference = model({
			id: "custom-model",
			cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			supportsTools: false,
			compat: { supportsDeveloperRole: false },
		});
		vi.spyOn(identity, "resolveBundledModelReference").mockReturnValue(reference);

		const built = finalizeCustomModel(
			{ ...overlay, compat: { reasoningContentField: "reasoning_content" } },
			{ useDefaults: true },
		);

		expect(built.cost).toEqual({ input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0 });
		expect(built.contextWindow).toBe(200_000);
		expect(built.maxTokens).toBe(32_000);
		expect(built.supportsTools).toBe(false);
		expect(built.compatConfig).toEqual({ supportsDeveloperRole: false, reasoningContentField: "reasoning_content" });
	});

	it("keeps its own value over the bundled model's for a field it sets", () => {
		vi.spyOn(identity, "resolveBundledModelReference").mockReturnValue(
			model({ id: "custom-model", supportsTools: false, compat: { supportsDeveloperRole: false } }),
		);

		const built = finalizeCustomModel(
			{ ...overlay, supportsTools: true, compat: { supportsDeveloperRole: true } },
			{ useDefaults: true },
		);

		expect(built.supportsTools).toBe(true);
		expect(built.compatConfig).toEqual({ supportsDeveloperRole: true });
	});
});

describe("a model override", () => {
	it("that sets one price keeps the other prices", () => {
		const base = model();

		const patched = applyModelOverride(base, { cost: { output: 9 } } as ModelOverride);

		expect(patched.cost).toEqual({ input: 1, output: 9, cacheRead: 0.5, cacheWrite: 3 });
	});

	it("keyed by a retired variant id binds to the collapsed model only while no live model holds that id", () => {
		vi.spyOn(variantCollapse, "getVariantAliasSources").mockReturnValue(["base-model-high"]);
		const override = { contextWindow: 111_111 } as ModelOverride;
		const overrides = new Map<string, ModelOverride>([["base-model-high", override]]);

		expect(resolveModelOverrideWithAliases(overrides, model(), () => false)).toBe(override);
		expect(
			resolveModelOverrideWithAliases(overrides, model(), (_provider, id) => id === "base-model-high"),
		).toBeUndefined();
	});
});

describe("provider compat", () => {
	it("merges into each model's own compat instead of replacing it", () => {
		const [patched] = applyProviderCompat({ supportsUsageInStreaming: false }, [
			model({ compat: { maxTokensField: "max_tokens" } }),
		]);

		expect(patched.compatConfig).toEqual({ maxTokensField: "max_tokens", supportsUsageInStreaming: false });
	});
});
