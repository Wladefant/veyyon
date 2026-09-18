/**
 * The note about a dead login says WHOSE login died.
 *
 * THE DEFECT (live repro). The account manager showed `a previous login was signed out: oauth
 * refresh failed: … "error": "invalid_grant" … press a to sign in again` against a Google account
 * that was serving every request. The store held two accounts for that provider: one whose grant
 * had died and one that worked. The note is a PROVIDER-level note, so it renders beside the rows
 * that still work, and with no account named it reads as a statement about the row next to it. The
 * report was "it shows as not refreshed even when it works", which is exactly what an unattributed
 * note looks like from the outside.
 *
 * THE CLASS. Not "this string is wrong" but "a per-account fact is reported at provider scope with
 * nothing to bind it to the account it came from". The fix carries the identity with the cause, so
 * the suite pins the binding at both ends — the inventory must carry the account the dead row names,
 * and the rendered note must print it — and pins the case where there is no identity to carry,
 * because an API key names no account and inventing one would be a different lie.
 *
 * Driven through a REAL `SqliteAuthCredentialStore`: the behaviour under test is what the store
 * hides from the ordinary list, so a fake returning rows would prove nothing.
 *
 * WHAT IT DOES NOT CATCH. Whether the note is placed beside the right row on screen; it asserts the
 * text names the account, not the geometry of the pane. It also does not judge the identity the
 * provider supplies — if a provider writes the wrong email onto the credential, this reports that
 * email faithfully.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { providerDisabledNote } from "@veyyon/coding-agent/modes/terminal/components/account/account-manager-rows";
import { buildAccountInventory } from "@veyyon/coding-agent/session/account-inventory";

const PROVIDER = "unit-dead-login-identity";
const REFRESH_FAILURE = 'oauth refresh failed: OAuthError: token refresh failed: {"error":"invalid_grant"}';
const DEAD = "dead.account@example.com";
const LIVE = "live.account@example.com";

describe("a dead login names the account it belonged to", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-dead-login-identity-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	/** Kill the account named by `email`, then sign a different one in — the reported shape. */
	async function killOneAndKeepAnother(storage: AuthStorage, activeStore: SqliteAuthCredentialStore): Promise<void> {
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-dead",
				refresh: "refresh-dead",
				expires: Date.now() + 3_600_000,
				email: DEAD,
			},
		]);
		const id = storage.listStoredCredentials(PROVIDER)[0]!.id;
		activeStore.deleteAuthCredential(id, REFRESH_FAILURE);
		await storage.reload();
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-live",
				refresh: "refresh-live",
				expires: Date.now() + 3_600_000,
				email: LIVE,
			},
		]);
	}

	test("carries the dead account beside the cause", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await killOneAndKeepAnother(authStorage, store);

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);

		expect(entry?.disabledCause).toBe(REFRESH_FAILURE);
		expect(entry?.disabledAccount).toBe(DEAD);
		// The surviving account is still a real row: this is one account lost, not the provider.
		expect(entry?.rows.map(row => row.email)).toEqual([LIVE]);
	});

	test("prints the dead account in the note, and not the surviving one", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await killOneAndKeepAnother(authStorage, store);

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);
		const note = providerDisabledNote(entry ?? { rows: [] });

		expect(note[0]).toContain(DEAD);
		expect(note[0]).not.toContain(LIVE);
		expect(note[0]).toContain("invalid_grant");
		// One account still answers every request, so the provider is not broken and the line
		// says so instead of demanding a login.
		expect(note[1]).toBe("1 other account still signed in; press a to sign this one back in");
	});

	test("keeps the unattributed wording when the dead credential names no account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "access-anon", refresh: "refresh-anon", expires: Date.now() + 3_600_000 },
		]);
		const id = authStorage.listStoredCredentials(PROVIDER)[0]!.id;
		store.deleteAuthCredential(id, REFRESH_FAILURE);
		await authStorage.reload();

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);
		const note = providerDisabledNote(entry ?? { rows: [] });

		expect(entry?.disabledAccount).toBeUndefined();
		// No identity to print, so the note says a login died without claiming which.
		expect(note[0]).toContain("the login for this provider was signed out");
		expect(note[0]).toContain("invalid_grant");
	});

	/**
	 * THE DEFECT (same report). Naming the account made the first line true and left the second one
	 * incoherent: `press a to sign in again` rendered beside an account serving every request, so
	 * one card said the provider works and that the user must act. The instruction belongs to a
	 * provider with nothing left to serve with.
	 */
	test("asks for a login only when no account is left serving the provider", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-dead",
				refresh: "refresh-dead",
				expires: Date.now() + 3_600_000,
				email: DEAD,
			},
		]);
		const id = authStorage.listStoredCredentials(PROVIDER)[0]!.id;
		store.deleteAuthCredential(id, REFRESH_FAILURE);
		await authStorage.reload();

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);
		const note = providerDisabledNote(entry ?? { rows: [] });

		expect(entry?.rows).toEqual([]);
		expect(note[0]).toContain(DEAD);
		expect(note[1]).toBe("press a to sign in again");
	});

	test("counts only the accounts that are actually serving", async () => {
		// A row whose own probe failed is not something the provider can serve with, so it does not
		// license the "still signed in" wording that tells the user nothing is wrong.
		const note = providerDisabledNote({
			disabledCause: REFRESH_FAILURE,
			disabledAccount: DEAD,
			rows: [
				{ id: 1, provider: PROVIDER, type: "oauth", email: LIVE, health: "failed" },
				{ id: 2, provider: PROVIDER, type: "oauth", email: "third@example.com" },
			] as never,
		});

		expect(note[1]).toBe("1 other account still signed in; press a to sign this one back in");
	});

	test("says nothing at all when no refresh failure tore a login down", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-live",
				refresh: "refresh-live",
				expires: Date.now() + 3_600_000,
				email: LIVE,
			},
		]);

		const entry = buildAccountInventory(authStorage).providers.find(group => group.provider === PROVIDER);

		expect(entry?.disabledCause).toBeUndefined();
		expect(entry?.disabledAccount).toBeUndefined();
		expect(providerDisabledNote(entry ?? { rows: [] })).toEqual([]);
	});
});
