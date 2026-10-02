import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { fetchCodexDiscoveryModels } from "../scripts/generate-models";

describe("fetchCodexDiscoveryModels", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("unions models across all configured OAuth accounts via the generator entrypoint", async () => {
		const authStorage = {
			getOAuthAccesses: async () => [
				{ ok: true, accessToken: "token-a", accountId: "acc-a" },
				{ ok: true, accessToken: "token-b", accountId: "acc-b" },
			],
			close: () => {},
		} as unknown as AuthStorage;

		const requestedAccounts: string[] = [];
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
			requestedAccounts.push(accountId);
			if (accountId === "acc-a") {
				return Response.json({
					models: [
						{ slug: "model-a", display_name: "Model A", context_window: 128_000, input_modalities: ["text"] },
					],
				});
			}
			if (accountId === "acc-b") {
				return Response.json({
					models: [
						{ slug: "model-b", display_name: "Model B", context_window: 256_000, input_modalities: ["text"] },
					],
				});
			}
			return Response.json({ models: [] });
		}) as unknown as typeof fetch;

		const models = await fetchCodexDiscoveryModels(authStorage);
		expect(requestedAccounts.sort()).toEqual(["acc-a", "acc-b"]);
		const slugs = models.map(m => m.id);
		expect(slugs).toContain("model-a");
		expect(slugs).toContain("model-b");
	});

	it("aborts discovery (returns empty array to keep previous models) when any account access fails", async () => {
		const authStorage = {
			getOAuthAccesses: async () => [
				{ ok: true, accessToken: "token-a", accountId: "acc-a" },
				{ ok: false, error: "expired and refresh failed" },
			],
			close: () => {},
		} as unknown as AuthStorage;

		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return Response.json({ models: [] });
		}) as unknown as typeof fetch;

		const models = await fetchCodexDiscoveryModels(authStorage);
		expect(models).toEqual([]);
		expect(fetchCalled).toBe(false);
	});
});
