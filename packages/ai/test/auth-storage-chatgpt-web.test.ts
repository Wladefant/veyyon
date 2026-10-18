import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const envNames = ["CODEX_CHATGPT_WEB_OAUTH_TOKEN", "OPENAI_CODEX_OAUTH_TOKEN"] as const;
const sourceId = "auth-storage-chatgpt-web-test";

describe("ChatGPT Web stored Codex OAuth fallback", () => {
	let tempDir: string;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let savedEnv: Array<string | undefined>;
	let refreshCalls: number;

	beforeEach(async () => {
		savedEnv = envNames.map(name => process.env[name]);
		for (const name of envNames) delete process.env[name];
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-auth-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		refreshCalls = 0;
		registerOAuthProvider({
			id: "openai-codex",
			name: "Test Codex",
			sourceId,
			async login() {
				throw new Error("unused");
			},
			async refreshToken(credential) {
				refreshCalls++;
				return {
					...credential,
					access: "refreshed-access",
					refresh: "rotated-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
			getApiKey: credential => credential.access,
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(sourceId);
		store.close();
		for (const [index, name] of envNames.entries()) {
			if (savedEnv[index] === undefined) delete process.env[name];
			else process.env[name] = savedEnv[index];
		}
		await removeWithRetries(tempDir);
	});

	async function seedCodex(expires = Date.now() + 3_600_000) {
		await storage.credentials.set("openai-codex", { type: "oauth", access: "codex-access", refresh: "codex-refresh", expires });
	}

	test("uses a dedicated ChatGPT Web credential before the Codex row", async () => {
		await seedCodex();
		await storage.credentials.set("chatgpt-web", { type: "api_key", key: "dedicated-key", source: "login" });
		process.env.CODEX_CHATGPT_WEB_OAUTH_TOKEN = "env-access";
		expect(storage.keys.source("chatgpt-web", { env: "aliases" }) !== undefined).toBe(true);
		expect(storage.credentials.hasOAuth("chatgpt-web")).toBe(false);
		expect(await storage.keys.peek("chatgpt-web")).toBe("dedicated-key");
		expect(await storage.keys.get("chatgpt-web")).toBe("dedicated-key");
	});

	for (const name of envNames) {
		test(`prefers ${name} to the stored Codex row`, async () => {
			await seedCodex();
			process.env[name] = "env-access";
			expect(storage.keys.source("chatgpt-web", { env: "aliases" }) !== undefined).toBe(true);
			expect(storage.credentials.hasOAuth("chatgpt-web")).toBe(false);
			expect(await storage.keys.peek("chatgpt-web")).toBe("env-access");
			expect(await storage.keys.get("chatgpt-web")).toBe("env-access");
			expect(refreshCalls).toBe(0);
		});
	}

	test("reads a persisted Codex OAuth row without copying it to ChatGPT Web", async () => {
		await seedCodex();
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		expect(storage.keys.source("chatgpt-web", { env: "aliases" }) !== undefined).toBe(true);
		expect(storage.credentials.hasOAuth("chatgpt-web")).toBe(true);
		expect(await storage.keys.peek("chatgpt-web")).toBe("codex-access");
		expect(await storage.keys.get("chatgpt-web", "web-session")).toBe("codex-access");
		expect(store.listAuthCredentials("chatgpt-web")).toHaveLength(0);
		expect(refreshCalls).toBe(0);
	});

	test("refreshes an expired fallback under its original Codex row", async () => {
		await seedCodex(Date.now() - 1_000);
		expect(await storage.keys.peek("chatgpt-web")).toBeUndefined();
		expect(refreshCalls).toBe(0);
		expect(await storage.keys.get("chatgpt-web", "web-session")).toBe("refreshed-access");
		expect(refreshCalls).toBe(1);
		expect(store.listAuthCredentials("openai-codex")[0]?.credential).toMatchObject({
			access: "refreshed-access",
			refresh: "rotated-refresh",
		});
		expect(store.listAuthCredentials("chatgpt-web")).toHaveLength(0);
	});

	test("honours forced refresh of a valid fallback", async () => {
		await seedCodex();
		expect(await storage.keys.get("chatgpt-web", "web-session", { forceRefresh: true })).toBe("refreshed-access");
		expect(refreshCalls).toBe(1);
	});

	test("reports no auth when nothing is configured", async () => {
		expect(storage.keys.source("chatgpt-web", { env: "aliases" }) !== undefined).toBe(false);
		expect(storage.credentials.hasOAuth("chatgpt-web")).toBe(false);
		expect(await storage.keys.peek("chatgpt-web")).toBeUndefined();
		expect(await storage.keys.get("chatgpt-web")).toBeUndefined();
	});

	test("does not borrow a Codex static API key or expose Codex OAuth to other providers", async () => {
		await storage.credentials.set("openai-codex", { type: "api_key", key: "not-oauth" });
		expect(storage.keys.source("chatgpt-web", { env: "aliases" }) !== undefined).toBe(false);
		expect(await storage.keys.get("chatgpt-web")).toBeUndefined();
		await seedCodex();
		expect(storage.keys.source("unrelated-provider", { env: "aliases" }) !== undefined).toBe(false);
		expect(storage.credentials.hasOAuth("unrelated-provider")).toBe(false);
		expect(await storage.keys.peek("unrelated-provider")).toBeUndefined();
		expect(await storage.keys.get("unrelated-provider")).toBeUndefined();
	});
});
