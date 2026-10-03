/**
 * WHY: A cached keyless mark or saved local placeholder must never hide a real key.
 * These controls cover literal config, environment, runtime overrides, and later logins
 * through both request resolvers. A fetch-level probe preserves existing bearer bytes.
 * This suite does not claim token-free wire requests or cover login UI.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as envApiKeys from "@veyyon/ai/env-api-key";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { FetchImpl } from "@veyyon/ai/types";
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

	test("a local placeholder preserves the production stream bearer value", async () => {
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const model = localModel("vllm");
		const authorizations: Array<string | null> = [];
		const fetchProbe: FetchImpl = async (input, init) => {
			authorizations.push(
				new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization"),
			);
			return new Response(
				[
					'data: {"id":"response-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
					'data: {"id":"response-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
					"data: [DONE]",
					"",
					"",
				].join("\n\n"),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};
		const message = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{ apiKey: await registry.getApiKey(model), fetch: fetchProbe },
		).result();
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(authorizations).toEqual(["Bearer vllm-local"]);
	});

	test("a placeholder-only vllm login preserves request auth and satisfies selection checks", async () => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const vllmModel = buildModel({
			provider: "vllm",
			id: "qwen3-8b",
			name: "Qwen 3 8B",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8000/v1",
			contextWindow: 32768,
			maxTokens: 4096,
			reasoning: false,
			input: ["text"],
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

		// Preserve the fork's existing request credential rather than converting it to Bearer N/A.
		expect(await registry.getApiKey(vllmModel)).toBe("vllm-local");
		expect(await registry.getApiKeyForProvider("vllm")).toBe("vllm-local");
	});

	test.each([
		["lm-studio", "lm-studio-local"],
		["llama.cpp", "llama-cpp-local"],
	])("%s placeholders preserve request credentials", async (provider, placeholder) => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const model = buildModel({
			provider,
			id: "local-model",
			name: "Local Model",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 32768,
			maxTokens: 4096,
			reasoning: false,
			input: ["text"],
		});
		await authStorage.set(provider, { type: "api_key", key: placeholder });
		expect(registry.isKeylessProvider(provider)).toBe(true);
		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(registry.hasConcreteAuth(provider)).toBe(true);
		expect(await registry.getApiKey(model)).toBe(placeholder);
		expect(await registry.getApiKeyForProvider(provider)).toBe(placeholder);
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
			maxTokens: 4096,
			reasoning: false,
			input: ["text"],
		});

		// Storing a concrete token instead of a local placeholder
		await authStorage.set("vllm", { type: "api_key", key: "sk-real-vllm-token" });

		expect(registry.isKeylessProvider("vllm")).toBe(false);
		expect(registry.hasConfiguredAuth(vllmModel)).toBe(true);
		expect(registry.hasConcreteAuth("vllm")).toBe(true);
		expect(await registry.getApiKey(vllmModel)).toBe("sk-real-vllm-token");
		expect(await registry.getApiKeyForProvider("vllm")).toBe("sk-real-vllm-token");
	});

	function localModel(provider: string) {
		return buildModel<"openai-completions">({
			provider,
			id: "local-model",
			name: "Local Model",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			contextWindow: 32768,
			maxTokens: 4096,
			reasoning: false,
			input: ["text"],
		});
	}

	test("literal config outranks a saved local placeholder in both resolvers", async () => {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: { vllm: { apiKey: "real-config-key" } } }));
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		expect(await registry.getApiKey(localModel("vllm"))).toBe("real-config-key");
		expect(await registry.getApiKeyForProvider("vllm")).toBe("real-config-key");
	});

	test("environment auth outranks a saved local placeholder in both resolvers", async () => {
		const envKey = spyOn(envApiKeys, "getEnvApiKey").mockImplementation(provider =>
			provider === "vllm" ? "real-env-key" : undefined,
		);
		try {
			await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });
			const registry = new ModelRegistryImpl(authStorage, modelsPath);
			expect(await registry.getApiKey(localModel("vllm"))).toBe("real-env-key");
			expect(await registry.getApiKeyForProvider("vllm")).toBe("real-env-key");
		} finally {
			envKey.mockRestore();
		}
	});

	test("runtime auth outranks a saved local placeholder in both resolvers", async () => {
		await authStorage.set("vllm", { type: "api_key", key: "vllm-local" });
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		authStorage.setRuntimeApiKey("vllm", "real-runtime-key");
		expect(await registry.getApiKey(localModel("vllm"))).toBe("real-runtime-key");
		expect(await registry.getApiKeyForProvider("vllm")).toBe("real-runtime-key");
	});

	test("a later real login outranks an implicit keyless mark in both resolvers", async () => {
		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		const model = localModel("lm-studio");
		expect(await registry.getApiKey(model)).toBe(kNoAuth);
		expect(await registry.getApiKeyForProvider("lm-studio")).toBe(kNoAuth);
		await authStorage.set("lm-studio", { type: "api_key", key: "real-login-key" });
		expect(await registry.getApiKey(model)).toBe("real-login-key");
		expect(await registry.getApiKeyForProvider("lm-studio")).toBe("real-login-key");
	});
});
