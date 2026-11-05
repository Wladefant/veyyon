/**
 * WHY: a login stored under another provider used to reopen the account card on its own login id.
 * That id had no account entry, so the card landed on another provider instead.
 *
 * THE CLASS: every login whose credential lands under another provider. The card sweep enumerates
 * them from `getOAuthProviders()` at run time, so each new alternate login gets the same coverage.
 * The OpenCode Go cases below separately prove its sole API-key login uses the provider ID.
 *
 * WHAT IT DOES NOT CATCH: which alternate login is the provider default. The card contract checks
 * every alternate entry, while the OpenCode Go cases cover the primary API-key path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { getLoginCredential, getOAuthProviders } from "@veyyon/ai/oauth";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
} from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/login-dialog";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { formatProviderName } from "@veyyon/coding-agent/session/account-format";
import type { AccountInventory, AccountRow } from "@veyyon/coding-agent/session/account-inventory";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { getAgentDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const WIDTH = 200;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";

/** Every login that files its credential under another provider's id, in registry order. */
const ALTERNATES = getOAuthProviders().filter(
	login => login.storeCredentialsAs !== undefined && login.storeCredentialsAs !== login.id,
);

let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	store = await SqliteAuthCredentialStore.open(path.join(getAgentDir(), "second-login.db"));
	authStorage = new AuthStorage(store);
});

afterAll(() => {
	store?.close();
});

function account(provider: string, credentialId: number, name: string): AccountRow {
	return {
		provider,
		providerLabel: formatProviderName(provider),
		credentialId,
		type: "api_key",
		usage: [],
		activeForSession: false,
		activeIsPrediction: false,
		selectedForProvider: false,
		name,
	};
}

/** The account card on `provider`, recording every login it starts as `[provider, loginId]`. */
function card(provider: string, rows: AccountRow[] = []) {
	const added: Array<[string, string | undefined]> = [];
	const used: number[] = [];
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: row => used.push(row.credentialId),
		onRename: () => {},
		onRefresh: () => {},
		onLogout: () => {},
		onShowUsage: () => {},
		onAddAccount: (target, loginId) => added.push([target, loginId]),
		onClearRateLimitBlock: () => {},
		onForgetSignedOut: () => {},
		onCancel: () => {},
	};
	const inventory: AccountInventory = {
		providers: rows.length > 0 ? [{ provider, label: formatProviderName(provider), rows }] : [],
		totalAccounts: rows.length,
		unhealthyCount: 0,
	};
	const component = new AccountManagerComponent(inventory, callbacks, {
		terminalHeight: 40,
		initialProviderId: provider,
	});
	const frame = (): string[] => component.render(WIDTH).map(line => stripVTControlCharacters(line));
	/** The body pane's cells, trimmed: the sidebar draws a cursor too, so it is cut away first. */
	const body = (): string[] =>
		frame()
			.map(line => {
				const cells = line.split("│");
				return cells.length >= 4 ? (cells[2] ?? "").trim() : "";
			})
			.filter(cell => cell.length > 0);
	const cursorLine = (): string => {
		const lines = body().filter(cell => cell.startsWith("›"));
		if (lines.length !== 1) throw new Error(`expected one body cursor, found ${lines.length}`);
		return lines[0] ?? "";
	};
	/** Click where `needle` is painted in the current frame, as a terminal reports a left press. */
	const clickOn = (needle: string): void => {
		const lines = frame();
		const hits = lines.filter(line => line.includes(needle));
		if (hits.length !== 1)
			throw new Error(`expected one line containing ${JSON.stringify(needle)}, got ${hits.length}`);
		const row = lines.indexOf(hits[0] ?? "");
		const col = (hits[0] ?? "").indexOf(needle);
		component.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
	};
	return { component, added, used, frame, body, cursorLine, clickOn };
}

describe("the account card offers every login a provider can be added with", () => {
	test("the sweep reaches the alternate logins this product registers", () => {
		expect(ALTERNATES.map(login => login.id)).toEqual(
			expect.arrayContaining(["openai-codex-device", "nous-research-api-key"]),
		);
	});

	for (const login of ALTERNATES) {
		const base = login.storeCredentialsAs ?? login.id;
		const siblings = ALTERNATES.filter(other => other.storeCredentialsAs === base);
		const position = siblings.indexOf(login) + 1;
		const method = login.loginMethod ?? "";
		const entry = `+ add with ${method}`;

		test(`${login.id}: labelled by its mechanism, not by the provider the card already names`, () => {
			expect(method.length).toBeGreaterThan(0);
			expect(method.toLowerCase()).not.toContain(formatProviderName(base).toLowerCase());
		});

		test(`${login.id}: listed after ${base}'s own login, and enter starts it`, () => {
			const view = card(base);
			const body = view.body();
			const own = body.indexOf(`› + add ${formatProviderName(base)} account`);
			expect(own).toBeGreaterThanOrEqual(0);
			expect(body.indexOf(entry)).toBeGreaterThan(own);

			for (let step = 0; step < position; step++) view.component.handleInput(DOWN);
			expect(view.cursorLine()).toBe(`› ${entry}`);
			expect(view.frame().join("\n")).toContain(`enter add with ${method}`);

			view.component.handleInput(ENTER);
			expect(view.added).toEqual([[base, login.id]]);
		});

		test(`${login.id}: a click on its entry starts it`, () => {
			const view = card(base);
			view.clickOn(entry);
			expect(view.added).toEqual([[base, login.id]]);
		});
	}
});

describe("OpenCode Go signs in with its API key under its provider ID", () => {
	test("the provider's entry is an API-key login", () => {
		expect(getLoginCredential("opencode-go")).toBe("api-key");
		const view = card("opencode-go");
		expect(view.cursorLine()).toBe("› + add OpenCode Go account");

		view.component.handleInput(ENTER);

		expect(view.added).toEqual([["opencode-go", undefined]]);
	});
});

describe("an OpenCode Go API-key login lands under its provider ID", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		const storage = authStorage;
		if (!storage) throw new Error("no auth storage");
		// Health probing is an HTTP call per credential and has nothing to do with this contract.
		vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);
		// The API-key login needs no network request in this contract.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("this suite reaches no network"));
		await storage.set("opencode-go", []);
		// A populated provider that sorts ahead of OpenCode Go proves the card reopens on Go.
		await storage.set("anthropic", [{ type: "api_key", key: "sk-other-provider" }]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a provider login stores the key and opens its card", async () => {
		const h = controllerHarness();

		const running = h.controller.showLogin("opencode-go");
		const prompt = await keyPrompt(h);
		expect(prompt).toContain("Login to OpenCode Go ");
		expect(prompt).not.toContain("Api Key");
		await pasteKey(h, "sk-opencode-one");
		await running;

		expect(h.errors).toEqual([]);
		expect(h.statuses).toContain("Logging in to OpenCode Go…");
		expect(h.presented.join("\n")).toContain("Successfully logged in to OpenCode Go");
		expect(storedKeys(h.storage, "opencode-go").map(row => row.key)).toEqual(["sk-opencode-one"]);
		expect(h.cards).toHaveLength(1);
		expect(text(cardAt(h, 0))).toContain("OpenCode Go · 1 account");
	});

	test("a second provider login can name its saved key", async () => {
		const h = controllerHarness();
		await h.storage.set("opencode-go", [{ type: "api_key", key: "sk-opencode-one" }]);

		const running = h.controller.showLogin("opencode-go");
		await pasteKey(h, "sk-opencode-two");
		await until(() => text(h.dialog()).includes("Name this OpenCode Go account (optional)"), "the name prompt");
		h.dialog().pasteText("spare key");
		h.dialog().handleInput(ENTER);
		await running;

		const second = storedKeys(h.storage, "opencode-go").find(row => row.key === "sk-opencode-two");
		expect(second).toBeDefined();
		expect(h.storage.getAccountName("opencode-go", second?.id ?? -1)).toBe("spare key");
		expect(h.presented.join("\n")).toContain('Named "spare key"');
	});

	test("the provider card starts its default key login and returns to that card", async () => {
		const h = controllerHarness();
		await h.controller.showAccountManager("opencode-go");
		const opened = cardAt(h, 0);

		opened.handleInput(ENTER);
		await pasteKey(h, "sk-from-card");
		await until(() => h.cards.length === 2, "the card to reopen");

		expect(h.errors).toEqual([]);
		expect(storedKeys(h.storage, "opencode-go").map(row => row.key)).toEqual(["sk-from-card"]);
		expect(text(cardAt(h, 1))).toContain("OpenCode Go · 1 account");
	});
});

/**
 * The provider filter keeps `enter`, and `enter` there runs the same action as outside it. On a
 * provider with no accounts that is its login, which the filter's footer used to call
 * "switch to this account".
 */
describe("enter in the provider filter is labelled by what it does", () => {
	const CTRL_S = "\x13";
	const filtered = (rows: AccountRow[]) => {
		const view = card("opencode-go", rows);
		view.component.handleInput(CTRL_S);
		for (const char of "opencode go") view.component.handleInput(char);
		return view;
	};

	test("a provider with no accounts offers its login, and enter starts it", () => {
		const view = filtered([]);
		const footer = view.frame().join("\n");
		expect(footer).toContain("enter add OpenCode Go account");
		expect(footer).not.toContain("enter switch");

		view.component.handleInput(ENTER);

		expect(view.added).toEqual([["opencode-go", undefined]]);
	});

	test("a provider with an account offers to switch to it, and enter does", () => {
		const view = filtered([account("opencode-go", 7, "first")]);
		expect(view.frame().join("\n")).toContain("enter switch OpenCode Go to this account");

		view.component.handleInput(ENTER);

		expect(view.used).toEqual([7]);
		expect(view.added).toEqual([]);
	});
});

/** Wait for `condition`, failing after one second rather than hanging the suite. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function text(component: { render(width: number): readonly string[] }): string {
	return component
		.render(120)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

interface ControllerHarness {
	storage: AuthStorage;
	controller: SelectorController;
	/** Every account card the controller mounted, in order. */
	cards: AccountManagerComponent[];
	dialogs: LoginDialogComponent[];
	/** The login dialog mounted last. */
	dialog: () => LoginDialogComponent;
	/** Everything written to the transcript, plain text. */
	presented: string[];
	statuses: string[];
	errors: string[];
}

function controllerHarness(): ControllerHarness {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	const cards: AccountManagerComponent[] = [];
	const dialogs: LoginDialogComponent[] = [];
	const presented: string[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const ctx = {
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		editor: {},
		oauthManualInput: { waitForInput: async () => "", clear: () => {} },
		present: (component: { render: (width: number) => string[] }) => {
			presented.push(stripVTControlCharacters(component.render(200).join("\n")));
		},
		ui: {
			setFocus: () => {},
			requestRender: () => {},
			requestComponentRender: () => {},
			terminal: { columns: 120, rows: 40 },
			showOverlay: (component: unknown) => {
				if (component instanceof AccountManagerComponent) cards.push(component);
				if (component instanceof LoginDialogComponent) dialogs.push(component);
				return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
			},
		},
		session: {
			sessionId: "session-second-login",
			settings: Settings.instance,
			modelRegistry: { authStorage: storage, refresh: async () => undefined, refreshInBackground: () => {} },
			fetchUsageReports: async () => [],
		},
		showStatus: (message: string) => statuses.push(message),
		showWarning: () => {},
		showError: (message: string) => errors.push(message),
		refreshComposerShortcuts: () => {},
		dismissWelcome: () => {},
	} as unknown as InteractiveModeContext;
	const dialog = (): LoginDialogComponent => {
		const last = dialogs.at(-1);
		if (!last) throw new Error("no login dialog was mounted");
		return last;
	};
	return { storage, controller: new SelectorController(ctx), cards, dialogs, dialog, presented, statuses, errors };
}

/** Wait until the login dialog on screen asks for the OpenCode Go key, and return its frame. */
async function keyPrompt(h: ControllerHarness): Promise<string> {
	await until(
		() => h.dialogs.length > 0 && text(h.dialog()).includes("Paste your OpenCode Go API key"),
		"the API key prompt",
	);
	return text(h.dialog());
}

/** Answer the key prompt of the login dialog on screen. */
async function pasteKey(h: ControllerHarness, key: string): Promise<void> {
	await keyPrompt(h);
	h.dialog().pasteText(key);
	h.dialog().handleInput(ENTER);
}

/** The one card the controller mounted at `index`, failing when it is missing. */
function cardAt(h: ControllerHarness, index: number): AccountManagerComponent {
	const mounted = h.cards[index];
	if (!mounted) throw new Error(`no account card at ${index}; ${h.cards.length} mounted`);
	return mounted;
}

function storedKeys(storage: AuthStorage, provider: string): Array<{ id: number; key: string }> {
	return storage
		.listStoredCredentials(provider)
		.flatMap(row => (row.credential.type === "api_key" ? [{ id: row.id, key: row.credential.key }] : []));
}

