// WHY: Other model IDs reject configuration_update. Pin capability boundaries and
// the first-party GPT-6 freeform tool policy without depending on generated catalogs.
import { expect, it } from "bun:test";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";
import { buildOpenAIResponsesCompat, buildOpenRouterCompat } from "../src/compat/openai";
import type { Api, ModelSpec } from "../src/types";

const spec = (id: string): ModelSpec<"openai-responses"> => ({
	id,
	name: id,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
});

it("only enables the declared Astra model and preserves explicit gateway opt-outs", () => {
	for (const id of ["gpt-6-astra", "openai/gpt-6-astra", "gpt-6", "gpt-6-astra-mini", "gpt-5.6-sol", "gpt-7-astra"]) {
		expect(buildOpenAIResponsesCompat(spec(id)).supportsConfigurationUpdate).toBe(id.endsWith("gpt-6-astra"));
	}
	expect(
		buildOpenAIResponsesCompat({ ...spec("gpt-6-astra"), compat: { supportsConfigurationUpdate: false } })
			.supportsConfigurationUpdate,
	).toBe(false);
	expect(
		buildOpenRouterCompat({ ...spec("openai/gpt-6-astra"), provider: "openrouter", api: "openrouter" })
			.supportsConfigurationUpdate,
	).toBe(true);
});

it("generates freeform apply_patch for first-party GPT-5 and GPT-6 only", () => {
	const models: ModelSpec<Api>[] = [
		spec("gpt-4"),
		spec("gpt-5"),
		spec("gpt-6-astra"),
		spec("gpt-7"),
		{ ...spec("gpt-6-astra"), provider: "proxy" },
	];
	applyGeneratedModelPolicies(models);
	expect(models.map(model => model.applyPatchToolType)).toEqual([
		undefined,
		"freeform",
		"freeform",
		undefined,
		undefined,
	]);
});
