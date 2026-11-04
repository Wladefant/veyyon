import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@veyyon/ai/providers/google";
import type { GoogleGeminiCliOptions } from "@veyyon/ai/providers/google-gemini-cli";
import { mapOptionsForApi } from "@veyyon/ai/stream";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function googleModel(id: string): Model<"google-generative-ai"> {
	return buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		// Declared surface mirroring the bundled google/gemini-3-flash-preview row
		// (models.dev): bare specs derive no ladder, so the fixture declares the
		// same one to exercise the google-level floor.
		reasoningOptions: { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

function stopResponse(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureGoogleThinkingConfig(
	model: Model<"google-generative-ai">,
): Promise<Record<string, unknown> | undefined> {
	let body: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		body = JSON.parse(String(init?.body ?? "{}"));
		return stopResponse();
	};
	const options = mapOptionsForApi(model, {
		apiKey: "test",
		fetch,
		reasoning: Effort.High,
		disableReasoning: true,
	});
	for await (const _ of streamGoogle(model, context, options) as AsyncIterable<AssistantMessageEvent>) {
		// Consume the real provider stream so the request is serialized.
	}
	if (!body) throw new Error("Google request was not captured");
	return (body.generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
}

describe("canonical reasoning selection reaches provider wire requests", () => {
	/** Regression: explicit disable must beat a simultaneous high-effort selection on budget-based Gemini models. */
	it("serializes zero budget and hides summaries when Gemini budget thinking is disabled", async () => {
		expect(await captureGoogleThinkingConfig(googleModel("gemini-2.5-flash"))).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	/** Gemini 3 cannot fully disable thinking, so the canonical off intent must select its documented minimum wire level. */
	it("serializes the minimum level when Gemini requires thinking", async () => {
		expect(await captureGoogleThinkingConfig(googleModel("gemini-3-flash"))).toEqual({
			includeThoughts: true,
			thinkingLevel: "MINIMAL",
		});
	});

	/**
	 * A `google-level` model that can be switched off at the request level (no `requiresEffort`) still
	 * receives a level, and it must be one the model declares: `MINIMAL` on a ladder that starts at
	 * `low` is a level the endpoint rejects. Swept over every ladder shape, on the direct API and on
	 * the Cloud Code Assist suppress path.
	 */
	it.each([
		[[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], "MINIMAL"],
		[[Effort.Low, Effort.High], "LOW"],
		[[Effort.Low, Effort.Medium, Effort.High], "LOW"],
		[[Effort.High, Effort.Low], "LOW"],
	] as const)("sends the lowest declared level when thinking is off on %j", async (efforts, level) => {
		const base = googleModel("gemini-3-pro");
		if (!base.thinking) throw new Error("fixture declares no thinking surface");
		const direct: Model<"google-generative-ai"> = {
			...base,
			thinking: { ...base.thinking, mode: "google-level", requiresEffort: false, efforts: [...efforts] },
		};
		expect(await captureGoogleThinkingConfig(direct)).toEqual({ includeThoughts: false, thinkingLevel: level });

		const cca = {
			...direct,
			api: "google-gemini-cli",
			provider: "google-antigravity",
			thinking: { ...direct.thinking, suppressWhenOff: true },
		} as Model<"google-gemini-cli">;
		const options: GoogleGeminiCliOptions = mapOptionsForApi(cca, { apiKey: "test", disableReasoning: true });
		expect(options.thinking).toEqual({ enabled: false, suppress: { level } });
	});

	/** Regression: Bedrock option mapping and direct serialization must use the same extra-high token budget. */
	it("reserves the centralized Bedrock extra-high thinking budget before output", () => {
		const model: Model<"bedrock-converse-stream"> = buildModel({
			id: "claude-sonnet-budget",
			name: "Claude Sonnet Budget",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "",
			reasoning: true,
			thinking: {
				mode: "budget",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});

		const options = mapOptionsForApi(model, { reasoning: Effort.XHigh, maxTokens: 20_000 });

		expect(options.maxTokens).toBe(33_792);
	});
});
