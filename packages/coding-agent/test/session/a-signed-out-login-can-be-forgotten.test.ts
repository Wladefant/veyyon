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
 * The host callback is driven through the real `SelectorController`: the card it mounts is pressed,
 * and the store, the rebuilt card and the status line are read back, on both of its branches.
 *
 * WHAT IT DOES NOT CATCH. The account card opened from `/account status` rather than `/login`
 * shares this controller method, so a second entry point with its own callback would go unseen.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isRefreshFailureDisableCause } from "@veyyon/ai/auth-credential-rows";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
} from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { providerDisabledNote } from "@veyyon/coding-agent/modes/terminal/components/account/account-manager-rows";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
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

describe("the host forgets through the controller", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-forget-host-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** A provider with one live account and one login torn down by a failed refresh, on the real card. */
	async function openCard() {
		if (!store) throw new Error("test setup failed");
		store.upsertAuthCredentialForProvider(PROVIDER, oauth(LIVE, "live"));
		const rows = store.upsertAuthCredentialForProvider(PROVIDER, oauth(DEAD, "dead"));
		const dead = rows.find(row => row.credential.type === "oauth" && row.credential.email === DEAD)!.id;
		store.deleteAuthCredential(dead, REFRESH_FAILURE);
		const storage = new AuthStorage(store);
		await storage.reload();
		// Opening the card probes every credential over the network; the contract here is the store.
		vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);

		const statuses: string[] = [];
		const warnings: string[] = [];
		let mounted: AccountManagerComponent | undefined;
		const ctx = {
			editorContainer: { children: [], clear: () => {}, addChild: () => {} },
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					mounted = component as AccountManagerComponent;
					return { hide: vi.fn() };
				}),
			},
			session: {
				sessionId: "session-forget-test",
				settings: Settings.isolated(),
				modelRegistry: { authStorage: storage, refresh: vi.fn(async () => undefined) },
				fetchUsageReports: async () => [],
			},
			showStatus: (message: string) => statuses.push(message),
			showWarning: (message: string) => warnings.push(message),
			showError: vi.fn(),
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).showAccountManager(PROVIDER);
		if (!(mounted instanceof AccountManagerComponent)) throw new Error("the controller mounted no account card");
		const card = mounted;
		const offersChip = (): boolean =>
			card
				.render(140)
				.map(line => stripVTControlCharacters(line))
				.some(line => line.includes(CHIP));
		return { card, storage, statuses, warnings, offersChip };
	}

	test("forgets the signed-out login, rebuilds the card without the note, and reports it", async () => {
		const { card, storage, statuses, warnings, offersChip } = await openCard();
		expect(offersChip()).toBe(true);

		card.handleInput("f");

		expect(storage.listProvidersWithFailedRefresh().map(entry => entry.provider)).not.toContain(PROVIDER);
		expect(offersChip()).toBe(false);
		expect(statuses.some(line => line.includes("forgot the signed-out login"))).toBe(true);
		expect(warnings).toEqual([]);
	});

	test("warns instead of reporting success when the store has nothing left to forget", async () => {
		const { card, storage, statuses, warnings, offersChip } = await openCard();
		// Another process dismissed it after the card painted: the note is still on screen.
		storage.forgetSignedOutLogins(PROVIDER);
		expect(offersChip()).toBe(true);

		card.handleInput("f");

		expect(warnings.some(line => line.includes("no signed-out login to forget"))).toBe(true);
		expect(statuses.some(line => line.includes("forgot the signed-out login"))).toBe(false);
		expect(offersChip()).toBe(false);
	});
});
