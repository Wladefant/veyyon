/**
 * A sign-in over SSH copies the link and takes the address back, both inside the login card.
 *
 * WHY: over SSH the browser launch opens nothing the operator can see, the authorization URL wraps
 * across several rows of a bordered card so selecting it with the mouse picks up the borders, and
 * the only documented way to finish (`/login <redirect URL>` typed into the editor) could not be
 * reached, because the login card is a fullscreen overlay that holds focus until the login ends.
 *
 * The class: a sign-in step the operator can see but cannot act on from where they are. Closed by:
 * one key (`c`, or `alt+c` while a field takes typed text) that copies the link, shown on a chip
 * that names whichever key works right now; and, for every provider whose login accepts a pasted
 * redirect, a field in the card that takes it, re-asked when an answer does not complete the
 * sign-in. The provider sweep reads the registry, so a provider that gains or loses a paste flow
 * moves between the two halves of the sweep without a change here.
 *
 * What it does NOT catch: whether the terminal honours the clipboard request (the copy is reported
 * as sent, never as landed; `clipboard.ts` owns the transport), and whether a provider's flow
 * accepts the pasted address (the callback flow's parser and its state check are tested in ai).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry/derived";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/login-dialog";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as clipboard from "@veyyon/coding-agent/utils/clipboard";
import * as openModule from "@veyyon/coding-agent/utils/open";
import type { TUI } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const REDIRECT = "http://localhost:1455/auth/callback";
const AUTH_URL = `https://auth.example.test/oauth/authorize?client_id=app&redirect_uri=${encodeURIComponent(REDIRECT)}&state=abc`;
const ALT_C = "\x1bc";
const ENTER = "\r";

/** Every link the card sent to the clipboard, and every URL it launched, in order. */
function observeSideEffects(): { copied: string[]; opened: string[] } {
	const copied: string[] = [];
	const opened: string[] = [];
	vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async (text: string) => {
		copied.push(text);
	});
	vi.spyOn(openModule, "openPath").mockImplementation((target: string) => {
		opened.push(target);
	});
	return { copied, opened };
}

function makeDialog(browserLogin: boolean): { dialog: LoginDialogComponent; frame: () => string } {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const dialog = new LoginDialogComponent(tui, "Example", () => {}, { browserLogin, getTerminalRows: () => 40 });
	return {
		dialog,
		frame: () =>
			dialog
				.render(140)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
	};
}

/** The copy chip the footer shows, or `undefined` when it shows none. */
function copyChip(frame: string): "c" | "alt+c" | undefined {
	if (frame.includes("alt+c copy link")) return "alt+c";
	if (/(^|[^+])c copy link/m.test(frame)) return "c";
	return undefined;
}

describe("the sign-in link is one key from the clipboard", () => {
	it("offers no copy before there is a link", () => {
		observeSideEffects();
		const { frame } = makeDialog(true);
		expect(copyChip(frame())).toBeUndefined();
	});

	it("a browser login sends the link at once, and c sends it again while nothing takes typed text", () => {
		const { copied, opened } = observeSideEffects();
		const { dialog, frame } = makeDialog(true);
		dialog.showAuth(AUTH_URL);
		expect(opened).toEqual([AUTH_URL]);
		expect(copied).toEqual([AUTH_URL]);
		expect(frame()).toContain("link sent to the clipboard");
		expect(copyChip(frame())).toBe("c");

		dialog.handleInput("c");
		expect(copied).toEqual([AUTH_URL, AUTH_URL]);
		dialog.handleInput(ALT_C);
		expect(copied).toEqual([AUTH_URL, AUTH_URL, AUTH_URL]);
	});

	it("while a key field takes typed text, c is typed and alt+c copies", async () => {
		const { copied } = observeSideEffects();
		const { dialog, frame } = makeDialog(false);
		dialog.showAuth(AUTH_URL);
		expect(copied).toEqual([]);
		const answer = dialog.showPrompt({ message: "Paste your API key", secret: true });
		expect(copyChip(frame())).toBe("alt+c");

		dialog.handleInput("c");
		expect(copied).toEqual([]);
		dialog.handleInput(ALT_C);
		expect(copied).toEqual([AUTH_URL]);
		dialog.handleInput(ENTER);
		await expect(answer).resolves.toBe("c");
	});

	it("the address field copies on c only while it is empty, because an address arrives as a paste", async () => {
		const { copied } = observeSideEffects();
		const { dialog, frame } = makeDialog(true);
		dialog.showAuth(AUTH_URL);
		const answer = dialog.askForRedirect({ retry: false });
		const empty = frame();
		expect(empty).toContain("Signing in from another machine? Paste the address the browser ended on:");
		expect(empty).toContain(`looks like ${REDIRECT}?code=…&state=…`);
		expect(copyChip(empty)).toBe("c");

		dialog.handleInput("c");
		expect(copied).toEqual([AUTH_URL, AUTH_URL]);

		const address = `${REDIRECT}?code=the-code&state=abc`;
		dialog.pasteText(address);
		expect(copyChip(frame())).toBe("alt+c");
		dialog.handleInput("c");
		expect(copied).toEqual([AUTH_URL, AUTH_URL]);
		dialog.handleInput(ENTER);
		await expect(answer).resolves.toBe(`${address}c`);
	});

	it("asking again says the last address did not complete the sign-in", () => {
		observeSideEffects();
		const { dialog, frame } = makeDialog(true);
		dialog.showAuth(AUTH_URL);
		void dialog.askForRedirect({ retry: true });
		expect(frame()).toContain("That did not complete the sign-in. Paste the full address the browser ended on:");
	});

	it("once the credential is stored the name question offers no copy and takes c as text", async () => {
		const { copied } = observeSideEffects();
		const { dialog, frame } = makeDialog(true);
		dialog.showAuth(AUTH_URL);
		const name = dialog.askOptionalName("Name this account (optional)", "work");
		expect(copyChip(frame())).toBeUndefined();
		dialog.handleInput("c");
		dialog.handleInput(ENTER);
		await expect(name).resolves.toBe("c");
		expect(copied).toEqual([AUTH_URL]);
	});
});

describe("a provider whose login accepts a pasted address asks for it in the card", () => {
	const rows = getOAuthProviders().filter(provider => provider.available);

	it("the registry offers both kinds, so neither half of the sweep is vacuous", () => {
		expect(rows.some(row => PASTE_CODE_LOGIN_PROVIDERS.has(row.id))).toBe(true);
		expect(rows.some(row => !PASTE_CODE_LOGIN_PROVIDERS.has(row.id))).toBe(true);
	});

	/**
	 * Run `/login <id>` far enough to reach the provider flow, hand the flow's controller to `drive`,
	 * then fail the login so the controller unwinds without opening the account card. A failed
	 * expectation inside `drive` is rethrown here rather than left in the controller's error line.
	 */
	async function driveLogin(
		id: string,
		drive: (ctrl: OAuthDriveControl, dialog: LoginDialogComponent) => Promise<void>,
	): Promise<void> {
		const overlays: unknown[] = [];
		const shownErrors: string[] = [];
		let driven = false;
		let driveError: unknown;
		const login = async (_provider: string, ctrl: OAuthDriveControl) => {
			try {
				const dialog = overlays.find(overlay => overlay instanceof LoginDialogComponent);
				if (!(dialog instanceof LoginDialogComponent)) throw new Error("the login card was not mounted");
				await drive(ctrl, dialog);
				driven = true;
			} catch (error) {
				driveError = error;
			}
			throw new Error("stop after the drive");
		};
		const ctx = {
			session: { modelRegistry: { authStorage: { login } as unknown as AuthStorage, refreshInBackground: vi.fn() } },
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { rows: 40 },
				showOverlay: vi.fn((component: unknown) => {
					overlays.push(component);
					return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
				}),
			},
			showStatus: vi.fn(),
			showError: (message: string) => {
				shownErrors.push(message);
			},
			present: vi.fn(),
			openInBrowser: vi.fn(),
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		await new SelectorController(ctx).showLogin(id);
		if (driveError) throw driveError;
		expect(driven).toBe(true);
		expect(shownErrors).toEqual(["Login failed: stop after the drive"]);
	}

	it.each(rows.filter(row => PASTE_CODE_LOGIN_PROVIDERS.has(row.id)).map(row => [row.id] as const))(
		"%s: the card's field answers the flow, and a second ask says the first did not complete",
		async id => {
			observeSideEffects();
			const address = `${REDIRECT}?code=pasted&state=abc`;
			await driveLogin(id, async (ctrl, dialog) => {
				ctrl.onAuth({ url: AUTH_URL });
				const asked = ctrl.onManualCodeInput?.();
				expect(asked).toBeDefined();
				const frame = () =>
					dialog
						.render(140)
						.map(line => stripVTControlCharacters(line))
						.join("\n");
				expect(frame()).toContain("Paste the address the browser ended on:");
				dialog.pasteText(address);
				dialog.handleInput(ENTER);
				await expect(asked).resolves.toBe(address);

				void ctrl.onManualCodeInput?.();
				expect(frame()).toContain("That did not complete the sign-in.");
			});
		},
	);

	it.each(rows.filter(row => !PASTE_CODE_LOGIN_PROVIDERS.has(row.id)).map(row => [row.id] as const))(
		"%s: the flow is offered no pasted address it could not use",
		async id => {
			observeSideEffects();
			await driveLogin(id, async ctrl => {
				expect(ctrl.onManualCodeInput).toBeUndefined();
			});
		},
	);
});

/** The slice of the login controller a provider flow receives that this suite drives. */
interface OAuthDriveControl {
	onAuth(info: { url: string; instructions?: string }): void;
	onManualCodeInput?: () => Promise<string>;
}
