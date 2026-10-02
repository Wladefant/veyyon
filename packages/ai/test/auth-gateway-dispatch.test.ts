import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import {
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	normalizeClientSessionKey,
	recordGatewayUsage,
	resolveGatewayAccount,
	resolveGatewayApiKey,
} from "../src/auth-gateway/dispatch";
import { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

function testModel(provider = "test-provider", id = "test-model"): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-chat",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	});
}

describe("auth-gateway dispatch", () => {
	it("normalizes client session keys and identities", async () => {
		expect(normalizeClientSessionKey(undefined)).toBeUndefined();
		expect(normalizeClientSessionKey("   ")).toBeUndefined();
		expect(normalizeClientSessionKey(" session-123 ")).toBe(" session-123 ");

		const storage = await AuthStorage.create(":memory:");
		expect(resolveGatewayAccount(storage, "openai", "sess", "sk-secret-123")).toMatch(/^key:/);
		storage.close();
	});

	it("resolves API key or returns 401 classification", async () => {
		const storage = await AuthStorage.create(":memory:");
		const model = testModel("openai", "gpt-4o");
		const signal = new AbortController().signal;

		const unauth = await resolveGatewayApiKey(storage, model, "sess-1", signal, "127.0.0.1");
		expect(unauth).toEqual({
			status: 401,
			type: "authentication_error",
			message: "No credential available for provider openai",
		});

		storage.setRuntimeApiKey("openai", "sk-test-key");
		const authed = await resolveGatewayApiKey(storage, model, "sess-1", signal, "127.0.0.1");
		expect(authed).toBe("sk-test-key");
		storage.close();
	});

	it("mirrors request abort signals", () => {
		const reqController = new AbortController();
		const req = new Request("http://localhost", { signal: reqController.signal });
		const mirrored = mirrorRequestAbort(req);

		expect(mirrored.signal.aborted).toBe(false);
		reqController.abort("client cancelled");
		expect(mirrored.signal.aborted).toBe(true);
	});

	it("records observed usage and ignores zero usage turns", async () => {
		const storage = await AuthStorage.create(":memory:");
		const model = testModel("openai", "gpt-4o");
		const recorded: unknown[] = [];
		const storageWithHook = Object.assign(storage, {
			recordObservedUsage(entry: unknown) {
				recorded.push(entry);
			},
		});

		recordGatewayUsage(
			storageWithHook,
			model,
			{ app: "test-app" },
			{
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		);
		expect(recorded).toHaveLength(0);

		recordGatewayUsage(
			storageWithHook,
			model,
			{ app: "test-app" },
			{
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
			},
		);
		expect(recorded).toHaveLength(1);
		storage.close();
	});

	it("builds resolver that delivers initial key and observes rotation", async () => {
		const storage = await AuthStorage.create(":memory:");
		const model = testModel("openai", "gpt-4o");
		storage.setRuntimeApiKey("openai", "sk-active");
		let observedKey: string | undefined;

		const resolver = buildGatewayApiKeyResolver(
			storage,
			model,
			"sess-1",
			"sk-initial",
			new AbortController().signal,
			"chat",
			"127.0.0.1",
			key => {
				observedKey = key;
			},
		);

		const initial = await resolver({ lastChance: false, error: undefined });
		expect(initial).toBe("sk-initial");
		expect(observedKey).toBeUndefined();

		const refreshed = await resolver({ lastChance: false, error: new Error("glitch") });
		expect(refreshed).toBe("sk-active");
		expect(observedKey).toBe("sk-active");
		storage.close();
	});
});
