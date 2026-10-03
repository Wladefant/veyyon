import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { Database } from "bun:sqlite";
import { buildModel } from "@veyyon/catalog/build";
import { kNoAuth } from "@veyyon/coding-agent/config/auth-state";
import { ModelRegistry as ModelRegistryImpl } from "@veyyon/coding-agent/config/model-registry";
import { removeSyncWithRetries } from "@veyyon/utils";

describe("keyless local placeholder auth (Refs #107, upstream 1d78d2b9 & 0e483420)", () => {
	let tempDir: string;
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-placeholder-auth-"));
		modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }), "utf8");
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		authStorage = new AuthStorage(store);
	});

	afterEach(() => {
		authStorage.close();
		db.close();
		removeSyncWithRetries(tempDir);
	});

	test("a placeholder-only vllm login resolves request auth to kNoAuth sentinel and satisfies selection checks", async () => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const vllmModel = buildModel({
			provider: "vllm",
			id: "qwen3-8b",
			name: "Qwen 3 8B",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8000/v1",
			contextWindow: 32768,
			maxOutputTokens: 4096,
		});

		// Before login: unconfigured, no placeholder stored
		expect(registry.isKeylessProvider("vllm")).toBe(false);
		expect(registry.hasConfiguredAuth(vllmModel)).toBe(false);
		expect(registry.hasConcreteAuth("vllm")).toBe(false);
		expect(await registry.getApiKey(vllmModel)).toBeUndefined();
		expect(await registry.getApiKeyForProvider("vllm")).toBeUndefined();

		// User logs in to local vllm with empty prompt, storing the local placeholder token
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });

		// After login: provider is recognized as keyless
		expect(registry.isKeylessProvider("vllm")).toBe(true);
		expect(registry.hasConfiguredAuth(vllmModel)).toBe(true);
		expect(registry.hasConcreteAuth("vllm")).toBe(true);

		// Wire request credential resolution yields kNoAuth instead of sending vllm-local as bearer
		expect(await registry.getApiKey(vllmModel)).toBe(kNoAuth);
		expect(await registry.getApiKeyForProvider("vllm")).toBe(kNoAuth);
	});

	test("lm-studio-local and llama-cpp-local placeholders resolve to kNoAuth", async () => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const lmStudioModel = buildModel({
			provider: "lm-studio",
			id: "deepseek-r1",
			name: "DeepSeek R1",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 32768,
			maxOutputTokens: 4096,
		});

		await authStorage.set("lm-studio", { type: "api_key", key: "lm-studio-local" });
		expect(registry.isKeylessProvider("lm-studio")).toBe(true);
		expect(registry.hasConfiguredAuth(lmStudioModel)).toBe(true);
		expect(registry.hasConcreteAuth("lm-studio")).toBe(true);
		expect(await registry.getApiKey(lmStudioModel)).toBe(kNoAuth);
		expect(await registry.getApiKeyForProvider("lm-studio")).toBe(kNoAuth);
	});

	test("a real configured API key outranks placeholder and returns the concrete key", async () => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const vllmModel = buildModel({
			provider: "vllm",
			id: "qwen3-8b",
			name: "Qwen 3 8B",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8000/v1",
			contextWindow: 32768,
			maxOutputTokens: 4096,
		});

		// Storing a concrete token instead of a local placeholder
		await authStorage.set("vllm", { type: "api_key", key: "sk-real-vllm-token" });

		expect(registry.isKeylessProvider("vllm")).toBe(false);
		expect(registry.hasConfiguredAuth(vllmModel)).toBe(true);
		expect(registry.hasConcreteAuth("vllm")).toBe(true);
		expect(await registry.getApiKey(vllmModel)).toBe("sk-real-vllm-token");
		expect(await registry.getApiKeyForProvider("vllm")).toBe("sk-real-vllm-token");
	});
});
