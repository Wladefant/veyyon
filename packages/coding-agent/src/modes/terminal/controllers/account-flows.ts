/**
 * Login, logout, the account card and saved rate-limit resets: every flow that adds, removes, names or
 * probes a stored credential, opened from `/login`, `/logout`, `/account`, `/reset-usage` and the model hub.
 */
import type { CredentialHealthResult, UsageReport } from "@veyyon/ai";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "@veyyon/ai/auth-storage";
import { getLoginCredential, getOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthProvider } from "@veyyon/ai/oauth/types";
// The derived provider set from the registry that derives it (164 modules) rather than the
// barrel (346).
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry/derived";
import { type OverlayHandle, Text } from "@veyyon/tui";
import { errorMessage, getActiveAuthDbPath } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";
import { formatProviderName } from "../../../session/account-format";
import {
	type AccountInventory,
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

/** What one health probe answered: a result per credential it reached, or why it reached none. */
interface AccountCheckOutcome {
	health: readonly CredentialHealthResult[];
	failure?: string;
}

/**
 * An inventory with every probe answer the card holds folded in.
 *
 * Usage comes from the cached fan-out AND from each health probe's own report. The health probe
 * reads the usage endpoint live, so its report is the freshest reading there is, while the cached
 * fan-out can be five minutes old: folding only the cache is how `r` re-checked an account and left
 * every bar where it was. Both kinds of report go through the same attribution and keep the
 * freshest reading per window, so `r` updates the bars without a second request per account.
 */
function withProbeAnswers(inventory: AccountInventory, probes: AccountProbeCache): AccountInventory {
	const health = [...probes.health.values()];
	const reports: UsageReport[] = [...(probes.usage ?? [])];
	for (const result of health) if (result.report) reports.push(result.report);
	return applyUsageReports(applyCredentialHealth(inventory, health), reports);
}

/** The notice a finished check leaves on the account card. */
function describeAccountCheck(subject: string, outcome: AccountCheckOutcome): string {
	if (outcome.failure !== undefined) return `${subject}: the check did not run: ${outcome.failure}`;
	const { health } = outcome;
	if (health.length === 0) return `${subject}: no stored account to check`;
	if (health.length === 1) {
		const [result] = health;
		if (result.ok === true) return result.report ? `${subject}: signed in · usage updated` : `${subject}: signed in`;
		if (result.ok === false)
			return `${subject}: check failed: ${result.reason ?? "the provider refused the credential"}`;
		return result.reason ? `${subject}: could not be checked: ${result.reason}` : `${subject}: could not be checked`;
	}
	const signedIn = health.filter(result => result.ok === true).length;
	const failed = health.filter(result => result.ok === false).length;
	const unchecked = health.length - signedIn - failed;
	const parts = [`${signedIn} signed in`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (unchecked > 0) parts.push(`${unchecked} could not be checked`);
	return `${subject}: checked ${health.length} accounts · ${parts.join(" · ")}`;
}

/**
 * The provider a login stores its credential under. An alternate login, such as an API key beside a
 * browser login, files it under another provider's id through `storeCredentialsAs`; that provider is
 * where the account lands, what names it, and the card entry that lists it.
 */
function credentialProviderOf(loginId: string): string {
	return getOAuthProviders().find(provider => provider.id === loginId)?.storeCredentialsAs ?? loginId;
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
		const storedAs = credentialProviderOf(providerId);
		// `formatProviderName`, not the raw slug: the account card, the model hub and the footline all
		// name this provider the same way, and a login is where the operator meets it first.
		const providerLabel = formatProviderName(storedAs);
		this.#ctx.showStatus(`Logging in to ${providerLabel}…`);
		// The dialog owns the pasted redirect: it is a fullscreen overlay holding focus, so the
		// editor where `/login <redirect URL>` would be typed cannot be reached until it closes.
		const asksForRedirect = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let redirectAsks = 0;
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
			const identity = await this.#ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target), copies it, and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				// The whole prompt, not two of its fields: the flow that asks declares whether the answer
				// is a credential (`secret`), and the dialog masks the input from that rather than
				// guessing from the message text.
				onPrompt: (prompt: { message: string; placeholder?: string; secret?: boolean }) =>
					dialog.showPrompt(prompt),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				// Asked again only after an answer that did not complete the sign-in.
				onManualCodeInput: asksForRedirect ? () => dialog.askForRedirect({ retry: redirectAsks++ > 0 }) : undefined,
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
			const accountName = await this.#offerAccountName(dialog, storedAs, providerLabel, identity?.credentialId);
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
		if (authStorage.listStoredCredentials(providerId).length < 2) return undefined;
		const name = await dialog.askOptionalName(`Name this ${providerLabel} account (optional)`, "work");
		if (!name) return undefined;
		if (!authStorage.setAccountName(providerId, credentialId, name)) {
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
	 *
	 * Returns the one-line outcome for the card's notice line, which the transcript block sits under
	 * until the card closes.
	 */
	async #handleCredentialLogout(providerId: string, credentialId: number, label: string): Promise<string> {
		const providerLabel = formatProviderName(providerId);
		try {
			const authStorage = this.#ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, credentialId);
			if (!removed) {
				const skipped = `Logout skipped: ${label} is no longer stored for ${providerLabel}.`;
				this.#ctx.showError(skipped);
				return skipped;
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
			const remainingSource = authStorage.describeCredentialSource(providerId, this.#ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerLabel} is still authenticated via ${remainingSource}`), 1, 0),
				);
			}
			this.#ctx.present(block);
			return remainingSource
				? `Logged out ${label} from ${providerLabel}; still authenticated via ${remainingSource}`
				: `Logged out ${label} from ${providerLabel}`;
		} catch (error: unknown) {
			const failed = `Logout failed: ${errorMessage(error)}`;
			this.#ctx.showError(failed);
			return failed;
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
			if ((await this.login(providerId)) === "stored")
				await this.showAccountManager(credentialProviderOf(providerId));
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
			await authStorage.reload();
		} catch (error: unknown) {
			this.#ctx.showError(`Could not load stored credentials: ${errorMessage(error)}`);
			return;
		}
		if (providerId) {
			if (authStorage.listStoredCredentials(providerId).length === 0) {
				const source = authStorage.describeCredentialSource(providerId, this.#ctx.session.sessionId);
				const suffix = source ? ` Current auth comes from ${source}; remove that source to log out.` : "";
				this.#ctx.showError(
					`Logout skipped: no stored credentials for ${formatProviderName(providerId)}.${suffix}`,
				);
				return;
			}
			await this.showAccountManager(providerId);
			return;
		}
		if (authStorage.listStoredCredentials().length === 0) {
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
		const reload = () => {
			if (closed) return;
			manager?.setInventory(withProbeAnswers(buildAccountInventory(authStorage, { sessionId }), probes));
			this.#ctx.ui.requestRender();
		};
		// Every outcome of a key pressed on the card lands on the card's notice line as well as in the
		// transcript: the card is a fullscreen overlay, so the transcript line alone stays hidden
		// until the card closes and the key reads as having done nothing.
		const notify = (text: string, level: "status" | "warning" = "status") => {
			if (level === "warning") this.#ctx.showWarning(text);
			else this.#ctx.showStatus(text);
			if (!closed) manager?.setNotice(text);
		};
		// `r`, and the re-check after lifting a block: "Checking …" at once, then what the provider
		// answered. Without the first line nothing on the card moved until the network did.
		const check = (subject: string, credentialIds: readonly number[], preface?: string) => {
			const lead = preface ? `${preface} · ` : "";
			if (credentialIds.length === 0) {
				manager?.setNotice(`${lead}${subject}: no stored account to check`);
				return;
			}
			manager?.setNotice(`${lead}Checking ${subject}…`);
			void this.#probeAccountHealth(
				() => manager,
				() => closed,
				probes,
				credentialIds,
			).then(outcome => {
				if (!closed) manager?.setNotice(`${lead}${describeAccountCheck(subject, outcome)}`);
			});
		};

		manager = new AccountManagerComponent(
			await loadAccountInventory(authStorage, { sessionId }),
			{
				onUseAccount: row => {
					if (authStorage.selectProviderCredential(row.provider, row.credentialId, { sessionId })) {
						notify(`${row.providerLabel}: now using ${accountDisplayLabel(row)} everywhere on this machine`);
					} else {
						// The credential vanished between render and keypress (a peer logged it out).
						// Say so; a silent no-op reads as the key being broken.
						notify(`${row.providerLabel}: that account is no longer stored`, "warning");
					}
					reload();
				},
				onRename: (row, name) => {
					const previous = accountDisplayLabel(row);
					if (!authStorage.setAccountName(row.provider, row.credentialId, name)) {
						notify(
							`Could not name that account — ${row.providerLabel} credentials are stored where names cannot be kept`,
							"warning",
						);
						return;
					}
					reload();
					notify(
						name.trim().length === 0
							? `${row.providerLabel}: cleared the name on ${previous}`
							: `${row.providerLabel}: ${previous} is now "${name.trim()}"`,
					);
				},
				onRefresh: (provider, row) => {
					if (row) {
						check(`${accountDisplayLabel(row)} (${row.providerLabel})`, [row.credentialId]);
						return;
					}
					// The add entry has no row: every account of THIS provider, not of every provider.
					check(
						formatProviderName(provider),
						authStorage.listStoredCredentials(provider).map(stored => stored.id),
					);
				},
				onLogout: row => {
					void (async () => {
						// ONE reporter for a removal, whichever surface asked. The card used to say
						// "logged out of X" in a status line and stop there, which drops the two facts a
						// logout has to carry: which file the credential left, and whether the provider
						// is still authenticated by an env variable this cannot touch.
						const outcome = await this.#handleCredentialLogout(
							row.provider,
							row.credentialId,
							accountDisplayLabel(row),
						);
						reload();
						if (!closed) manager?.setNotice(outcome);
					})();
				},
				onShowUsage: () => {
					done();
					void this.#ctx.handleUsageCommand();
				},
				onAddAccount: (provider, loginId) => {
					done();
					void this.#loginThenReopenAccountManager(loginId ?? provider);
				},
				onClearRateLimitBlock: row => {
					authStorage.clearCredentialBlocks(row.provider, row.credentialId);
					reload();
					const label = accountDisplayLabel(row);
					this.#ctx.showStatus(`${row.providerLabel}: cleared the rate-limit hold on ${label} and re-checked it`);
					// Re-probe the one account, so the row's countdown is replaced by what the provider
					// says now rather than by an empty space this cleared. Lifting a block that really
					// is still in force therefore shows it again, which is the honest outcome: the
					// operator asked whether the provider still refuses, and the provider answered.
					check(`${label} (${row.providerLabel})`, [row.credentialId], "Cleared the rate-limit hold");
				},
				onForgetSignedOut: provider => {
					const forgotten = authStorage.forgetSignedOutLogins(provider);
					reload();
					if (forgotten > 0) {
						notify(`${formatProviderName(provider)}: forgot the signed-out login; its credential stays disabled`);
					} else {
						notify(
							`${formatProviderName(provider)}: no signed-out login to forget in this credential store`,
							"warning",
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
	 * `a` / `+ add …` from the account card: log in, then come back to the card on the provider the
	 * login stored its account under, which is the provider it was started from.
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
	async #loginThenReopenAccountManager(loginId: string): Promise<void> {
		// Cancelling unwinds one level: the card offered the login, so the card is
		// where escape belongs. A FAILURE does not, because the card is a
		// fullscreen overlay and reopening it draws straight over the error
		// `login` just printed — which is how a rejected API key read
		// as "Validating…" and then the same card, with no account and no reason.
		if ((await this.login(loginId)) !== "failed") await this.showAccountManager(credentialProviderOf(loginId));
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
	 * credential at once, and asking for less would cost the same. The health probe reads the usage
	 * endpoint live, so its reports are folded in too (see {@link withProbeAnswers}).
	 *
	 * Returns what the health probe answered, for the notice `r` leaves on the card.
	 */
	async #probeAccountHealth(
		getManager: () => AccountManagerComponent | undefined,
		isClosed: () => boolean,
		probes: AccountProbeCache,
		credentialIds?: readonly number[],
	): Promise<AccountCheckOutcome> {
		const authStorage = this.#ctx.session.modelRegistry.authStorage;
		const sessionId = this.#ctx.session.sessionId;
		const baseUrlResolver = (target: string) => this.#ctx.session.modelRegistry.getProviderBaseUrl?.(target);
		const [outcome, usage] = await Promise.all([
			authStorage.checkCredentials(credentialIds ? { baseUrlResolver, credentialIds } : { baseUrlResolver }).then(
				(health): AccountCheckOutcome => ({ health }),
				(error): AccountCheckOutcome => {
					const failure = errorMessage(error);
					logger.debug("account manager: credential health probe failed", { error: failure });
					return { health: [], failure };
				},
			),
			this.#ctx.session.fetchUsageReports().catch(error => {
				logger.debug("account manager: usage probe failed", { error: errorMessage(error) });
				return null;
			}),
		]);
		if (isClosed()) return outcome;
		const manager = getManager();
		if (!manager) return outcome;
		// ACCUMULATED for the life of this card, because a scoped probe answers for one credential
		// while the inventory underneath it is rebuilt from the store every time. Without this,
		// refreshing one row would blank the health mark on every other row that had already been
		// probed: a card that had answered for nine accounts would answer for one.
		for (const result of outcome.health) probes.health.set(result.id, result);
		if (usage) probes.usage = usage;
		manager.setInventory(withProbeAnswers(await loadAccountInventory(authStorage, { sessionId }), probes));
		this.#ctx.ui.requestRender();
		return outcome;
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
