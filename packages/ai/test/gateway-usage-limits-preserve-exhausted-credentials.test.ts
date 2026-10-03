// WHY: Usage exhaustion blocks a key until reset; it must never delete it.
import { expect, it } from "bun:test";
import { refreshGatewayApiKeyAfterAuthError } from "../src/auth-gateway/dispatch";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

it("rotates only to an available sibling without deleting exhausted credentials", async () => {
	const blocked: string[] = [];
	const invalidated: string[] = [];
	let siblingAvailable = true;
	const storage = {
		getApiKey: async () => "sibling-key",
		markUsageLimitReached: async (_provider: string, _session: string, options: { apiKey: string }) => {
			blocked.push(options.apiKey);
			return { switched: siblingAvailable };
		},
		invalidateCredentialMatching: async (_provider: string, key: string) => {
			invalidated.push(key);
		},
	} as unknown as AuthStorage;
	const model = { provider: "example", id: "example-model" } as Model<Api>;
	const rotate = (key: string, error: Error) =>
		refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			"session",
			"example",
			key,
			error,
			new AbortController().signal,
			"speech",
			"test",
		);
	expect(await rotate("initial-key", new Error("usage_limit_reached"))).toBe("sibling-key");
	siblingAvailable = false;
	expect(await rotate("sibling-key", new Error("usage_limit_reached"))).toBeUndefined();
	expect(blocked).toEqual(["initial-key", "sibling-key"]);
	expect(invalidated).toEqual([]);
	expect(await rotate("invalid-key", new Error("unauthorized"))).toBe("sibling-key");
	expect(invalidated).toEqual(["invalid-key"]);
});
