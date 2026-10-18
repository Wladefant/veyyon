/**
 * Login, logout, the account card and saved rate-limit resets: every flow that adds, removes, names or
 * probes a stored credential, opened from `/login`, `/logout`, `/account`, `/reset-usage` and the model hub.
 */
import type { CredentialHealthResult, UsageReport } from "@veyyon/ai";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "@veyyon/ai/auth-storage";
import { getLoginCredential } from "@veyyon/ai/oauth";
import type { OAuthProvider } from "@veyyon/ai/oauth/types";
// The derived provider set from the registry that derives it (164 modules) rather than the
// barrel (346).
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry/derived";
import { type OverlayHandle, Text } from "@veyyon/tui";
import { errorMessage, getActiveAuthDbPath } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";
import { formatProviderName } from "../../../session/account-format";
import {
	accountDisplayLabel,
	applyCredentialHealth,
	applyUsageReports,
	buildAccountInventory,
	loadAccountInventory,
} from "../../../session/account-inventory";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../../slash-commands/helpers/reset-usage";
import { theme } from "../../../theme/theme-binding";
import { openPath } from "../../../utils/open";
import { AccountManagerComponent } from "../components/account/account-manager";
import { LoginDialogComponent } from "../components/dialogs/login-dialog";
import { ResetUsageSelectorComponent } from "../components/selectors/reset-usage-selector";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import type { SelectorController, SelectorControllerContext } from "./selector-controller";

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

/**
 * Probe answers accumulated for ONE open account card.
 *
 * Per card rather than per controller: a card that is closed and reopened must re-probe, because
 * an account's health is a reading taken at a moment and a stale reading presented as current is
 * the thing every part of this surface is built to avoid. Health is keyed by credential row id so
 * a one-row refresh replaces only its own answer.
 */
interface AccountProbeCache {
	health: Map<number, CredentialHealthResult>;
	usage: UsageReport[] | null;
}

/**
 * How a login ended, for callers that reopen a surface afterwards.
 *
 * `cancelled` and `failed` are both "no credential stored", but they are not
 * interchangeable: cancelling is a decision and unwinding to the surface that
 * offered the login is correct, while failing leaves an error that a reopened
 * fullscreen surface would cover up.
 */
export type LoginOutcome = "stored" | "cancelled" | "failed";

/** The selector surfaces the account flows open their cards on. */
type AccountFlowsSurface = Pick<SelectorController, "focusActiveEditorArea" | "showModalSelector">;

export class AccountFlows {
	readonly #ctx: SelectorControllerContext;
	readonly #surface: AccountFlowsSurface;

	constructor(ctx: SelectorControllerContext, surface: AccountFlowsSurface) {
		this.#ctx = ctx;
		this.#surface = surface;
	}

	/**
	 * Run the OAuth login flow for `providerId` inside a cancellable
	 * {@link LoginDialogComponent} that replaces the editor slot. Esc aborts:
	 * the dialog's abort signal reaches the provider flow, any pending prompt
	 * rejects, and the editor is restored immediately.
	 *
	 * Cancelled and failed are separate outcomes because the caller must treat
	 * them differently. Cancelling is a decision, and unwinding one level back to
	 * the surface that offered the login is what the operator asked for. Failing
	 * leaves an error in the transcript, and a caller that reopens a FULLSCREEN
	 * surface on top of it hides the only explanation there is — which is how a
	 * rejected API key came to read as the account manager blinking and adding
	 * nothing.
	 */
	async login(providerId: string): Promise<LoginOutcome> {
		// `formatProviderName`, not the raw slug: the account card, the model hub and the footline all
		// name this provider the same way, and a login is where the operator meets it first.
		const providerLabel = formatProviderName(providerId);
		this.#ctx.showStatus(`Logging in to ${providerLabel}…`);
		const manualInput = this.#ctx.oauthManualInput;
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		let overlayHandle: OverlayHandle | undefined;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			overlayHandle?.hide();
			dialog.dispose();
			this.#surface.focusActiveEditorArea();
			this.#ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(
			this.#ctx.ui,
			providerLabel,
			(_success, message) => {
				// Fires on Esc: unblock the editor immediately; the aborted flow's
				// rejection settles the awaited login below.
				restoreEditor();
				if (message) this.#ctx.showStatus(message);
			},
			{
				browserLogin: getLoginCredential(providerId) === "oauth",
				getTerminalRows: () => this.#ctx.ui.terminal.rows,
			},
		);
		overlayHandle = this.#ctx.ui.showOverlay(dialog, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#ctx.ui.setFocus(dialog);
		this.#ctx.ui.requestRender();
		try {
			const identity = await this.#ctx.session.modelRegistry.authStorage.oauth.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
					if (useManualInput) {
						dialog.showProgress(MANUAL_LOGIN_TIP);
					}
				},
				// The whole prompt, not two of its fields: the flow that asks declares whether the answer
				// is a credential (`secret`), and the dialog masks the input from that rather than
				// guessing from the message text.
				onPrompt: (prompt: { message: string; placeholder?: string; secret?: boolean }) =>
					dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
				onSuccessPage: (url: string) => {
					// Device-code/paste flows (grok, Copilot, Kimi) get no browser
					// redirect of their own; open the freshly-served branded success
					// page so every provider ends on the same "Signed in" screen.
					openPath(url);
				},
			});
			this.#ctx.session.modelRegistry.refreshInBackground();
			// Naming happens here, while the operator still knows which account this was. Doing it from
			// the account card instead asks them to recognize it later, among the others, which is the
			// moment the name would have helped.
			const accountName = await this.#offerAccountName(dialog, providerId, providerLabel, identity?.credentialId);
			const block = new TranscriptBlock();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged in to ${providerLabel}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credentials saved to ${getActiveAuthDbPath()}`), 1, 0));
			if (accountName) {
				const named = `Named "${accountName}". Change it any time with /account`;
				block.addChild(new Text(theme.fg("dim", named), 1, 0));
			}
			this.#ctx.present(block);
			return "stored";
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the editor and
				// surfaced "Login cancelled".
				return "cancelled";
			}
			this.#ctx.showError(`Login failed: ${errorMessage(error)}`);
			return "failed";
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
			restoreEditor();
		}
	}

	/**
	 * Offer to name the account a login just stored, and return the name that was kept.
	 *
	 * Asked only from the SECOND account for a provider onwards. A lone Anthropic credential is
	 * unambiguous everywhere it appears, so asking for a nickname there is a step that buys nothing;
	 * the moment a second one lands, every list that shows them needs a way to tell them apart, and
	 * the operator knows which is which exactly now. Esc skips, and skipping is not a failure: the
	 * credential is already stored.
	 */
	async #offerAccountName(
		dialog: LoginDialogComponent,
		providerId: string,
		providerLabel: string,
		credentialId: number | undefined,
	): Promise<string | undefined> {
		// No row id means the store could not say which row it wrote, and naming the wrong sibling is
		// worse than not asking.
		if (credentialId === undefined) return undefined;
		const authStorage = this.#ctx.session.modelRegistry.authStorage;
		if (authStorage.credentials.list(providerId).length < 2) return undefined;
		const name = await dialog.askOptionalName(`Name this ${providerLabel} account (optional)`, "work");
		if (!name) return undefined;
		if (!authStorage.credentials.setAccountName(providerId, credentialId, name)) {
			this.#ctx.showWarning(
				`Could not name that account: ${providerLabel} credentials are stored where names cannot be kept`,
			);
			return undefined;
		}
		return name;
	}

	/**
	 * Remove one credential and report it, from wherever the removal was asked for.
	 *
	 * The account card owns the asking now (`x`, armed twice), so this is the one place that says
	 * what a logout DID: which account left, which file it left, and whether the provider is still
	 * authenticated by an env variable or a config key that a credential removal cannot touch. That
	 * last line is the one an operator needs and the one a status toast kept dropping.
	 */
	async #handleCredentialLogout(providerId: string, credentialId: number, label: string): Promise<void> {
		const providerLabel = formatProviderName(providerId);
		try {
			const authStorage = this.#ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.credentials.removeById(providerId, credentialId);
			if (!removed) {
				this.#ctx.showError(`Logout skipped: ${label} is no longer stored for ${providerLabel}.`);
				return;
			}

			await this.#ctx.session.modelRegistry.refresh();
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Successfully logged out ${label} from ${providerLabel}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `Credential removed from ${getActiveAuthDbPath()}`), 1, 0));
			const remainingSource = authStorage.keys.describe(providerId, this.#ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerLabel} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.#ctx.present(block);
		} catch (error: unknown) {
			this.#ctx.showError(`Logout failed: ${errorMessage(error)}`);
		}
	}

	/**
	 * `/login` and `/account login`.
	 *
	 * A login that names its provider runs straight away and ends in the account card, focused on the
	 * provider it just added: the operator's next question is which account now serves, and only the
	 * card answers it. A cancelled or failed login stays where it was, because there is nothing new
	 * to show. Without a provider the card IS the picker: its sidebar lists every provider a login is
	 * possible for, `a` starts one on the provider under the cursor, and the accounts already stored
	 * are on screen while you choose, which a bare provider list could never show.
	 */
	async showLogin(providerId?: string): Promise<void> {
		if (providerId) {
			if ((await this.login(providerId)) === "stored") await this.showAccountManager(providerId);
			return;
		}
		await this.showAccountManager();
	}

	/**
	 * `/logout` and `/account logout`.
	 *
	 * Also the card, because logging out is choosing an ACCOUNT and the card is the only surface that
	 * shows what each one is: its plan, its usage, whether it is the account serving this session and
	 * whether it is the one you chose. A dedicated picker could show a label and a bullet, so the
	 * operator picked from names alone and the destructive key was the first thing they were offered.
	 * `x` on the card is armed twice, and the report it prints is the same one it always was.
	 *
	 * The refusals stay, because they are the two cases the card cannot state: a provider with no
	 * stored credential has nothing to remove, and an auth that comes from an env variable or a
	 * config key is not removable here at all. Both name where the auth actually comes from.
	 */
	async showLogout(providerId?: string): Promise<void> {
		const authStorage = this.#ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.credentials.reload();
		} catch (error: unknown) {
			this.#ctx.showError(`Could not load stored credentials: ${errorMessage(error)}`);
			return;
		}
		if (providerId) {
			if (authStorage.credentials.list(providerId).length === 0) {
				const source = authStorage.keys.describe(providerId, this.#ctx.session.sessionId);
				const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
				this.#ctx.showError(
					`Logout skipped: no stored credentials for ${formatProviderName(providerId)}.${suffix}`,
				);
				return;
			}
			await this.showAccountManager(providerId);
			return;
		}
		if (authStorage.credentials.list().length === 0) {
			this.#ctx.showStatus("No stored provider credentials to log out. Remove env or config auth at its source.");
			return;
		}
		await this.showAccountManager();
	}

	/**
	 * Fullscreen account manager: one row per stored CREDENTIAL, grouped by provider.
	 *
	 * Paints from the synchronous inventory first, then folds in health and usage as their probes
	 * land. That order is deliberate: probing every credential costs a network round-trip each, and
	 * a card that waits for them shows an empty frame for seconds on a multi-account setup. The
	 * component keeps its selection across `setInventory`, so the rows filling in underneath the
	 * cursor never move it.
	 */
	async showAccountManager(providerId?: string): Promise<void> {
		const authStorage = this.#ctx.session.modelRegistry.authStorage;
		const sessionId = this.#ctx.session.sessionId;
		let overlayHandle: OverlayHandle | undefined;
		let manager: AccountManagerComponent | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			manager?.dispose();
			overlayHandle?.hide();
			this.#surface.focusActiveEditorArea();
			this.#ctx.ui.requestRender();
		};
		const probes: AccountProbeCache = { health: new Map(), usage: null };
		// Re-read from the store rather than mutating the rendered model: a pin, a rename and a
		// logout all change what the store says, and rebuilding is the only way the card cannot
		// disagree with it.
		//
		// The probe answers are re-applied on top, because they are not in the store. Rebuilding
		// without them is how naming an account blanked the health mark and every usage bar on the
		// card until the next probe landed: the rename succeeded and the card looked like it had lost
		// the account's readings.
		let inventoryRevision = 0;
		const reload = async () => {
			if (closed) return;
			const revision = ++inventoryRevision;
			try {
				const reportableDisabled = await authStorage.credentials.listReportableDisabled();
				if (closed || revision !== inventoryRevision) return;
				let inventory = applyCredentialHealth(buildAccountInventory(authStorage, { sessionId, reportableDisabled }), [
					...probes.health.values(),
				]);
				if (probes.usage) inventory = applyUsageReports(inventory, probes.usage);
				manager?.setInventory(inventory);
				this.#ctx.ui.requestRender();
			} catch (error: unknown) {
				logger.debug("account manager: credential inventory refresh failed", { error: errorMessage(error) });
			}
		};

		manager = new AccountManagerComponent(
			await loadAccountInventory(authStorage, { sessionId }),
			{
				onUseAccount: row => {
					if (authStorage.sessions.selectProviderCredential(row.provider, row.credentialId, { sessionId })) {
						this.#ctx.showStatus(
							`${row.providerLabel}: now using ${accountDisplayLabel(row)} everywhere on this machine`,
						);
					} else {
						// The credential vanished between render and keypress (a peer logged it out).
						// Say so; a silent no-op reads as the key being broken.
						this.#ctx.showWarning(`${row.providerLabel}: that account is no longer stored`);
					}
					reload();
				},
				onRename: (row, name) => {
					const previous = accountDisplayLabel(row);
					if (!authStorage.credentials.setAccountName(row.provider, row.credentialId, name)) {
						this.#ctx.showWarning(
							`Could not name that account — ${row.providerLabel} credentials are stored where names cannot be kept`,
						);
						return;
					}
					reload();
					this.#ctx.showStatus(
						name.trim().length === 0
							? `${row.providerLabel}: cleared the name on ${previous}`
							: `${row.providerLabel}: ${previous} is now "${name.trim()}"`,
					);
				},
				onRefresh: (_provider, row) => {
					void this.#probeAccountHealth(
						() => manager,
						() => closed,
						probes,
						row ? [row.credentialId] : undefined,
					);
				},
				onLogout: row => {
					void (async () => {
						// ONE reporter for a removal, whichever surface asked. The card used to say
						// "logged out of X" in a status line and stop there, which drops the two facts a
						// logout has to carry: which file the credential left, and whether the provider
						// is still authenticated by an env variable this cannot touch.
						await this.#handleCredentialLogout(row.provider, row.credentialId, accountDisplayLabel(row));
						reload();
					})();
				},
				onShowUsage: () => {
					done();
					void this.#ctx.handleUsageCommand();
				},
				onAddAccount: provider => {
					done();
					void this.#loginThenReopenAccountManager(provider);
				},
				onClearRateLimitBlock: row => {
					authStorage.blocks.clearAll(row.provider, row.credentialId);
					// Re-probe the one account, so the row's countdown is replaced by what the provider
					// says now rather than by an empty space this cleared. Lifting a block that really
					// is still in force therefore shows it again, which is the honest outcome: the
					// operator asked whether the provider still refuses, and the provider answered.
					void this.#probeAccountHealth(
						() => manager,
						() => closed,
						probes,
						[row.credentialId],
					);
					reload();
					this.#ctx.showStatus(
						`${row.providerLabel}: cleared the rate-limit hold on ${accountDisplayLabel(row)} and re-checked it`,
					);
				},
				onForgetSignedOut: provider => {
					const forgotten = authStorage.credentials.forgetSignedOutLogins(provider);
					reload();
					if (forgotten > 0) {
						this.#ctx.showStatus(
							`${formatProviderName(provider)}: forgot the signed-out login; its credential stays disabled`,
						);
					} else {
						this.#ctx.showWarning(
							`${formatProviderName(provider)}: no signed-out login to forget in this credential store`,
						);
					}
				},
				onCancel: done,
			},
			{
				initialProviderId: providerId,
				loadBalancing: this.#ctx.session.settings.get("accounts.loadBalancing") === true,
				requestRender: () => {
					const component = manager;
					if (component) this.#ctx.ui.requestComponentRender(component);
				},
			},
		);

		overlayHandle = this.#ctx.ui.showOverlay(manager, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#ctx.ui.setFocus(manager);
		this.#ctx.ui.requestRender();

		await this.#probeAccountHealth(
			() => manager,
			() => closed,
			probes,
		);
	}

	/**
	 * `a` / `+ add another …` from the account card: log in, then come back to the card on the
	 * provider the login was started from.
	 *
	 * Reopened after a CANCELLED login too, not just a successful one, because escape unwinds one
	 * level: the login is what the user opened from the card, so abandoning it must return them to
	 * the card rather than to the composer. Reopening rebuilds the inventory from the store, which
	 * is what makes a freshly added account visible in the row list the user is already looking at
	 * instead of only on the next `/account`.
	 *
	 * The new credential is deliberately NOT made the serving account. With load balancing off, the
	 * selected credential decides what gets spent, and a login is not a request to move the
	 * session's traffic; the card shows the new row and `enter` moves traffic when the user says so.
	 */
	async #loginThenReopenAccountManager(providerId: string): Promise<void> {
		// Cancelling unwinds one level: the card offered the login, so the card is
		// where escape belongs. A FAILURE does not, because the card is a
		// fullscreen overlay and reopening it draws straight over the error
		// `login` just printed — which is how a rejected API key read
		// as "Validating…" and then the same card, with no account and no reason.
		if ((await this.login(providerId)) !== "failed") await this.showAccountManager(providerId);
	}

	/**
	 * Fold live health and usage into an open account manager.
	 *
	 * Both probes are best-effort and independent: a provider with no usage endpoint must not stop
	 * the health column from arriving, and a health probe that times out must not blank the usage
	 * bars. A failure leaves the affected column absent, which the card renders as "not probed"
	 * rather than as a healthy account.
	 *
	 * `credentialIds` narrows the HEALTH probe to those rows, which is what `r` on a row passes: the
	 * probe is a sequential network round-trip per credential, so a nine-account provider made the
	 * user wait for eight accounts they had not asked about. The USAGE fetch stays whole because
	 * there is nothing per-account to narrow it to: it is one cached call that answers for every
	 * credential at once, and asking for less would cost the same.
	 */
	async #probeAccountHealth(
		getManager: () => AccountManagerComponent | undefined,
		isClosed: () => boolean,
		probes: AccountProbeCache,
		credentialIds?: readonly number[],
	): Promise<void> {
		const authStorage = this.#ctx.session.modelRegistry.authStorage;
		const sessionId = this.#ctx.session.sessionId;
		const baseUrlResolver = (target: string) => this.#ctx.session.modelRegistry.getProviderBaseUrl?.(target);
		const [health, usage] = await Promise.all([
			authStorage.health.check(credentialIds ? { baseUrlResolver, credentialIds } : { baseUrlResolver })
				.catch(error => {
					logger.debug("account manager: credential health probe failed", { error: errorMessage(error) });
					return [];
				}),
			this.#ctx.session.fetchUsageReports().catch(error => {
				logger.debug("account manager: usage probe failed", { error: errorMessage(error) });
				return null;
			}),
		]);
		if (isClosed()) return;
		const manager = getManager();
		if (!manager) return;
		// ACCUMULATED for the life of this card, because a scoped probe answers for one credential
		// while the inventory underneath it is rebuilt from the store every time. Without this,
		// refreshing one row would blank the health mark on every other row that had already been
		// probed: a card that had answered for nine accounts would answer for one.
		for (const result of health) probes.health.set(result.id, result);
		if (usage) probes.usage = usage;
		let inventory = applyCredentialHealth(await loadAccountInventory(authStorage, { sessionId }), [
			...probes.health.values(),
		]);
		if (probes.usage) inventory = applyUsageReports(inventory, probes.usage);
		manager.setInventory(inventory);
		this.#ctx.ui.requestRender();
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.#ctx.session;
		this.#ctx.showStatus("Checking saved rate-limit resets…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.#ctx.showError(`Could not load saved resets: ${errorMessage(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.#ctx.showStatus("No OpenAI Codex or Anthropic accounts found. Use /login to add one.");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.#ctx.showStatus(
				accounts.some(account => account.error)
					? "No saved resets available — some accounts couldn't be reached (try /login)."
					: "No saved rate-limit resets available to spend right now.",
			);
			return;
		}
		this.#surface.showModalSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.#ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		const label = `${account.providerName} ${account.label}`;
		this.#ctx.showStatus(`Spending 1 saved reset for ${label}…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.#ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.#ctx.showError(`Reset failed for ${label}: ${errorMessage(error)}`);
			return;
		}
		const message = describeRedeemOutcome(outcome, label);
		if (outcome.ok) {
			this.#ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.#ctx.statusLine.invalidate();
			this.#ctx.ui.requestRender();
		} else {
			this.#ctx.showWarning(message);
		}
	}
}
