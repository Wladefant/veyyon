import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";
import { sseResponse } from "./helpers/fetch-mock";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

function chunk(extra: Record<string, unknown>): Record<string, unknown> {
	return { id: "gen-1", object: "chat.completion.chunk", created: 0, model: model.id, ...extra };
}

describe("openai-completions upstream provider capture", () => {
	// Contract: aggregators (OpenRouter, …) report the upstream provider that served
	// the request via a top-level `provider` field on every chunk. We surface it on
	// the assistant message so telemetry/session logs can attribute routing.
	it("records the aggregator-reported upstream provider from the stream", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				sseResponse([
					chunk({ provider: "Anthropic", choices: [{ index: 0, delta: { content: "Hi" } }] }),
					chunk({
						provider: "Anthropic",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					"[DONE]",
				]),
			);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.upstreamProvider).toBe("Anthropic");
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	});

	it("leaves upstreamProvider undefined when no provider field is present", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				sseResponse([
					chunk({ choices: [{ index: 0, delta: { content: "Hi" } }] }),
					chunk({
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					"[DONE]",
				]),
			);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.upstreamProvider).toBeUndefined();
	});
});
