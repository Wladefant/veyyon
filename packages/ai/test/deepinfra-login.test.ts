import { describe, expect, test, vi } from "bun:test";
import { loginDeepinfra } from "../src/registry/deepinfra";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

describe("DeepInfra login", () => {
	test("registers DeepInfra as an available API-key provider", () => {
		const provider = getOAuthProviders().find(
			(item) => item.id === "deepinfra",
		);
		expect(provider).toMatchObject({
			id: "deepinfra",
			name: "DeepInfra",
			available: true,
		});
	});

	test("validates pasted key against chat completions endpoint", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				requests.push({
					url: String(input),
					authorization: headers.get("authorization"),
				});
				return Response.json({
					choices: [{ message: { role: "assistant", content: "" } }],
				});
			},
		);

		const apiKey = await loginDeepinfra({
			onPrompt: async () => "  di-test-key  ",
			fetch: fetchMock,
		});
		expect(apiKey).toBe("di-test-key");
		expect(requests).toEqual([
			{
				url: "https://api.deepinfra.com/v1/openai/chat/completions",
				authorization: "Bearer di-test-key",
			},
		]);
	});

	test("rejects invalid key (negative control)", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({ detail: "Invalid" }, { status: 401 }),
		);
		await expect(
			loginDeepinfra({ onPrompt: async () => "bad-key", fetch: fetchMock }),
		).rejects.toThrow("DeepInfra API key validation failed (401)");
	});
});
