import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	createAuthRetryKeyState,
	registerCustomApi,
	resolveApiKeyOnce,
	resolveNextAuthRetryKey,
	seedApiKeyResolver,
	unregisterCustomApis,
} from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "@veyyon/ai/registry/oauth/types";
import { streamSimple } from "@veyyon/ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

const API = "usage-attribution-test" as Api;
const SOURCE_ID = "usage-attribution-test";
const AUTH_FIXTURE_SOURCE = "usage-attribution-auth-storage";

afterEach(() => {
	unregisterCustomApis(SOURCE_ID);
	unregisterOAuthProviders(AUTH_FIXTURE_SOURCE);
});

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(): Model<Api> {
	return {
		id: "usage-attribution-model",
		name: "Usage attribution model",
		api: API,
		provider: "usage-attribution-provider",
		baseUrl: "https://example.test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: "usage-attribution-provider",
		model: "fixture-response-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function registerCredentialProvider(id: string, answer: string | OAuthCredentials): void {
	registerOAuthProvider({
		id: id as OAuthProvider,
		name: `Usage attribution ${id}`,
		sourceId: AUTH_FIXTURE_SOURCE,
		login: async () => answer,
	});
}

describe("usage serving identity", () => {
	it("forwards the selected seed identity through initial resolution", async () => {
		const selected: string[] = [];
		const resolver = seedApiKeyResolver("seed-key", () => "later-key", "stored-credential-17");
		const key = await resolveApiKeyOnce(resolver, undefined, id => selected.push(id));
		expect(key).toBe("seed-key");
		expect(selected).toEqual(["stored-credential-17"]);
	});

	it("reports the credential selected by auth retry resolution", async () => {
		const selected: string[] = [];
		const retryState = createAuthRetryKeyState("old-key");
		const result = await resolveNextAuthRetryKey(
			retryState,
			ctx => {
				ctx.onCredentialSelected?.("credential-retry");
				return "retry-key";
			},
			Object.assign(new Error("401 authentication_error"), { status: 401 }),
			undefined,
			id => selected.push(id),
		);
		expect(result).toBe("retry-key");
		expect(selected).toEqual(["credential-retry"]);
	});

	it("keeps selected credential identities isolated between concurrent requests", async () => {
		const first: string[] = [];
		const second: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>(resolve => (release = resolve));
		const resolveRequest = async (id: string, selected: string[]) => {
			await barrier;
			const retryState = createAuthRetryKeyState(`${id}-old-key`);
			return resolveNextAuthRetryKey(
				retryState,
				ctx => {
					ctx.onCredentialSelected?.(`${id}-retry-credential`);
					return `${id}-retry-key`;
				},
				Object.assign(new Error("401 authentication_error"), { status: 401 }),
				undefined,
				credentialId => selected.push(credentialId),
			);
		};
		const a = resolveRequest("request-a", first);
		const b = resolveRequest("request-b", second);
		release();
		await Promise.all([a, b]);
		expect(first).toEqual(["request-a-retry-credential"]);
		expect(second).toEqual(["request-b-retry-credential"]);
	});

	it("reports stored row IDs and omits identity for runtime and environment keys", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerCredentialProvider("usage-attribution-api-key", "stored-api-key");
		registerCredentialProvider("usage-attribution-oauth", {
			access: "stored-oauth-access",
			refresh: "stored-oauth-refresh",
			expires: Date.now() + 3_600_000,
			email: "usage-attribution@example.test",
		});
		const controller = { onAuth: () => {}, onPrompt: async () => "" };
		const originalEnvKey = process.env.OPENAI_API_KEY;
		try {
			await storage.login("usage-attribution-api-key" as OAuthProvider, controller);
			const apiKeyRow = store.listAuthCredentials("usage-attribution-api-key")[0];
			const apiKeySelection: string[] = [];
			expect(
				await storage.getApiKey("usage-attribution-api-key", undefined, {
					onCredentialSelected: id => apiKeySelection.push(id),
				}),
			).toBe("stored-api-key");
			expect(apiKeySelection).toEqual([String(apiKeyRow.id)]);

			await storage.login("usage-attribution-oauth" as OAuthProvider, controller);
			const oauthRow = store.listAuthCredentials("usage-attribution-oauth")[0];
			const oauthSelection: string[] = [];
			expect(
				await storage.getApiKey("usage-attribution-oauth", undefined, {
					onCredentialSelected: id => oauthSelection.push(id),
				}),
			).toBe("stored-oauth-access");
			expect(oauthSelection).toEqual([String(oauthRow.id)]);

			const runtimeSelection: string[] = [];
			storage.setRuntimeApiKey("usage-attribution-runtime", "runtime-api-key");
			expect(
				await storage.getApiKey("usage-attribution-runtime", undefined, {
					onCredentialSelected: id => runtimeSelection.push(id),
				}),
			).toBe("runtime-api-key");
			expect(runtimeSelection).toEqual([]);

			process.env.OPENAI_API_KEY = "environment-api-key";
			const envSelection: string[] = [];
			expect(
				await storage.getApiKey("openai", undefined, { onCredentialSelected: id => envSelection.push(id) }),
			).toBe("environment-api-key");
			expect(envSelection).toEqual([]);
		} finally {
			if (originalEnvKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalEnvKey;
			store.close();
		}
	});

	it("annotates terminal stream usage with the selected credential and actual model", async () => {
		try {
			const keysSeen: unknown[] = [];
			registerCustomApi(
				API,
				(_model: Model<Api>, _ctx: Context, options?: SimpleStreamOptions) => {
					keysSeen.push(options?.apiKey);
					const events = new AssistantMessageEventStream();
					const terminal = message();
					queueMicrotask(() => {
						events.push({ type: "start", partial: terminal });
						events.push({ type: "done", reason: "stop", message: terminal });
					});
					return events;
				},
				SOURCE_ID,
			);
			const stream = streamSimple(model(), context(), {
				apiKey: async resolverContext => {
					resolverContext.onCredentialSelected?.("stored-credential-23");
					return "api-key";
				},
			});
			for await (const _event of stream) {
				// Drain the provider stream before inspecting its terminal result.
			}
			const result = await stream.result();
			expect(keysSeen).toEqual(["api-key"]);
			expect(result.usage).toMatchObject({
				credentialId: "stored-credential-23",
				model: "fixture-response-model",
				transport: expect.any(String),
			});
		} finally {
			unregisterCustomApis(SOURCE_ID);
		}
	});
});
