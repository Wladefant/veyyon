// WHY: A retry must invalidate the refreshed credential, not the initial key.
// Usage recording excludes zero-token calls but retains cache and cost fields.
import { expect, it } from "bun:test";
import { buildGatewayApiKeyResolver, recordGatewayUsage } from "../src/auth-gateway/dispatch";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model, Usage } from "../src/types";

const model = { provider: "example", id: "example-model" } as Model<Api>;
it("invalidates the latest key after refresh and reports the replacement", async () => {
	const invalidated: string[] = [];
	const resolved: string[] = [];
	let active = "refreshed-key";
	const storage = {
		getApiKey: async () => active,
		invalidateCredentialMatching: async (_provider: string, key: string) => {
			invalidated.push(key);
			active = "replacement-key";
		},
	} as unknown as AuthStorage;
	const resolver = buildGatewayApiKeyResolver(storage, model, "session", "initial-key", new AbortController().signal, "speech", "test", key => resolved.push(key));
	expect(await resolver({ lastChance: false })).toBe("initial-key");
	expect(await resolver({ lastChance: false, error: new Error("unauthorized") })).toBe("refreshed-key");
	expect(await resolver({ lastChance: true, error: new Error("unauthorized") })).toBe("replacement-key");
	expect(invalidated).toEqual(["refreshed-key"]);
	expect(resolved).toEqual(["refreshed-key", "replacement-key"]);
});

it("records cache usage and cost once, excluding zero-token calls", () => {
	const observed: unknown[] = [];
	const costs: unknown[] = [];
	const storage = {
		recordObservedUsage: (entry: unknown) => observed.push(entry),
		recordUsageCost: (...args: unknown[]) => costs.push(args),
	} as unknown as AuthStorage;
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	recordGatewayUsage(storage, model, { app: "client" }, usage);
	expect(observed).toEqual([]);
	expect(costs).toEqual([]);
	usage.cacheRead = 12;
	usage.cost.total = 0.25;
	recordGatewayUsage(storage, model, { app: "client" }, usage, 100);
	expect(observed).toEqual([{ provider: "example", model: "example-model", at: 100, client: { app: "client" }, usage: { input: 0, output: 0, cacheRead: 12, cacheWrite: 0 }, costUsd: 0.25 }]);
	expect(costs).toEqual([["example", 0.25, { recordedAt: 100 }]]);
});
