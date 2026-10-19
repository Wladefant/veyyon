/**
 * WHY: Kimi Code and Synthetic serve one catalog over an OpenAI and an Anthropic surface, and the
 * shim rebuilds each model as `anthropic-messages` for the Anthropic one. The rebuild dropped the
 * declared effort ladder, so the copy fell back to the five budget tiers and every declared tier
 * outside them failed before any request: `kimi-code/k3` at `max` reported "Supported efforts:
 * minimal, low, medium, high, xhigh", a list the model never declared.
 *
 * Class closed: for every bundled `openai-completions` reasoning model, every tier its catalog row
 * declares reaches the Anthropic wire with that tier's budget, and a reasoning model that declares
 * no tier gets no fabricated one. The sweep reads the bundled catalog at run time, so a new
 * provider or model on this API is covered by default.
 *
 * Not caught: a model whose catalog row itself declares the wrong ladder. This suite holds the
 * shim to the catalog, not the catalog to the endpoint.
 */
import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import type { MessageCreateParamsStreaming } from "../src/providers/anthropic-wire";
import { streamOpenAIAnthropicShim } from "../src/providers/openai-anthropic-shim";
import { ANTHROPIC_THINKING_BUDGETS } from "../src/reasoning-budget";
import type { Context, Model } from "../src/types";

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const STOP = "stop after payload capture";

async function anthropicPayload(
	model: Model<"openai-completions">,
	reasoning: Effort | undefined,
): Promise<{ payload: MessageCreateParamsStreaming | undefined; error: string | undefined }> {
	let payload: MessageCreateParamsStreaming | undefined;
	const stream = streamOpenAIAnthropicShim(
		model,
		CONTEXT,
		{
			apiKey: "test-key",
			maxTokens: 64_000,
			reasoning,
			onPayload: body => {
				payload = body as MessageCreateParamsStreaming;
				throw new Error(STOP);
			},
		},
		{ anthropicBaseUrl: "https://anthropic.example.test", defaultFormat: "anthropic" },
	);
	const result = await stream.result();
	const error = result.errorMessage?.includes(STOP) ? undefined : result.errorMessage;
	return { payload, error };
}

const reasoningModels = getBundledProviders()
	.flatMap(provider => getBundledModels(provider))
	.filter((model): model is Model<"openai-completions"> => model.api === "openai-completions" && model.reasoning);

describe("the Anthropic shim keeps the effort ladder the catalog declares", () => {
	it("finds both shim providers' models in the sweep", () => {
		const providers = new Set(reasoningModels.map(model => model.provider));
		expect(providers.has("kimi-code")).toBe(true);
		expect(providers.has("synthetic")).toBe(true);
	});
	it("accepts every declared tier and turns thinking on for it", async () => {
		const failures: string[] = [];
		for (const model of reasoningModels) {
			for (const effort of getSupportedEfforts(model)) {
				const { payload, error } = await anthropicPayload(model, effort);
				const type = payload?.thinking?.type;
				if (error !== undefined || (type !== "enabled" && type !== "adaptive")) {
					failures.push(`${model.provider}/${model.id}@${effort}: ${error ?? `thinking ${type}`}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("sends kimi-code/k3 at max, the tier the budget fallback lacks", async () => {
		const k3 = reasoningModels.find(model => model.provider === "kimi-code" && model.id === "k3");
		expect(k3 && getSupportedEfforts(k3)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		const { payload, error } = await anthropicPayload(k3 as Model<"openai-completions">, Effort.Max);
		expect(error).toBeUndefined();
		expect(payload?.thinking).toMatchObject({ type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGETS.max });
	});

	it("fabricates no tier for a reasoning model that declares none, and does not switch its thinking off", async () => {
		const undeclared = reasoningModels.filter(model => getSupportedEfforts(model).length === 0);
		expect(undeclared.length).toBeGreaterThan(0);
		const failures: string[] = [];
		for (const model of undeclared) {
			const { payload, error } = await anthropicPayload(model, Effort.Medium);
			const thinking = payload?.thinking;
			const fabricated =
				thinking?.type === "enabled" && thinking.budget_tokens === ANTHROPIC_THINKING_BUDGETS.medium;
			if (error !== undefined || thinking?.type === "disabled" || fabricated) {
				failures.push(`${model.provider}/${model.id}: ${error ?? JSON.stringify(thinking)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("still switches thinking off when the request asks for it", async () => {
		const failures: string[] = [];
		for (const model of reasoningModels.filter(model => getSupportedEfforts(model).length === 0)) {
			let payload: MessageCreateParamsStreaming | undefined;
			const stream = streamOpenAIAnthropicShim(
				model,
				CONTEXT,
				{
					apiKey: "test-key",
					disableReasoning: true,
					onPayload: body => {
						payload = body as MessageCreateParamsStreaming;
						throw new Error(STOP);
					},
				},
				{ anthropicBaseUrl: "https://anthropic.example.test", defaultFormat: "anthropic" },
			);
			await stream.result();
			// An endpoint that rejects disabled thinking gets the 1024-token floor instead.
			const thinking = payload?.thinking;
			const off = thinking?.type === "disabled" || (thinking?.type === "enabled" && thinking.budget_tokens === 1024);
			if (!off) {
				failures.push(`${model.provider}/${model.id}: ${JSON.stringify(payload?.thinking)}`);
			}
		}
		expect(failures).toEqual([]);
	});
});
