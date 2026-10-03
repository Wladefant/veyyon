/**
 * WHY: Extension login credentials must outrank config fallbacks in request and discovery paths.
 * Literal/env and command-backed values share the same tier. These controls also defend
 * credential-origin reporting and the deliberate override policy without a login flow.
 * They do not cover provider wire auth or OAuth refresh scheduling.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, type FetchImpl } from "@veyyon/ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { unregisterOAuthProviders } from "@veyyon/ai/oauth";
import { buildModel } from "@veyyon/catalog/build";
import {
	ModelRegistry as ModelRegistryImpl,
	type ProviderConfigInput,
} from "@veyyon/coding-agent/config/model-registry";
import { removeSyncWithRetries } from "@veyyon/utils";

// Extension providers (e.g. nexos-pi-provider) register `apiKey: "<ENV_NAME>"`
// alongside a `/login` flow. With the env var unset, the name resolves to its
// literal text; it must not shadow the key saved by /login, or discovery and
// requests authenticate with "<ENV_NAME>" and the provider's models vanish.
describe("runtime provider apiKey vs /login credential (Refs #107, upstream 1f2a57a1 & 2714c7a1)", () => {
	const provider = "login-key-precedence";
	const envName = "LOGIN_KEY_PRECEDENCE_TEST_KEY";
	const sourceId = "ext://login-key-precedence";
	const savedKey = "saved-login-key";
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled"));
	let tempDir: string;
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	let registry: ModelRegistryImpl;
	let discoveryKeys: Array<string | undefined>;
	let originalEnvValue: string | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-login-key-"));
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }), "utf8");
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		authStorage = new AuthStorage(store);
		registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: offlineFetch });
		discoveryKeys = [];
		originalEnvValue = process.env[envName];
		delete process.env[envName];
	});

	afterEach(() => {
		if (originalEnvValue === undefined) delete process.env[envName];
		else process.env[envName] = originalEnvValue;
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		db.close();
		removeSyncWithRetries(tempDir);
	});

	function register(options: { oauth: boolean; apiKey?: string }): void {
		const config: ProviderConfigInput = {
			apiKey: options.apiKey ?? envName,
			baseUrl: "https://login-key-precedence.example.com/v1",
			api: "openai-completions",
			...(options.oauth ? { oauth: { name: "Test", login: async () => savedKey } } : {}),
			fetchDynamicModels: async apiKey => {
				discoveryKeys.push(apiKey);
				if (apiKey !== savedKey && apiKey !== "env-key" && apiKey !== "command-fallback-key")
					throw new Error("401 invalid key");
				return [
					{
						id: "listed-model",
						name: "Listed",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		registry.registerProvider(provider, config, sourceId);
	}

	async function login(): Promise<void> {
		await authStorage.login(provider, {
			onAuth() {},
			onPrompt: async () => savedKey,
		});
	}

	test("saved /login key beats configured extension apiKey for discovery and requests", async () => {
		process.env[envName] = "ext-fallback-key";
		register({ oauth: true });
		await login();
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual([savedKey]);
		expect(registry.find(provider, "listed-model")).toBeDefined();
		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
	});

	test("login key survives a static reload that reinstalls runtime keys", async () => {
		register({ oauth: true });
		await login();
		await registry.refresh("online");

		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
		expect(registry.find(provider, "listed-model")).toBeDefined();
	});

	test("without a login, the provider apiKey still resolves from the environment", async () => {
		process.env[envName] = "env-key";
		register({ oauth: true });
		await registry.refreshProvider(provider, "online");

		expect(discoveryKeys).toEqual(["env-key"]);
		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});

	test("providers without a /login flow keep apiKey as an override", async () => {
		process.env[envName] = "env-key";
		register({ oauth: false });
		// A /login-sourced key outranks the fallback tier, so env-key wins only as an override.
		await authStorage.set(provider, { type: "api_key", key: "stored-key", source: "login" });

		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});

	const commandKey = "!printf command-fallback-key";

	test("a literal extension fallback keeps saved login auth in discovery and requests", async () => {
		register({ oauth: true, apiKey: "literal-fallback-key" });
		await login();
		await registry.refreshProvider(provider, "online");
		expect(discoveryKeys).toEqual([savedKey]);
		const model = registry.find(provider, "listed-model");
		if (!model) throw new Error("missing listed model after login discovery");
		expect(await registry.getApiKey(model)).toBe(savedKey);
		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("api_key");
	});

	test("a command fallback keeps saved login auth during discovery", async () => {
		register({ oauth: true, apiKey: commandKey });
		await login();
		await registry.refreshProvider(provider, "online");
		expect(discoveryKeys).toEqual([savedKey]);
		expect(registry.find(provider, "listed-model")?.id).toBe("listed-model");
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("api_key");
	});

	test("a command fallback keeps saved login auth for provider requests", async () => {
		register({ oauth: true, apiKey: commandKey });
		await login();
		expect(await registry.getApiKeyForProvider(provider)).toBe(savedKey);
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("api_key");
	});

	test("a command fallback keeps saved login auth for model requests", async () => {
		register({ oauth: true, apiKey: commandKey });
		await login();
		const model = buildModel<"openai-completions">({
			provider,
			id: "listed-model",
			name: "Listed",
			api: "openai-completions",
			baseUrl: "https://login-key-precedence.example.com/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		expect(await registry.getApiKey(model)).toBe(savedKey);
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("api_key");
	});

	test("a command fallback is usable without a saved login", async () => {
		register({ oauth: true, apiKey: commandKey });
		expect(await registry.getApiKeyForProvider(provider)).toBe("command-fallback-key");
		await registry.refreshProvider(provider, "online");
		expect(discoveryKeys).toEqual(["command-fallback-key"]);
		expect(registry.find(provider, "listed-model")?.id).toBe("listed-model");
	});

	test("a command without a login flow keeps its override tier", async () => {
		register({ oauth: false, apiKey: commandKey });
		await authStorage.set(provider, { type: "api_key", key: savedKey, source: "login" });
		expect(await registry.getApiKeyForProvider(provider)).toBe("command-fallback-key");
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("config");
	});

	test("a static models.json command replacing an extension fallback is an override, not a fallback", async () => {
		register({ oauth: true, apiKey: commandKey });
		await login();
		fs.writeFileSync(
			path.join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: "https://login-key-precedence.example.com/v1",
						api: "openai-completions",
						apiKey: "!printf static-command-key",
						models: [{ id: "static-model", name: "Static" }],
					},
				},
			}),
			"utf8",
		);
		await registry.refresh("offline");
		expect(await registry.getApiKeyForProvider(provider)).toBe("static-command-key");
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("config");
	});

	test("a static models.json command identical to the extension fallback is still an override", async () => {
		register({ oauth: true, apiKey: commandKey });
		await login();
		fs.writeFileSync(
			path.join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: "https://login-key-precedence.example.com/v1",
						api: "openai-completions",
						apiKey: commandKey,
						models: [{ id: "static-model", name: "Static" }],
					},
				},
			}),
			"utf8",
		);
		await registry.refresh("offline");
		expect(await registry.getApiKeyForProvider(provider)).toBe("command-fallback-key");
		expect(authStorage.getCredentialOrigin(provider)?.kind).toBe("config");
	});
});
