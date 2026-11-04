import { afterEach, describe, expect, it, vi } from "bun:test";
import { AUTHENTICATED_API_KEY_SENTINEL } from "@veyyon/ai/provider-env-keys";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const mantle = buildModel({
	id: "openai.gpt-5.4",
	name: "GPT-5.4 (Bedrock Mantle)",
	api: "openai-responses",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 16000,
} satisfies ModelSpec<"openai-responses">) as Model<"openai-responses">;

const ctx: Context = { systemPrompt: ["hi"], messages: [{ role: "user", content: "ping", timestamp: Date.now() }] };

/** Runs one turn and returns the Authorization header the endpoint saw (undefined when no request was made). */
async function authorizationSeen(apiKey: string | undefined): Promise<string | undefined> {
	let seen: string | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		seen = new Headers(init?.headers).get("authorization") ?? undefined;
		const done = {
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
		};
		return new Response(`data: ${JSON.stringify(done)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	for await (const event of streamSimple(mantle, ctx, { apiKey, fetch: fetchMock })) {
		if (event.type === "done" || event.type === "error") break;
	}
	return seen;
}

const originalToken = Bun.env.AWS_BEARER_TOKEN_BEDROCK;

afterEach(() => {
	if (originalToken === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
	else Bun.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
	vi.restoreAllMocks();
});

describe("Bedrock Mantle Responses authentication", () => {
	it("sends the Bedrock API key where the agent loop passed the ambient-credentials sentinel", async () => {
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key";
		expect(await authorizationSeen(AUTHENTICATED_API_KEY_SENTINEL)).toBe("Bearer bedrock-api-key");
	});

	it("keeps an explicit key over the environment", async () => {
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key";
		expect(await authorizationSeen("explicit-key")).toBe("Bearer explicit-key");
	});

	it("refuses the turn with only the sentinel and no Bedrock API key, rather than sending the sentinel", async () => {
		delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		await expect(authorizationSeen(AUTHENTICATED_API_KEY_SENTINEL)).rejects.toThrow(
			"No API key for provider: amazon-bedrock",
		);
	});
});
