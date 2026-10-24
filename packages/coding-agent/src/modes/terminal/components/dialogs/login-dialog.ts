import { type Component, Input, type TUI } from "@veyyon/tui";
import { getKeybindings } from "@veyyon/utils/keybindings";
import { matchesKey } from "@veyyon/utils/keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import { theme } from "../../../../theme/theme-binding";
import { copyToClipboard } from "../../../../utils/clipboard";
import { openPath } from "../../../../utils/open";
import { computeModalDims, MODAL_SIZING_LARGE, sizingForArea } from "../chrome/modal-geometry";
import {
	CARD_BODY_COL_INSET,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
} from "../chrome/modal-shell";
import { routeModalChrome } from "../selectors/select-list-mouse-routing";

/** What a login flow is currently asking the operator to paste. */
interface PromptState {
	message: string;
	placeholder?: string;
	/** Mask the value and take the paste byte for byte: the answer is a credential. */
	secret: boolean;
	/** The verb Enter performs in this prompt ("submit" a credential, "save" a name). */
	submitVerb: string;
	/** The field that takes the address the browser ended on, for a login whose callback cannot arrive. */
	redirect?: boolean;
}

/** Where the operator has to go to authorize, once a flow knows. */
interface AuthState {
	url: string;
	launchUrl?: string;
	instructions?: string;
}

const CANCEL_CHIP: ModalShortcut = {
	label: "cancel",
	keybindings: ["tui.select.cancel"],
	clickable: true,
	id: "cancel",
};

/** The verbatim address a browser lands on after a login, with the code still to be filled in. */
function redirectExample(authUrl: string): string | undefined {
	try {
		const redirect = new URL(authUrl).searchParams.get("redirect_uri");
		return redirect ? `${redirect}?code=…&state=…` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The login surface: one floating ModalShell card, rebuilt from state, hosted
 * as a fullscreen overlay while a provider flow runs.
 *
 * WHY IT IS REBUILT rather than appended to. Every `show*` used to push rows
 * onto one container, so the frame was a log of everything the flow had ever
 * said. An API-key login that failed validation and asked again rendered two
 * prompts, two footers, and its second question BELOW the input it belonged
 * to. There are four things this card can show, and each has exactly one
 * place: where to authorize, what is happening right now, what is being
 * asked, and which keys work. Setting one replaces it.
 */
export class LoginDialogComponent implements Component {
	#input: Input;
	#tui: TUI;
	#title: string;
	/** Whether authorization URLs should open a browser rather than identify a key dashboard. */
	#browserLogin: boolean;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;
	#auth?: AuthState;
	/** The link has been sent to the clipboard at least once since it was last reported. */
	#copied = false;
	#status?: string;
	#prompt?: PromptState;
	/**
	 * What Esc does to the prompt on screen. `cancel` aborts the whole login, which is right while a
	 * flow is still waiting for a credential. `skip` answers the question with nothing, for the
	 * optional name asked AFTER the credential is already stored: pressing Esc there must not read as
	 * "undo the login I just completed".
	 */
	#escapeMode: "cancel" | "skip" = "cancel";
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#getTerminalRows: () => number;
	/** Body line containing the input in the last rendered frame. */
	#inputBodyLine = -1;

	constructor(
		tui: TUI,
		providerLabel: string,
		private onComplete: (success: boolean, message?: string) => void,
		options: { browserLogin: boolean; getTerminalRows?: () => number },
	) {
		this.#tui = tui;
		this.#title = `Login to ${providerLabel}`;
		this.#browserLogin = options.browserLogin;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows || 40);
		this.#input = new Input();
		this.#input.onSubmit = () => {
			this.#settlePrompt(this.#input.getValue());
		};
		this.#input.onEscape = () => {
			this.#escape();
		};
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	/** Hand the pending prompt its answer and take the question off the card. */
	#settlePrompt(value: string): void {
		const resolve = this.#inputResolver;
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
		this.#prompt = undefined;
		this.#escapeMode = "cancel";
		this.#tui.requestRender();
		resolve?.(value);
	}

	#escape(): void {
		if (this.#escapeMode === "skip") {
			// The credential is already stored; this question was optional.
			this.#settlePrompt("");
			return;
		}
		this.#cancel();
	}

	#cancel(): void {
		this.#abortController.abort();
		if (this.#inputRejecter) {
			this.#inputRejecter(new Error("Login cancelled"));
			this.#inputResolver = undefined;
			this.#inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	#chips(): readonly ModalShortcut[] {
		const copyKey = this.#copyKey();
		const copy: ModalShortcut[] = copyKey ? [{ label: `${copyKey} copy link`, clickable: true, id: "copy" }] : [];
		const prompt = this.#prompt;
		if (!prompt) return [...copy, CANCEL_CHIP];
		return [
			{ label: prompt.submitVerb, keybindings: ["tui.select.confirm"] },
			...copy,
			{ ...CANCEL_CHIP, label: this.#escapeMode === "skip" ? "skip" : "cancel" },
		];
	}

	/**
	 * The key that copies the sign-in link right now, or nothing when there is no link to copy.
	 *
	 * Bare `c` while the card takes no typed text, or while the field waiting for the browser's
	 * address is still empty: an address arrives as a paste, never as a lone `c` keystroke, so the
	 * key is free there. Every other field takes typed text, and `alt+c` cannot be typed into one.
	 * Nothing once the credential is stored and the card is only asking for a name.
	 */
	#copyKey(): "c" | "alt+c" | undefined {
		if (!this.#auth || this.#escapeMode === "skip") return undefined;
		const prompt = this.#prompt;
		if (!prompt || (prompt.redirect === true && this.#input.getValue().length === 0)) return "c";
		return "alt+c";
	}

	#copyLink(): void {
		const url = this.#auth?.url;
		if (!url) return;
		this.#copied = true;
		this.#tui.requestRender();
		void copyToClipboard(url);
	}

	invalidate(): void {
		// Stateless: the card is laid out from fields on every render.
	}

	render(width: number): string[] {
		const termHeight = this.#getTerminalRows();
		// LARGE, not MEDIUM: the authorize URL is a copy target and a narrow card
		// wraps it mid-token, so the card takes the wider sizing to keep a typical
		// URL on one row.
		const sizing = sizingForArea(MODAL_SIZING_LARGE, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}

		// Lay the card out from state: where to go, what is happening, what is
		// being asked. One blank line between blocks and none inside one, so the
		// card reads the same however many times a flow re-asked. Body lines wrap
		// rather than clip: the authorize URL is a copy target, and a clipped
		// tail silently drops OAuth query parameters.
		const body: string[] = [];
		const say = (line: string): void => {
			body.push(...wrapTextWithAnsi(line, dims.contentWidth));
		};
		const auth = this.#auth;
		if (auth) {
			if (!this.#browserLogin) {
				// A dashboard where a key is obtained, not a page this login waits on.
				say(theme.fg("dim", "Get an API key at"));
			}
			say(theme.fg("accent", auth.url));
			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			const copied = this.#copied ? " · link sent to the clipboard" : "";
			body.push(theme.fg("dim", `\x1b]8;;${auth.url}\x07${clickHint}\x1b]8;;\x07${copied}`));
			if (auth.launchUrl && auth.launchUrl !== auth.url) {
				say(theme.fg("dim", `Local shortcut (this machine only): ${auth.launchUrl}`));
			}
			if (auth.instructions) {
				body.push("");
				say(theme.fg("warning", auth.instructions));
			}
		}

		if (this.#status) {
			if (body.length > 0) body.push("");
			say(theme.fg("dim", this.#status));
		}

		const prompt = this.#prompt;
		this.#inputBodyLine = -1;
		if (prompt) {
			if (body.length > 0) body.push("");
			say(theme.fg("text", prompt.message));
			this.#inputBodyLine = body.length;
			body.push(...this.#input.render(dims.contentWidth));
			if (prompt.placeholder) {
				body.push(theme.fg("dim", `looks like ${prompt.placeholder}`));
			}
		}

		const shell = renderModalShell({
			title: this.#title,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			shortcuts: this.#chips(),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#escape();
			return;
		}

		const copyKey = this.#copyKey();
		if (copyKey && (matchesKey(data, "alt+c") || (copyKey === "c" && data === "c"))) {
			this.#copyLink();
			return;
		}

		this.#input.handleInput(data);
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const consumed = routeModalChrome({
			shellGeometry: this.#shellGeometry,
			event,
			hoveredShortcutId: this.#hoveredShortcutId,
			onHoverShortcut: id => {
				this.#hoveredShortcutId = id;
				this.#tui.requestRender();
			},
			onCancel: () => this.#escape(),
			onShortcut: id => {
				if (id === "copy") {
					this.#copyLink();
					return true;
				}
				if (id !== "cancel") return false;
				this.#escape();
				return true;
			},
		});
		if (consumed || event.motion) return true;
		// A click on the field places its caret; the pasted key is then editable
		// where the pointer landed rather than only at its end.
		const geometry = this.#shellGeometry;
		if (geometry && event.leftClick && this.#prompt && this.#inputBodyLine >= 0) {
			const line = event.row - geometry.bodyRowStart;
			if (line >= 0 && line < geometry.bodyRowCount) {
				this.#input.routeMouse(
					event,
					line - this.#inputBodyLine,
					event.col - geometry.cardColStart - CARD_BODY_COL_INSET,
				);
				this.#tui.requestRender();
			}
		}
		return true;
	}

	/**
	 * Called by the OAuth `onAuth` callback. Renders the full authorization URL as the primary copy
	 * target: that works from any machine, including SSH/WSL/headless sessions where the veyyon-hosted
	 * `launchUrl` would resolve against the user's local browser and fail. When `launchUrl` is present
	 * it is offered as an additional local shortcut so narrow local terminals still have a
	 * truncation-safe copy target (viewport clipping on a long authorize URL silently drops trailing
	 * OAuth query parameters, e.g. `code_challenge_method=S256`). The OSC 8 hyperlink carries the full
	 * URL for terminals that support click-through.
	 *
	 * The browser is launched only for a login that waits on it. An API-key login reports the
	 * dashboard where a key is obtained; launching that opened a platform login page on top of the
	 * paste prompt, so choosing "OpenAI" read as starting an OAuth login instead of pasting a key.
	 * A browser login's link is also sent to the clipboard, because over SSH the launch opens no
	 * browser the operator can see and the wrapped URL is cut by the card's borders when selected.
	 */
	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#auth = { url, ...(launchUrl ? { launchUrl } : {}), ...(instructions ? { instructions } : {}) };
		this.#copied = false;
		this.#tui.requestRender();
		if (this.#browserLogin) {
			// Best-effort: a relayout must never open a second tab.
			openPath(url);
			this.#copyLink();
		}
	}

	/**
	 * Called by the `onProgress` callback. One status line, replaced rather than appended: three
	 * validation attempts are three states of one login, not three things to read.
	 */
	showProgress(message: string): void {
		this.#status = message;
		this.#tui.requestRender();
	}

	/** Ask for a credential (or a pasted code) and wait. Replaces any question already on screen. */
	showPrompt(prompt: { message: string; placeholder?: string; secret?: boolean }): Promise<string> {
		return this.#ask({
			message: prompt.message,
			...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
			// Absent means masked: a flow that wants a readable field says so.
			secret: prompt.secret !== false,
			submitVerb: "submit",
		});
	}

	/**
	 * Ask for the address the browser ended on, for a login whose callback may never reach this
	 * process: over SSH the browser runs on another machine, its redirect to `localhost` fails there,
	 * and the address in its bar is the only place the code exists. Masked, because the address
	 * carries an authorization code. `retry` reports that the previous answer did not complete the
	 * sign-in, which the flow learns only by asking again.
	 */
	askForRedirect(options: { retry: boolean }): Promise<string> {
		const example = this.#auth ? redirectExample(this.#auth.url) : undefined;
		return this.#ask({
			message: options.retry
				? "That did not complete the sign-in. Paste the full address the browser ended on:"
				: "Signing in from another machine? Paste the address the browser ended on:",
			...(example ? { placeholder: example } : {}),
			secret: true,
			submitVerb: "submit",
			redirect: true,
		});
	}

	/**
	 * Ask what to call the account that was just stored, where Esc means "leave it unnamed".
	 *
	 * Naming belongs at creation: the operator has just watched a login land and knows which account
	 * it was, while `n` on the account card asks them to recognize it later among the others. Esc here
	 * resolves nothing rather than cancelling, because the credential is already saved and there is
	 * nothing left to abandon.
	 */
	askOptionalName(message: string, placeholder?: string): Promise<string | undefined> {
		const answered = this.#ask({
			message,
			...(placeholder ? { placeholder } : {}),
			secret: false,
			submitVerb: "save",
		});
		this.#escapeMode = "skip";
		return answered.then(value => {
			const trimmed = value.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		});
	}

	#ask(prompt: PromptState): Promise<string> {
		this.#prompt = prompt;
		this.#escapeMode = "cancel";
		this.#input.credentialMode = prompt.secret;
		this.#input.setValue("");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/** Route non-bracketed paste transports into the active login input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	dispose(): void {}
}
