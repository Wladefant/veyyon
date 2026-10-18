import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { logger } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";
import { SessionAffinity, type SessionRestrictions } from "../src/auth/affinity";
import { BlockStoreHealth, CredentialBlocks } from "../src/auth/blocks";
import { KeyCascade, KeyOverrides } from "../src/auth/cascade";
import { CredentialPool } from "../src/auth/pool";
import { AccountPolicies } from "../src/auth/policy";
import { OAuthRefresher } from "../src/auth/refresh";
import { CredentialSelector } from "../src/auth/select";
import type { AuthCredentialStore as NamespaceCredentialStore } from "../src/auth/store";
import { SqliteAuthCredentialStore as NamespaceSqliteStore } from "../src/auth/sqlite-credential-store";
import { UsageService } from "../src/auth/usage";
import { UsageCache } from "../src/auth/usage-cache";
import { withEnv } from "./helpers";

// Clear every env var the providers under test alias, so ambient shell / ~/.env
// state can't leak an env origin into precedence assertions.
const SUPPRESS_ENV = {
	OPENAI_API_KEY: undefined,
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	COPILOT_GITHUB_TOKEN: undefined,
} as const;

async function createKeyCascade(
	store: NamespaceCredentialStore,
	overrides = new KeyOverrides(),
): Promise<KeyCascade> {
	const policies = new AccountPolicies([], undefined);
	const health = new BlockStoreHealth(undefined);
	const pool = new CredentialPool(store, { policies, blockHealth: health, onReset: () => {} });
	const restrictions: SessionRestrictions = new Map();
	const affinity = new SessionAffinity(store, pool, overrides, restrictions);
	const usageProviders = () => undefined;
	const strategies = () => undefined;
	const usageCache = new UsageCache(store, pool, usageProviders);
	const blocks = new CredentialBlocks({ store, pool, health, usageCache, strategies });
	const refresher = new OAuthRefresher({ store, pool });
	const usage = new UsageService({
		store,
		pool,
		overrides,
		refresher,
		cache: usageCache,
		blocks,
		affinity,
		strategies,
		usageProviders,
		fetch: globalThis.fetch,
		requestTimeoutMs: 1,
		logger,
	});
	const selector = new CredentialSelector({ store, pool, policies, blocks, affinity, usage, refresher, strategies });
	await pool.reload();
	return new KeyCascade({ pool, overrides, selector, affinity, rotate: async () => ({ switched: false }) });
}

function credentialOrigin(storage: AuthStorage | null, provider: string) {
	const source = storage?.keys.source(provider, { env: "aliases" });
	if (!source) return undefined;
	return source.envVar === undefined ? { kind: source.kind } : { kind: source.kind, envVar: source.envVar };
}

describe("AuthStorage.keys.source", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-origin-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		auth = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("undefined when no auth is configured", async () => {
		await withEnv(SUPPRESS_ENV, () => {
			// Provider absent from the env map entirely — no env fallback can apply.
			expect(credentialOrigin(auth, "no-such-provider")).toBeUndefined();
		});
	});

	test("env origin carries the backing variable name for single-var providers", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, () => {
			expect(credentialOrigin(auth, "github-copilot")).toEqual({
				kind: "env",
				envVar: "COPILOT_GITHUB_TOKEN",
			});
		});
	});

	test("env origin omits the variable name for computed resolvers", async () => {
		// anthropic resolves through $pickenv(...) — no single variable describes it.
		await withEnv({ ...SUPPRESS_ENV, ANTHROPIC_API_KEY: "sk-fake" }, () => {
			expect(credentialOrigin(auth, "anthropic")).toEqual({ kind: "env" });
		});
	});

	test("a stored OAuth credential outranks an env var", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, async () => {
			await auth?.credentials.set("github-copilot", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			]);
			expect(credentialOrigin(auth, "github-copilot")).toEqual({ kind: "oauth" });
		});
	});

	test("a stored OAuth credential outranks a co-stored api key", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			// keys.get() resolves stored OAuth before a stored api_key, so the origin must match.
			await auth?.credentials.set("openai", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
				{ type: "api_key", key: "sk-stored" },
			]);
			expect(credentialOrigin(auth, "openai")).toEqual({ kind: "oauth" });
		});
	});

	test("an explicit env var outranks a stored api key", async () => {
		// Regression: a live env var is the user's current choice and must win over a stored
		// static api_key (e.g. a stale broker-migrated copy) so `GEMINI_API_KEY` etc. take effect.
		await withEnv({ ...SUPPRESS_ENV, OPENAI_API_KEY: "sk-env" }, async () => {
			await auth?.credentials.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(credentialOrigin(auth, "openai")).toEqual({ kind: "env", envVar: "OPENAI_API_KEY" });
			expect(await auth?.keys.get("openai")).toBe("sk-env");
		});
	});

	test("config then runtime overrides take precedence over stored credentials", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(credentialOrigin(auth, "openai")).toEqual({ kind: "api_key" });

			auth.keys.setConfig("openai", "gateway-bearer");
			expect(credentialOrigin(auth, "openai")).toEqual({ kind: "config" });

			auth.keys.setRuntime("openai", "cli-flag-bearer");
			expect(credentialOrigin(auth, "openai")).toEqual({ kind: "runtime" });
		});
	});
});

describe("KeyCascade fallback sources", () => {
	let tempDir = "";
	let store: NamespaceCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-key-cascade-"));
		store = await NamespaceSqliteStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("a fallback resolver serves source, peek, and get even when env is excluded", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			const keys = await createKeyCascade(store);
			keys.setFallbackResolver(provider => (provider === "custom" ? "host-key" : undefined));

			expect(keys.source("custom", { env: "none" })).toEqual({ kind: "fallback", concrete: true });
			expect(await keys.peek("custom")).toBe("host-key");
			expect(await keys.get("custom")).toBe("host-key");
		});
	});

	test("fallback resolver values are resolved afresh by each lookup", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			const keys = await createKeyCascade(store);
			let calls = 0;
			keys.setFallbackResolver(() => `host-key-${++calls}`);

			expect(keys.source("custom", { env: "none" })).toEqual({ kind: "fallback", concrete: true });
			expect(await keys.peek("custom")).toBe("host-key-2");
			expect(await keys.get("custom")).toBe("host-key-3");
			expect(calls).toBe(3);
		});
	});

	test("ChatGPT Web serves Codex OAuth through source, peek, and get", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			await store.upsertAuthCredential("openai-codex", {
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				expires: Date.now() + 3_600_000,
			});
			const keys = await createKeyCascade(store);

			expect(keys.source("chatgpt-web", { env: "none" })).toEqual({
				kind: "oauth",
				concrete: true,
				effectiveProvider: "openai-codex",
			});
			expect(await keys.peek("chatgpt-web")).toBe("codex-access");
			expect(await keys.get("chatgpt-web")).toBe("codex-access");
		});
	});

	test("ChatGPT Web keeps Codex OAuth ahead of a host fallback resolver", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			await store.upsertAuthCredential("openai-codex", {
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				expires: Date.now() + 3_600_000,
			});
			const keys = await createKeyCascade(store);
			let resolverCalls = 0;
			keys.setFallbackResolver(() => {
				resolverCalls += 1;
				return "host-key";
			});

			expect(keys.source("chatgpt-web", { env: "none" })).toEqual({
				kind: "oauth",
				concrete: true,
				effectiveProvider: "openai-codex",
			});
			expect(await keys.peek("chatgpt-web")).toBe("codex-access");
			expect(await keys.get("chatgpt-web")).toBe("codex-access");
			expect(resolverCalls).toBe(0);
		});
	});

	test("ChatGPT Web's own stored key outranks its Codex OAuth fallback", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			await store.upsertAuthCredential("openai-codex", {
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				expires: Date.now() + 3_600_000,
			});
			await store.upsertAuthCredential("chatgpt-web", { type: "api_key", key: "web-key" });
			const keys = await createKeyCascade(store);

			expect(keys.source("chatgpt-web", { env: "none" })).toEqual({ kind: "api_key", concrete: true });
			expect(await keys.peek("chatgpt-web")).toBe("web-key");
			expect(await keys.get("chatgpt-web")).toBe("web-key");
		});
	});

	test("a rebuilt cascade reads the fallback resolver from shared overrides", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			const overrides = new KeyOverrides();
			const original = await createKeyCascade(store, overrides);
			original.setFallbackResolver(() => "host-key");

			const replacement = await createKeyCascade(store, overrides);
			replacement.setFallbackResolver(overrides.fallbackResolver());
			expect(replacement.source("custom", { env: "none" })).toEqual({ kind: "fallback", concrete: true });
			expect(await replacement.get("custom")).toBe("host-key");
		});
	});

	test("hasApiKeyOverride tracks runtime and direct config overrides", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			const keys = await createKeyCascade(store);

			expect(keys.hasApiKeyOverride("openai")).toBe(false);
			keys.setRuntime("openai", "runtime-key");
			expect(keys.hasApiKeyOverride("openai")).toBe(true);
			keys.removeRuntime("openai");
			expect(keys.hasApiKeyOverride("openai")).toBe(false);
			keys.setConfig("openai", "configured-key");
			expect(keys.hasApiKeyOverride("openai")).toBe(true);
		});
	});
});
