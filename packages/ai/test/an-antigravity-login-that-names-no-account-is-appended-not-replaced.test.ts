/**
 * Every Antigravity login carries the same GCP project (`aicode-consumers`), so the project cannot be
 * the identity a stored row is keyed on. When a login names neither an email nor an account id (the
 * email lookup can be refused, see `registry/oauth/google-oauth-shared.ts`) the credential has NO
 * identity key, and the store appends it as a row of its own instead of replacing a sibling.
 *
 * DEFECT (veyyon#102): the project was the last-resort key, so a second email-less account replaced
 * the first one's row and the first account was silently destroyed.
 *
 * ACCEPTED COST, pinned here so it cannot flip back unnoticed: the same email-less account logging in
 * AGAIN also appends a row (a duplicate) rather than updating in place, and a user-chosen name is
 * keyed on the row id, so it does not follow the account to the new row. With no recoverable identity,
 * a duplicate is the only outcome that never destroys a real account.
 *
 * CLASS: identity-less logins crossed with a provider that shares its project and one that does not.
 * GAP: this drives the real SQLite store, not the OAuth login flow that calls it.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveAccountNameIdentity } from "@veyyon/ai/auth-credential-rows";
import type { AuthCredential } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";

const PROJECT = "aicode-consumers";

function login(token: string, extra: { email?: string; projectId?: string } = {}): AuthCredential {
	return {
		type: "oauth",
		access: `access-${token}`,
		refresh: `refresh-${token}`,
		expires: 1_800_000_000_000,
		projectId: extra.projectId ?? PROJECT,
		...(extra.email ? { email: extra.email } : {}),
	};
}

describe("the store's rows for an Antigravity login that names no account", () => {
	let store: SqliteAuthCredentialStore;
	beforeEach(() => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
	});
	afterEach(() => store.close());

	it("keeps two different email-less accounts as two rows", () => {
		store.upsertAuthCredentialForProvider("google-antigravity", login("first"));
		const rows = store.upsertAuthCredentialForProvider("google-antigravity", login("second"));

		expect(rows.map(row => (row.credential.type === "oauth" ? row.credential.refresh : "")).sort()).toEqual([
			"refresh-first",
			"refresh-second",
		]);
	});

	it("appends a duplicate when the same email-less account logs in again, with no name carried over", () => {
		const first = store.upsertAuthCredentialForProvider("google-antigravity", login("same"));
		const rows = store.upsertAuthCredentialForProvider("google-antigravity", login("same"));

		expect(first).toHaveLength(1);
		expect(rows).toHaveLength(2);
		// The name is keyed on the row id for a row with no identity, so each row names itself.
		const nameKeys = rows.map(row => resolveAccountNameIdentity("google-antigravity", row));
		expect(new Set(nameKeys).size).toBe(2);
		for (const key of nameKeys) expect(key).toMatch(/^google-antigravity\|id:\d+$/);
	});

	it("still replaces in place when the login names its email", () => {
		store.upsertAuthCredentialForProvider("google-antigravity", login("old", { email: "first@example.test" }));
		const rows = store.upsertAuthCredentialForProvider(
			"google-antigravity",
			login("new", { email: "first@example.test" }),
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type === "oauth" ? rows[0].credential.refresh : "").toBe("refresh-new");
	});

	it("keeps the project as the identity for a provider whose accounts do not share one", () => {
		store.upsertAuthCredentialForProvider("google-gemini-cli", login("old", { projectId: "project-a" }));
		const rows = store.upsertAuthCredentialForProvider("google-gemini-cli", login("new", { projectId: "project-a" }));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential.type === "oauth" ? rows[0].credential.refresh : "").toBe("refresh-new");
	});
});
