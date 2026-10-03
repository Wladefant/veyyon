import { describe, expect, test } from "bun:test";
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";
import { Effort } from "@veyyon/catalog/effort";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import { loginMeta } from "../src/registry/meta";
import type { Context, Model } from "../src/types";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const testMetaModel: Model<"openai-responses"> = {
	id: "muse-spark-1.1",
	name: "Muse Spark 1.1",
	api: "openai-responses",
	provider: "meta",
	baseUrl: "https://api.meta.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 131_072,
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
	compat: buildOpenAIResponsesCompat({
		id: "muse-spark-1.1",
		name: "Muse Spark 1.1",
		provider: "meta",
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			includeEncryptedReasoning: true,
		},
	}),
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(reasoning: Effort): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(testMetaModel, context, {
		apiKey: "meta-test-key",
		reasoning,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("Meta Model API Responses requests", () => {
	test("sends native xhigh reasoning and requests encrypted replay state", async () => {
		const payload = await capturePayload(Effort.XHigh);
		expect(payload.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
	});

	test("preserves native minimal reasoning without clamping it", async () => {
		const payload = await capturePayload(Effort.Minimal);
		expect(payload.reasoning).toEqual({ effort: "minimal", summary: "auto" });
	});
});

describe("Meta Model API login", () => {
	test("validates pasted keys against the models endpoint without running inference", async () => {
		let requestedUrl = "";
		let authorization = "";
		const apiKey = await loginMeta({
			onAuth: () => {},
			onPrompt: async () => " meta-test-key ",
			fetch: (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.1" }] }));
			},
		});

		expect(apiKey).toBe("meta-test-key");
		expect(requestedUrl).toBe("https://api.meta.ai/v1/models");
		expect(authorization).toBe("Bearer meta-test-key");
	});
});
