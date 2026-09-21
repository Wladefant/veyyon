/**
 * WHY THIS FILE EXISTS. ChatGPT Web borrows a stored Codex OAuth row when it has no credential of
 * its own, and `getApiKey` resolves that leg against `openai-codex` — which is where the session
 * sticky and the bearer fingerprint land. `rotateSessionCredential` and `markUsageLimitReached`
 * nevertheless acted on the literal requested name, and `chatgpt-web` has no rows: rotation returned
 * `false` without touching anything, so a 401 could not reach a sibling Codex account, and a
 * usage-limit event blocked a provider with nothing in it (#67).
 *
 * THE CLASS IT CLOSES. Every path that acts on "the credential that served this turn" must resolve
 * the same effective provider the resolve leg used. Both directions are pinned here: the fallback
 * turn acts on the Codex row, and a dedicated ChatGPT Web credential keeps acting on its own row, so
 * the precedence cannot silently invert. A provider that is not ChatGPT Web is asserted to gain no
 * effective-provider indirection at all.
 *
 * WHAT IT DOES NOT CATCH. This is the library contract on a real `AuthStorage` over a temp-file
 * SQLite store; the coding-agent's wiring of the retry policy is one package up. Usage-report-derived
 * block deadlines are out of scope — the resolvers are stubbed to `undefined` so the suite makes no
 * network call and cannot be perturbed by another file importing `@veyyon/ai/usage/defaults` into the
 * shared registry. Nothing here covers the ChatGPT Web bridge's request shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE = "a-chatgpt-web-401-rotates-the-effective-codex-account-test";
const SESSION = "web-session";
const ENV_NAMES = ["CODEX_CHATGPT_WEB_OAUTH_TOKEN", "OPENAI_CODEX_OAUTH_TOKEN"] as const;
const CODEX_ACCESS: readonly string[] = ["codex-a-access", "codex-b-access"];
const WEB_ACCESS: readonly string[] = ["web-a-access", "web-b-access"];
const SOLO_CODEX_ACCESS = "codex-solo-access";
const HALF_HOUR_MS = 30 * 60_000;

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

describe("a ChatGPT Web 401 rotates the effective Codex account", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let savedEnv: Array<string | undefined> = [];

	beforeEach(async () => {
		savedEnv = ENV_NAMES.map(name => process.env[name]);
		for (const name of ENV_NAMES) delete process.env[name];
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-effective-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		// Movement between accounts is opt-in, and a suite that asserts a rotation has to ask for one.
		// The usage and ranking resolvers are stubbed so no account lookup reaches the network and no
		// other test file's import of the usage defaults can change what this one observes.
		storage = new AuthStorage(store, {
			loadBalancing: true,
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		for (const id of ["openai-codex", "chatgpt-web"]) {
			registerOAuthProvider({
				id,
				name: `Test ${id}`,
				sourceId: SOURCE,
				async login() {
					throw new Error("unused");
				},
				async refreshToken(credential) {
					return { ...credential, expires: farExpiry() };
				},
				getApiKey: credential => credential.access,
			});
		}
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		storage = undefined;
		for (const [index, name] of ENV_NAMES.entries()) {
			const saved = savedEnv[index];
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuthAccounts(
		auth: AuthStorage,
		provider: string,
		accessTokens: readonly string[],
	): Promise<void> {
		await auth.set(
			provider,
			accessTokens.map((access, index) => ({
				type: "oauth" as const,
				access,
				refresh: `${provider}-${index}-refresh`,
				expires: farExpiry(),
				email: `${provider}-${index}@example.com`,
			})),
		);
	}

	/** The bearer ChatGPT Web resolved, narrowed: every assertion below names the account it belongs to. */
	async function servedBearer(auth: AuthStorage): Promise<string> {
		const apiKey = await auth.getApiKey("chatgpt-web", SESSION);
		if (apiKey === undefined) throw new Error("expected ChatGPT Web to resolve a bearer");
		return apiKey;
	}

	/** The row whose access token served the turn, so assertions name an account rather than an index. */
	function servedRowId(auth: AuthStorage, provider: string, access: string): number {
		const row = auth
			.listStoredCredentials(provider)
			.find(entry => entry.credential.type === "oauth" && entry.credential.access === access);
		if (!row) throw new Error(`no ${provider} row serves ${access}`);
		return row.id;
	}

	function blockedPairs(auth: AuthStorage, provider: string): Array<{ credentialId: number; providerKey: string }> {
		const ids = auth.listStoredCredentials(provider).map(entry => entry.id);
		return auth
			.listCredentialBlocks(ids)
			.map(block => ({ credentialId: block.credentialId, providerKey: block.providerKey }));
	}

	test("a 401 on a borrowed Codex row rotates the session to the sibling Codex account", async () => {
		if (!storage || !store) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", CODEX_ACCESS);

		const first = await servedBearer(storage);
		expect(CODEX_ACCESS).toContain(first);
		const deadId = servedRowId(storage, "openai-codex", first);

		expect(await storage.rotateSessionCredential("chatgpt-web", SESSION, { error: authError() })).toBe(true);

		// The dead account is blocked under the provider whose row actually served, which is the only
		// key credential selection consults for it.
		expect(blockedPairs(storage, "openai-codex")).toEqual([
			{ credentialId: deadId, providerKey: "openai-codex:oauth" },
		]);

		const second = await servedBearer(storage);
		expect(CODEX_ACCESS).toContain(second);
		expect(second).not.toBe(first);
		// Borrowing never copies the Codex grant into ChatGPT Web, before or after a rotation.
		expect(store.listAuthCredentials("chatgpt-web")).toHaveLength(0);
	});

	test("a 401 with no sibling Codex account reports that nothing else can serve", async () => {
		if (!storage) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", [SOLO_CODEX_ACCESS]);

		expect(await servedBearer(storage)).toBe(SOLO_CODEX_ACCESS);
		expect(await storage.rotateSessionCredential("chatgpt-web", SESSION, { error: authError() })).toBe(false);
		// `false` here means "no sibling", not "nothing happened": the dead row is still blocked.
		expect(blockedPairs(storage, "openai-codex")).toEqual([
			{ credentialId: servedRowId(storage, "openai-codex", SOLO_CODEX_ACCESS), providerKey: "openai-codex:oauth" },
		]);
	});

	test("a usage limit on a borrowed Codex row blocks that Codex account and moves off it", async () => {
		if (!storage) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", CODEX_ACCESS);

		const served = await servedBearer(storage);
		const exhaustedId = servedRowId(storage, "openai-codex", served);

		const markedAt = Date.now();
		expect(await storage.markUsageLimitReached("chatgpt-web", SESSION, { retryAfterMs: HALF_HOUR_MS })).toEqual({
			switched: true,
		});

		const blocks = storage.listCredentialBlocks(storage.listStoredCredentials("openai-codex").map(row => row.id));
		expect(blocks.map(block => ({ credentialId: block.credentialId, providerKey: block.providerKey }))).toEqual([
			{ credentialId: exhaustedId, providerKey: "openai-codex:oauth" },
		]);
		expect(blocks[0]?.blockedUntilMs).toBeGreaterThanOrEqual(markedAt + HALF_HOUR_MS);

		const next = await servedBearer(storage);
		expect(CODEX_ACCESS).toContain(next);
		expect(next).not.toBe(served);
	});

	test("a dedicated ChatGPT Web credential rotates among its own rows and leaves Codex alone", async () => {
		if (!storage) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", CODEX_ACCESS);
		await seedOAuthAccounts(storage, "chatgpt-web", WEB_ACCESS);

		const first = await servedBearer(storage);
		expect(WEB_ACCESS).toContain(first);

		expect(await storage.rotateSessionCredential("chatgpt-web", SESSION, { error: authError() })).toBe(true);

		expect(blockedPairs(storage, "chatgpt-web")).toEqual([
			{ credentialId: servedRowId(storage, "chatgpt-web", first), providerKey: "chatgpt-web:oauth" },
		]);
		expect(blockedPairs(storage, "openai-codex")).toEqual([]);

		const second = await servedBearer(storage);
		expect(WEB_ACCESS).toContain(second);
		expect(second).not.toBe(first);
	});

	test("a usage limit on a dedicated ChatGPT Web credential blocks that credential, not Codex", async () => {
		if (!storage) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", CODEX_ACCESS);
		await seedOAuthAccounts(storage, "chatgpt-web", WEB_ACCESS);

		const served = await servedBearer(storage);
		expect(await storage.markUsageLimitReached("chatgpt-web", SESSION, { retryAfterMs: HALF_HOUR_MS })).toEqual({
			switched: true,
		});

		expect(blockedPairs(storage, "chatgpt-web")).toEqual([
			{ credentialId: servedRowId(storage, "chatgpt-web", served), providerKey: "chatgpt-web:oauth" },
		]);
		expect(blockedPairs(storage, "openai-codex")).toEqual([]);
	});

	test("a provider that is not ChatGPT Web never reaches the Codex rows", async () => {
		if (!storage) throw new Error("test setup failed");
		await seedOAuthAccounts(storage, "openai-codex", CODEX_ACCESS);

		expect(await storage.getApiKey("unrelated-provider", SESSION)).toBeUndefined();
		expect(await storage.rotateSessionCredential("unrelated-provider", SESSION, { error: authError() })).toBe(false);
		expect(
			await storage.markUsageLimitReached("unrelated-provider", SESSION, { retryAfterMs: HALF_HOUR_MS }),
		).toEqual({ switched: false });
		expect(blockedPairs(storage, "openai-codex")).toEqual([]);
	});
});
