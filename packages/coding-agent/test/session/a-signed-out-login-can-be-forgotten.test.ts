/**
 * A signed-out login note can be dismissed without signing that login back in.
 *
 * THE DEFECT. A login torn down by a failed refresh is reported on the account card and in
 * `/account status` until a new login replaces it, and a new login replaces it only when it carries
 * the same identity. A login that is never coming back (the address moved to another account, the
 * grant was revoked on purpose) therefore kept its provider reported as signed out on every launch,
 * beside the account that was serving every request, with no key that cleared it.
 *
 * THE CLASS. A notice whose only remedy is an action the user may not want or be able to take. The
 * suite pins the remedy at every layer it crosses: the store dismisses exactly the refresh-failure
 * rows of one provider and nothing else, the inventory stops reporting them, a dismissed row can no
 * longer be revived by a refresh, the note names the key, and the card offers the key and fires it
 * under one predicate.
 *
 * Driven through a REAL `SqliteAuthCredentialStore`: what is under test is how the store's disabled
 * rows read back, so a fake returning rows would prove nothing.
 *
 * WHAT IT DOES NOT CATCH. The host callback in `SelectorController` is not constructed here; it calls
 * `forgetSignedOutLogins` and rebuilds the inventory, and a wiring mistake there would pass.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isRefreshFailureDisableCause } from "@veyyon/ai/auth-credential-rows";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
} from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { providerDisabledNote } from "@veyyon/coding-agent/modes/terminal/components/account/account-manager-rows";
import {
	type AccountInventory,
	type AccountRow,
	buildAccountInventory,
} from "@veyyon/coding-agent/session/account-inventory";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

const PROVIDER = "unit-forget-signed-out";
const OTHER_PROVIDER = "unit-forget-signed-out-other";
const REFRESH_FAILURE = 'oauth refresh failed: OAuthError: token refresh failed: {"error":"invalid_grant"}';
const DEAD = "dead.account@example.com";
const LIVE = "live.account@example.com";
const CHIP = "f forget signed-out";

beforeAll(async () => {
	await initTheme();
});

function oauth(email: string, token: string) {
	return {
		type: "oauth" as const,
		access: `access-${token}`,
		refresh: `refresh-${token}`,
		expires: Date.now() + 3_600_000,
		email,
	};
}

describe("forgetting a signed-out login", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-forget-signed-out-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Disable a fresh row for `email` under `provider` with `cause`, returning its id. */
	function disabledRow(active: SqliteAuthCredentialStore, provider: string, email: string, cause: string): number {
		const rows = active.upsertAuthCredentialForProvider(provider, oauth(email, `${provider}-${email}`));
		const id = rows.find(row => row.credential.type === "oauth" && row.credential.email === email)!.id;
		active.deleteAuthCredential(id, cause);
		return id;
	}

	test("dismisses only the refresh failures of the provider asked about", async () => {
		if (!store) throw new Error("test setup failed");
		const loggedOut = disabledRow(store, PROVIDER, "logged.out@example.com", "deleted by user");
		const dead = disabledRow(store, PROVIDER, DEAD, REFRESH_FAILURE);
		disabledRow(store, OTHER_PROVIDER, DEAD, REFRESH_FAILURE);
		store.upsertAuthCredentialForProvider(PROVIDER, oauth(LIVE, "live"));
		const storage = new AuthStorage(store);
		await storage.reload();
		expect(buildAccountInventory(storage).providers.find(entry => entry.provider === PROVIDER)?.disabledCause).toBe(
			REFRESH_FAILURE,
		);

		expect(storage.forgetSignedOutLogins(PROVIDER)).toBe(1);

		const inventory = buildAccountInventory(storage);
		const forgotten = inventory.providers.find(entry => entry.provider === PROVIDER);
		expect(forgotten?.disabledCause).toBeUndefined();
		expect(forgotten?.disabledAccount).toBeUndefined();
		expect(forgotten?.rows.map(row => row.email)).toEqual([LIVE]);
		expect(inventory.providers.find(entry => entry.provider === OTHER_PROVIDER)?.disabledCause).toBe(REFRESH_FAILURE);
		expect(storage.listProvidersWithFailedRefresh().map(entry => entry.provider)).toEqual([OTHER_PROVIDER]);

		const causes = new Map(store.listDisabledAuthCredentials(PROVIDER).map(row => [row.id, row.disabledCause]));
		// The dead row stays disabled and on disk, under a cause a successful refresh may not heal.
		expect(causes.has(dead)).toBe(true);
		expect(isRefreshFailureDisableCause(causes.get(dead))).toBe(false);
		// A logout is not a refresh failure and keeps the cause it was given.
		expect(causes.get(loggedOut)).toBe("deleted by user");
		// Nothing left to dismiss.
		expect(storage.forgetSignedOutLogins(PROVIDER)).toBe(0);
	});

	test("clears a provider whose only login died", () => {
		if (!store) throw new Error("test setup failed");
		disabledRow(store, PROVIDER, DEAD, REFRESH_FAILURE);
		const storage = new AuthStorage(store);
		expect(buildAccountInventory(storage).providers.map(entry => entry.provider)).toContain(PROVIDER);

		storage.forgetSignedOutLogins(PROVIDER);

		expect(buildAccountInventory(storage).providers.map(entry => entry.provider)).not.toContain(PROVIDER);
	});
});

describe("the signed-out note", () => {
	test("names the forget key whether or not another account still serves", () => {
		const alone = providerDisabledNote({ disabledCause: REFRESH_FAILURE, disabledAccount: DEAD, rows: [] });
		const beside = providerDisabledNote({
			disabledCause: REFRESH_FAILURE,
			disabledAccount: DEAD,
			rows: [{ provider: PROVIDER, credentialId: 1, type: "oauth", email: LIVE }] as never,
		});

		expect(alone[1]).toBe("press a to sign in again, or f to forget it");
		expect(beside[1]).toBe("1 other account still signed in; press a to sign this one back in, or f to forget it");
	});
});

describe("the forget control on the account card", () => {
	function account(credentialId: number): AccountRow {
		return {
			provider: PROVIDER,
			providerLabel: "Unit",
			credentialId,
			type: "oauth",
			origin: { kind: "oauth" },
			usage: [],
			activeForSession: false,
			activeIsPrediction: false,
			selectedForProvider: false,
			email: LIVE,
		};
	}

	function harness(disabledCause: string | undefined, rows: AccountRow[]) {
		const forgotten: string[] = [];
		const callbacks: AccountManagerCallbacks = {
			onUseAccount: () => {},
			onRename: () => {},
			onRefresh: () => {},
			onLogout: () => {},
			onShowUsage: () => {},
			onAddAccount: () => {},
			onClearRateLimitBlock: () => {},
			onForgetSignedOut: provider => forgotten.push(provider),
			onCancel: () => {},
		};
		const inventory: AccountInventory = {
			providers: [
				{
					provider: PROVIDER,
					label: "Unit",
					rows,
					...(disabledCause ? { disabledCause, disabledAccount: DEAD } : {}),
				},
			],
			totalAccounts: rows.length,
			unhealthyCount: 0,
		};
		const component = new AccountManagerComponent(inventory, callbacks, {
			initialProviderId: PROVIDER,
			terminalHeight: 40,
		});
		const offersChip = (): boolean =>
			component
				.render(140)
				.map(line => stripVTControlCharacters(line))
				.some(line => line.includes(CHIP));
		return { component, forgotten, offersChip };
	}

	// Every combination of note and cursor position: the chip and the key must agree in all of them.
	for (const [label, cause, rows, cursorSteps, expected] of [
		["a note beside a serving account", REFRESH_FAILURE, [account(1)], 0, true],
		["a note on the add entry", REFRESH_FAILURE, [account(1)], 1, true],
		["a note with no account left", REFRESH_FAILURE, [], 0, true],
		["no note beside a serving account", undefined, [account(1)], 0, false],
		["no note and no account", undefined, [], 0, false],
	] as const) {
		test(`offers and fires the key together: ${label}`, () => {
			const { component, forgotten, offersChip } = harness(cause, [...rows]);
			component.render(140);
			for (let step = 0; step < cursorSteps; step += 1) component.handleInput("\x1b[B");

			const chip = offersChip();
			component.handleInput("f");

			expect(chip).toBe(expected);
			expect(forgotten).toEqual(expected ? [PROVIDER] : []);
		});
	}
});
