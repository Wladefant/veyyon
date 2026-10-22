// WHY: Together's /login validated a pasted key by chat-completing against `moonshotai/Kimi-K2.5`, a
// model Together serves only behind a dedicated endpoint. Together answers that with HTTP 400
// `model_not_available`, so no valid key could pass (oh-my-pi 62ccb64dbe3fa9d1cd99774e81ba0c976b27b223).
// Closes the class "a key check depends on one model's availability" for Together: the only request the
// login sends is the model-agnostic `/v1/models` listing. Gap: it does not check any other provider.
import { describe, expect, test, vi } from "bun:test";
import { loginTogether } from "../src/registry/together";
import type { FetchImpl } from "../src/types";

const NON_SERVERLESS_400 = {
	error: {
		message: "Unable to access non-serverless model moonshotai/Kimi-K2.5.",
		type: "invalid_request_error",
		code: "model_not_available",
	},
};

describe("Together login key validation", () => {
	test("accepts a valid key by probing only the authenticated models listing", async () => {
		const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("Authorization") });
			// Together's real behaviour for a valid key: a dedicated-only model 400s, the listing succeeds.
			if (url.endsWith("/chat/completions")) return Response.json(NON_SERVERLESS_400, { status: 400 });
			if (url.endsWith("/models")) return Response.json({ object: "list", data: [] });
			return Response.json({ error: "unexpected" }, { status: 500 });
		});

		const apiKey = await loginTogether({ onPrompt: async () => "  together-valid-key  ", fetch: fetchMock });

		expect(apiKey).toBe("together-valid-key");
		expect(requests).toEqual([
			{ url: "https://api.together.xyz/v1/models", method: "GET", authorization: "Bearer together-valid-key" },
		]);
	});

	test("still rejects a key the listing refuses", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({ error: { message: "Invalid API key provided" } }, { status: 401 }),
		);

		await expect(loginTogether({ onPrompt: async () => "bad-key", fetch: fetchMock })).rejects.toThrow(
			"together API key validation failed (401)",
		);
	});
});
