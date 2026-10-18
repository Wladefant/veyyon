/**
 * A Google account whose email changed is still one login.
 *
 * THE DEFECT. Google OAuth credentials were identified by email alone. After an account's address
 * changed, a login under the new address stored a second row beside the login under the old one,
 * and when the old row's grant died the account card reported it as a separate account signed out,
 * on every launch, beside the login that was serving every request. Nothing the store held linked
 * the two rows.
 *
 * THE FIX. The Google login stores the account's userinfo `id` as `accountId`, which a Google account
 * keeps across an email change. Google rows stay keyed by email, so a stored row and the name kept
 * against its key do not move, and a shared account id is checked beside the key: it makes a new
 * login take over the old row, and makes an active row purge a disabled row of the same account.
 *
 * THE CLASS. A login under a new email that carries the account id of a stored login is the same
 * account, except where the id is not personal: a Codex `accountId` is a workspace a whole team
 * shares and an Anthropic account uuid is shared by every organization of one login, so merging on
 * it would merge different people. The sweep below enumerates every OAuth provider and pins, by exact
 * equality, the providers for which a shared account id does NOT make two logins one. A provider
 * that stops merging (Google keyed by email with the id check dropped) or starts merging a shared id
 * turns it red.
 *
 * WHAT IT DOES NOT CATCH. A row stored before the login recorded `accountId` carries none, so it is
 * never linked; the signed-out note it leaves is cleared by forgetting it (see the coding-agent suite
 * `a-signed-out-login-can-be-forgotten`). Whether Google returns the same id after an email change is
 * Google's contract and is not exercised here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isRefreshFailureDisableCause,
	matchesReplacementCredential,
	resolveCredentialIdentityKey,
} from "@veyyon/ai/auth-credential-rows";
import { AuthStorage, type OAuthCredential } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { getOAuthProviders } from "@veyyon/ai/registry/oauth";
import { GoogleOAuthFlow } from "@veyyon/ai/registry/oauth/google-oauth-shared";
import type { OAuthController } from "@veyyon/ai/registry/oauth/types";

const REFRESH_FAILURE = 'oauth refresh failed: OAuthError: token refresh failed: {"error":"invalid_grant"}';
const OLD_EMAIL = "old.address@example.com";
const NEW_EMAIL = "new.address@example.com";
const GOOGLE_ID = "104729000000000000001";

function oauth(email: string, accountId: string | undefined, token: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${token}`,
		refresh: `refresh-${token}`,
		expires: Date.now() + 3_600_000,
		email,
		...(accountId ? { accountId } : {}),
	};
}

async function latestReportableCause(storage: AuthStorage, provider: string): Promise<string | undefined> {
	const [latest] = await storage.credentials.listReportableDisabled(provider);
	if (!latest?.cause || !isRefreshFailureDisableCause(latest.cause)) return undefined;
	return latest.cause;
}

async function latestReportableAccount(storage: AuthStorage, provider: string): Promise<string | undefined> {
	const [latest] = await storage.credentials.listReportableDisabled(provider);
	if (!latest?.cause || !isRefreshFailureDisableCause(latest.cause) || latest.type !== "oauth") return undefined;
	return latest.email || latest.accountId || undefined;
}

async function latestReportableFailures(storage: AuthStorage): Promise<Array<{ provider: string; cause: string }>> {
	const seen = new Set<string>();
	const failures: Array<{ provider: string; cause: string }> = [];
	for (const row of await storage.credentials.listReportableDisabled()) {
		if (seen.has(row.provider)) continue;
		seen.add(row.provider);
		if (row.cause && isRefreshFailureDisableCause(row.cause)) {
			failures.push({ provider: row.provider, cause: row.cause });
		}
	}
	return failures;
}

describe("which providers treat a shared account id as one login", () => {
	test("every provider but the two whose account id is shared between people", () => {
		const providers = new Set(getOAuthProviders().map(provider => provider.storeCredentialsAs ?? provider.id));
		expect(providers.has("google-antigravity") && providers.has("google-gemini-cli")).toBe(true);
		const separate: string[] = [];
		for (const provider of providers) {
			const existing = oauth(OLD_EMAIL, GOOGLE_ID, "old");
			const incoming = oauth(NEW_EMAIL, GOOGLE_ID, "new");
			const existingKey = resolveCredentialIdentityKey(provider, existing);
			if (!matchesReplacementCredential(provider, existing, existingKey, incoming)) separate.push(provider);
		}
		expect(separate.sort()).toEqual(["anthropic", "openai-codex"]);
	});

	test("keeps Google identity keyed by email, so a stored row and its name keep their key", () => {
		for (const provider of ["google-antigravity", "google-gemini-cli"]) {
			expect(resolveCredentialIdentityKey(provider, oauth(NEW_EMAIL, GOOGLE_ID, "new"))).toBe(`email:${NEW_EMAIL}`);
		}
	});

	test("does not merge two Google accounts with different ids", () => {
		const existing = oauth(OLD_EMAIL, GOOGLE_ID, "old");
		const incoming = oauth(NEW_EMAIL, "104729000000000000002", "new");
		const key = resolveCredentialIdentityKey("google-antigravity", existing);
		expect(matchesReplacementCredential("google-antigravity", existing, key, incoming)).toBe(false);
	});
});

describe("the credential store", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-google-email-change-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function signedOutOldAddress(provider: string, accountId: string | undefined): SqliteAuthCredentialStore {
		if (!store) throw new Error("test setup failed");
		const [row] = store.upsertAuthCredentialForProvider(provider, oauth(OLD_EMAIL, accountId, "old"));
		store.deleteAuthCredential(row!.id, REFRESH_FAILURE);
		return store;
	}

	test("a login under the new address purges the signed-out login under the old one", async () => {
		const active = signedOutOldAddress("google-antigravity", GOOGLE_ID);
		expect(await latestReportableAccount(new AuthStorage(active), "google-antigravity")).toBe(OLD_EMAIL);

		active.upsertAuthCredentialForProvider("google-antigravity", oauth(NEW_EMAIL, GOOGLE_ID, "new"));

		const storage = new AuthStorage(active);
		expect(active.listDisabledAuthCredentials("google-antigravity")).toEqual([]);
		expect(await latestReportableCause(storage, "google-antigravity")).toBeUndefined();
		expect(await latestReportableFailures(storage)).toEqual([]);
	});

	test("a login under the new address takes over the old address's active row", () => {
		if (!store) throw new Error("test setup failed");
		const [first] = store.upsertAuthCredentialForProvider("google-gemini-cli", oauth(OLD_EMAIL, GOOGLE_ID, "old"));
		const rows = store.upsertAuthCredentialForProvider("google-gemini-cli", oauth(NEW_EMAIL, GOOGLE_ID, "new"));

		expect(rows.map(row => [row.id, row.credential.type === "oauth" ? row.credential.email : ""])).toEqual([
			[first!.id, NEW_EMAIL],
		]);
	});

	test("keeps the signed-out login when the rows share no account id", async () => {
		const active = signedOutOldAddress("google-antigravity", undefined);
		active.upsertAuthCredentialForProvider("google-antigravity", oauth(NEW_EMAIL, GOOGLE_ID, "new"));

		expect(await latestReportableAccount(new AuthStorage(active), "google-antigravity")).toBe(OLD_EMAIL);
	});

	test("keeps two Codex logins of one shared workspace apart", async () => {
		const active = signedOutOldAddress("openai-codex", "workspace-1");
		active.upsertAuthCredentialForProvider("openai-codex", oauth(NEW_EMAIL, "workspace-1", "new"));

		expect(await latestReportableAccount(new AuthStorage(active), "openai-codex")).toBe(OLD_EMAIL);
	});
});

describe("the Google login", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("stores the account's userinfo id as its account id", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | { url: string }) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("https://oauth.test.invalid/token")) {
				return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
			}
			if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
				return Response.json({ id: GOOGLE_ID, email: NEW_EMAIL, verified_email: true });
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch);
		const flow = new GoogleOAuthFlow({ onProgress: () => {} } as unknown as OAuthController, {
			clientId: "client",
			clientSecret: "secret",
			authUrl: "https://oauth.test.invalid/auth",
			tokenUrl: "https://oauth.test.invalid/token",
			scopes: ["email"],
			callbackPort: 0,
			callbackPath: "/callback",
			discoverProject: async () => "project-1",
		});

		const credentials = await flow.exchangeToken("code", "state", "https://localhost/callback");

		expect(credentials.email).toBe(NEW_EMAIL);
		expect(credentials.accountId).toBe(GOOGLE_ID);
	});
});
