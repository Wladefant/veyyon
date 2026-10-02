// WHY: A refreshed bearer can fail too; rotation must invalidate that bearer rather than the request's initial key.
// Covers shared resolver retry state, not provider-specific classification of HTTP failures.
import { expect, it } from "bun:test";
import { buildGatewayApiKeyResolver } from "../src/auth-gateway/dispatch";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

it("invalidates the latest refreshed or rotated key across consecutive retry cycles", async () => {
	const invalidated: string[] = [];
	const keys: Array<string | undefined> = ["refreshed-key", "sibling-key", undefined, "final-key"];
	const storage = {
		getApiKey: async () => keys.shift(),
		invalidateCredentialMatching: async (_provider: string, key: string) => {
			invalidated.push(key);
		},
	} as unknown as AuthStorage;
	const model = { provider: "example", id: "example-model" } as Model<Api>;
	const resolver = buildGatewayApiKeyResolver(
		storage,
		model,
		"session",
		"initial-key",
		new AbortController().signal,
		"chat",
		"test",
	);
	expect(await resolver({ lastChance: false, error: undefined })).toBe("initial-key");
	const error = new Error("unauthorized");
	expect(await resolver({ lastChance: false, error })).toBe("refreshed-key");
	expect(await resolver({ lastChance: true, error })).toBe("sibling-key");
	expect(await resolver({ lastChance: false, error })).toBeUndefined();
	expect(await resolver({ lastChance: true, error })).toBe("final-key");
	expect(invalidated).toEqual(["refreshed-key", "sibling-key"]);
});
