/**
 * WHY: a provider that signs in two ways registers the second mechanism as a login entry of its own,
 * filed under the first by `storeCredentialsAs`: `opencode-go-api-key` beside the OpenCode Console
 * login, `nous-research-api-key` beside the Nous device flow, `openai-codex-device` beside the Codex
 * browser login. The account card groups logins by the provider they store under, and its add entry
 * started only the provider's own login, so the second mechanism was reachable only by typing its id.
 * Typed that way, the login was labelled with the mechanism's slug ("OpenCode Go Api Key"), counted
 * sibling accounts under the mechanism's id and so never offered a name for a second account, and
 * reopened the card on that id, which has no entry, so the card landed on whichever provider sorted
 * first.
 *
 * THE CLASS: every login whose credential lands under another provider. The card half enumerates them
 * from `getOAuthProviders()` at run time, so a mechanism registered later is held to the same
 * contract with no edit here. The controller half drives the real login, dialog and credential store
 * with the OpenCode Go API key, whose login validates nothing over the network.
 *
 * WHAT IT DOES NOT CATCH: which login is a provider's default is pinned for OpenCode Go only. A
 * mechanism whose login needs the network is covered by the card sweep and the shared storage-id
 * resolution the controller half exercises, not by running its own login.
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
			expect.arrayContaining(["openai-codex-device", "opencode-go-api-key", "nous-research-api-key"]),
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

describe("OpenCode Go signs in with the Console first and keeps the API key as the legacy way", () => {
	test("the provider's own entry is the Console login and holds the cursor", () => {
		expect(getLoginCredential("opencode-go")).toBe("oauth");
		expect(getLoginCredential("opencode-go-api-key")).toBe("api-key");
		const view = card("opencode-go");
		expect(view.cursorLine()).toBe("› + add OpenCode Go account");

		view.component.handleInput(ENTER);

		expect(view.added).toEqual([["opencode-go", undefined]]);
	});

	test("`a` starts the Console login even from the legacy entry", () => {
		const view = card("opencode-go");
		view.component.handleInput(DOWN);
		expect(view.cursorLine()).toBe("› + add with API key (legacy)");

		view.component.handleInput("a");

		expect(view.added).toEqual([["opencode-go", undefined]]);
	});

	test("the list wraps through both add entries in each direction", () => {
		const view = card("opencode-go", [account("opencode-go", 1, "first")]);
		expect(view.cursorLine()).toContain("first");

		view.component.handleInput(DOWN);
		expect(view.cursorLine()).toBe("› + add another OpenCode Go account");
		view.component.handleInput(DOWN);
		expect(view.cursorLine()).toBe("› + add with API key (legacy)");
		view.component.handleInput(DOWN);
		expect(view.cursorLine()).toContain("first");

		view.component.handleInput(UP);
		expect(view.cursorLine()).toBe("› + add with API key (legacy)");
		view.component.handleInput(ENTER);
		expect(view.added).toEqual([["opencode-go", "opencode-go-api-key"]]);
		expect(view.used).toEqual([]);
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

describe("an alternate login lands its account on the provider it stores under", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		const storage = authStorage;
		if (!storage) throw new Error("no auth storage");
		// Health probing is an HTTP call per credential and has nothing to do with this contract.
		vi.spyOn(storage, "checkCredentials").mockResolvedValue([]);
		// The API-key login reaches no network. A route to the Console login would, and fails here
		// instead of sending a device-code request from a test.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("this suite reaches no network"));
		await storage.set("opencode-go", []);
		// A populated provider that sorts ahead of OpenCode Go. A card opened on an id with no entry
		// falls back to the first populated provider, which without this would be OpenCode Go itself.
		await storage.set("anthropic", [{ type: "api_key", key: "sk-other-provider" }]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("/login opencode-go-api-key is labelled OpenCode Go, stores there, and opens its card", async () => {
		const h = controllerHarness();

		const running = h.controller.showLogin("opencode-go-api-key");
		const prompt = await keyPrompt(h);
		expect(prompt).toContain("Login to OpenCode Go ");
		expect(prompt).not.toContain("Api Key");
		await pasteKey(h, "sk-legacy-one");
		await running;

		expect(h.errors).toEqual([]);
		expect(h.statuses).toContain("Logging in to OpenCode Go…");
		expect(h.presented.join("\n")).toContain("Successfully logged in to OpenCode Go");
		expect(storedKeys(h.storage, "opencode-go").map(row => row.key)).toEqual(["sk-legacy-one"]);
		expect(h.storage.listStoredCredentials("opencode-go-api-key")).toEqual([]);
		expect(h.cards).toHaveLength(1);
		expect(text(cardAt(h, 0))).toContain("OpenCode Go · 1 account");
	});

	test("a second key is offered a name, and the name lands on the row the login wrote", async () => {
		const h = controllerHarness();
		await h.storage.set("opencode-go", [{ type: "api_key", key: "sk-legacy-one" }]);

		const running = h.controller.showLogin("opencode-go-api-key");
		await pasteKey(h, "sk-legacy-two");
		await until(() => text(h.dialog()).includes("Name this OpenCode Go account (optional)"), "the name prompt");
		h.dialog().pasteText("spare key");
		h.dialog().handleInput(ENTER);
		await running;

		const second = storedKeys(h.storage, "opencode-go").find(row => row.key === "sk-legacy-two");
		expect(second).toBeDefined();
		expect(h.storage.getAccountName("opencode-go", second?.id ?? -1)).toBe("spare key");
		expect(h.presented.join("\n")).toContain('Named "spare key"');
	});

	test("the card's legacy entry runs the API-key login and returns to the OpenCode Go card", async () => {
		const h = controllerHarness();
		await h.controller.showAccountManager("opencode-go");
		const opened = cardAt(h, 0);

		opened.handleInput(DOWN);
		opened.handleInput(ENTER);
		await pasteKey(h, "sk-from-card");
		await until(() => h.cards.length === 2, "the card to reopen");

		expect(h.errors).toEqual([]);
		expect(storedKeys(h.storage, "opencode-go").map(row => row.key)).toEqual(["sk-from-card"]);
		expect(text(cardAt(h, 1))).toContain("OpenCode Go · 1 account");
	});
});
