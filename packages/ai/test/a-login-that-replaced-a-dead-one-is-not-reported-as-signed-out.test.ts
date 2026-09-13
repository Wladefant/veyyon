/**
 * A provider that was signed in again still advertised the old refresh failure.
 *
 * THE DEFECT (live repro). The account manager showed `a previous login was
 * signed out: oauth refresh failed: … "error": "invalid_grant" … press a to
 * sign in again` for a provider whose requests were being served. The real
 * store held exactly the shape below: one disabled row from the dead token and
 * one active row, stored later, that works. `disabledCredentialCause` ranked
 * rows NEWEST FIRST among disabled rows only, so signing in again — which
 * writes an ACTIVE row and leaves the dead one untouched — could never
 * supersede the failure. It stayed newest among its own kind forever.
 *
 * THE CLASS. Not "this banner is wrong" but "a recorded failure is reported
 * without asking whether it was since resolved". Both readers of the disabled
 * rows have it: the per-provider cause and the enumerable list that the startup
 * path uses to warn about a provider with no visible account at all. A fix to
 * one and not the other leaves the same lie on the other surface, so the suite
 * pins both, and pins the two directions of the ordering that decide it.
 *
 * WHAT IT DOES NOT CATCH. Supersession is judged by row id, which is monotonic
 * in the SQLite store this suite drives. A store whose ids are not monotonic
 * would order these rows differently and no assertion here would notice; that
 * is the same assumption `listDisabledAuthCredentials` already makes when it
 * calls its own first row "the disable that is actually current". It also does
 * not judge whether the active row belongs to the same ACCOUNT as the dead one:
 * a working second account supersedes an older death, which is the intended
 * reading of "the provider serves requests", not an oversight.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";

const REFRESH_FAILURE =
	'oauth refresh failed: OAuthError: Antigravity token refresh failed: {"error":"invalid_grant","error_description":"Bad Request"}';

function oauth(access: string): AuthCredential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 3_600_000 };
}

let dir = "";
let store: SqliteAuthCredentialStore;
let storage: AuthStorage;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-auth-supersede-"));
	store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
	storage = new AuthStorage(store);
});

afterEach(async () => {
	store.close();
	await fs.rm(dir, { recursive: true, force: true });
});

/** Store a credential and return its row id. */
function addCredential(provider: string, access: string): number {
	const [row] = store.replaceAuthCredentialsForProvider(provider, [
		...store.listAuthCredentials(provider).map(entry => entry.credential),
		oauth(access),
	]);
	const stored = store.listAuthCredentials(provider);
	return stored[stored.length - 1]?.id ?? row?.id ?? -1;
}

describe("a login that replaced a dead one is not reported as signed out", () => {
	test("a provider signed in again after a failed refresh reports no cause", () => {
		const dead = addCredential("google-antigravity", "dead");
		store.deleteAuthCredential(dead, REFRESH_FAILURE);
		addCredential("google-antigravity", "working");

		expect(storage.disabledCredentialCause("google-antigravity")).toBeUndefined();
		expect(storage.listProvidersWithFailedRefresh()).toEqual([]);
	});

	test("a provider whose only login died still reports the cause", () => {
		const dead = addCredential("google-antigravity", "dead");
		store.deleteAuthCredential(dead, REFRESH_FAILURE);

		expect(storage.disabledCredentialCause("google-antigravity")).toBe(REFRESH_FAILURE);
		expect(storage.listProvidersWithFailedRefresh()).toEqual([
			{ provider: "google-antigravity", cause: REFRESH_FAILURE },
		]);
	});

	test("an older account that still works does not bury a newer death", () => {
		addCredential("google-antigravity", "older-working");
		const dead = addCredential("google-antigravity", "newer-dead");
		store.deleteAuthCredential(dead, REFRESH_FAILURE);

		// The surviving row predates the failure, so nothing resolved it: that
		// account died after this one was stored and the user has not signed in
		// since. Reporting it is the whole point of the cause.
		expect(storage.disabledCredentialCause("google-antigravity")).toBe(REFRESH_FAILURE);
		expect(storage.listProvidersWithFailedRefresh()).toEqual([
			{ provider: "google-antigravity", cause: REFRESH_FAILURE },
		]);
	});

	test("one provider's resolution does not silence another's live failure", () => {
		const resolved = addCredential("google-antigravity", "dead");
		store.deleteAuthCredential(resolved, REFRESH_FAILURE);
		addCredential("google-antigravity", "working");

		const stillDead = addCredential("kimi-code", "dead");
		store.deleteAuthCredential(stillDead, REFRESH_FAILURE);

		expect(storage.listProvidersWithFailedRefresh()).toEqual([{ provider: "kimi-code", cause: REFRESH_FAILURE }]);
	});

	test("a login the user signed out of is never reported at all", () => {
		const dead = addCredential("google-antigravity", "dead");
		store.deleteAuthCredential(dead, "logged out");

		// A disable the user performed is not a refresh failure, so it stays out of
		// both readers whether or not anything superseded it.
		expect(storage.disabledCredentialCause("google-antigravity")).toBeUndefined();
		expect(storage.listProvidersWithFailedRefresh()).toEqual([]);
	});
});
