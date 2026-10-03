import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, type FetchImpl } from "@veyyon/ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { unregisterOAuthProviders } from "@veyyon/ai/oauth";
import {
	ModelRegistry as ModelRegistryImpl,
	type ProviderConfigInput,
} from "@veyyon/coding-agent/config/model-registry";
import { removeSyncWithRetries } from "@veyyon/utils";
import { Database } from "bun:sqlite";

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

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-login-key-"));
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }), "utf8");
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		authStorage = new AuthStorage(store);
		registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: offlineFetch });
		discoveryKeys = [];
		delete process.env[envName];
	});

	afterEach(() => {
		delete process.env[envName];
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		db.close();
		removeSyncWithRetries(tempDir);
	});

	function register(options: { oauth: boolean }): void {
		const config: ProviderConfigInput = {
			apiKey: envName,
			baseUrl: "https://login-key-precedence.example.com/v1",
			api: "openai-completions",
			...(options.oauth ? { oauth: { name: "Test", login: async () => savedKey } } : {}),
			fetchDynamicModels: async (apiKey) => {
				discoveryKeys.push(apiKey);
				if (apiKey !== savedKey && apiKey !== "env-key") throw new Error("401 invalid key");
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
});
