import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getProviderDefinition } from "../src/registry/registry";

const encodedMuseCredential = JSON.stringify({
	oauthAccessToken: "meta-account-access",
	apiKey: "LLM|subscription-key",
});

describe("Muse Code provider", () => {
	test("unwraps only the subscription Model API key for inference and discovery", () => {
		const provider = getProviderDefinition("muse-code");
		if (!provider?.getApiKey) {
			throw new Error("Muse Code transport is not registered");
		}
		const apiKey = provider.getApiKey({
			access: encodedMuseCredential,
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		});
		expect(apiKey).toBe("LLM|subscription-key");
	});

	test("keeps Meta PAYG and Muse subscription credentials in separate provider pools", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			usageProviderResolver: () => undefined,
		});
		try {
			await storage.reload();
			await storage.set("meta", [{ type: "api_key", key: "LLM|payg-key", source: "login" }]);
			await storage.set("muse-code", [
				{
					type: "oauth",
					access: encodedMuseCredential,
					refresh: "meta-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "meta-account-1",
				},
			]);

			expect(await storage.getApiKey("meta", "payg-session")).toBe("LLM|payg-key");
			expect(await storage.getApiKey("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(
				await storage.markUsageLimitReached("muse-code", "muse-session", {
					apiKey: encodedMuseCredential,
					retryAfterMs: 60_000,
				}),
			).toMatchObject({ switched: false });
			expect(await storage.getApiKey("muse-code", "muse-session")).toBe(encodedMuseCredential);
			expect(await storage.getApiKey("meta", "payg-session")).toBe("LLM|payg-key");
		} finally {
			storage.close();
		}
	});

	test("keeps the existing Meta Model API login distinct", () => {
		expect(getProviderDefinition("meta")).toMatchObject({ id: "meta", name: "Meta Model API" });
		expect(getProviderDefinition("muse-code")).toMatchObject({
			id: "muse-code",
			name: "Muse Code (Subscription)",
		});
	});
});
