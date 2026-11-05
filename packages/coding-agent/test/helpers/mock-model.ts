import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";

/** A text-only OpenAI Responses model with an unreachable base URL: 8192-token window, 2048 output tokens, zero cost. */
export function createMockModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}
