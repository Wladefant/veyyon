/**
 * Shared helpers for the `/usage reset` command (TUI selector + ACP): turn the
 * live per-account reset-credit status into selector rows, resolve a typed
 * account argument, and map a redeem outcome code to a human message.
 */
import {
	RESET_CREDIT_PROVIDERS,
	type ResetCreditAccountStatus,
	type ResetCreditProvider,
	type ResetCreditRedeemOutcome,
	type ResetCreditTarget,
} from "@veyyon/ai/auth-storage";
import { formatProviderName } from "../../session/account-format";

/** One account row for the reset-usage selector. */
export interface ResetUsageAccount {
	/** Display label (email, else account id). */
	label: string;
	/** Provider display name (`OpenAI Codex`, `Anthropic`). */
	providerName: string;
	/** Saved resets redeemable for this account right now. */
	availableCount: number;
	/** Identifies the account (and its provider) when redeeming. */
	target: ResetCreditTarget;
	/** Whether this is the session's active account for its provider. */
	active: boolean;
	/** Set when this account could not be reached (token/list failure). */
	error?: string;
}

/**
 * Map live per-account reset status to selector rows. Sorted with active
 * accounts first, then most credits, then provider, then label.
 */
export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses
		.map(status => ({
			label: status.email ?? status.accountId ?? "account",
			providerName: formatProviderName(status.provider),
			availableCount: status.availableCount,
			target: {
				provider: status.provider,
				credentialId: status.credentialId,
				accountId: status.accountId,
				email: status.email,
			} satisfies ResetCreditTarget,
			active: status.active,
			error: status.error,
		}))
		.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
			if (a.target.provider !== b.target.provider) return a.target.provider.localeCompare(b.target.provider);
			return a.label.localeCompare(b.label);
		});
}

function isResetCreditProvider(value: string): value is ResetCreditProvider {
	return (RESET_CREDIT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolve a `/usage reset` argument to one account row. The argument is an
 * account email, account id or `active`, optionally preceded by a provider id
 * (`anthropic active`, `openai-codex me@example.com`). The same email can be
 * signed in to several providers, so among the rows it matches the one with
 * redeemable resets wins; `rows` is already ordered by {@link toResetUsageAccounts}.
 */
export function findResetUsageAccount(rows: ResetUsageAccount[], arg: string): ResetUsageAccount | undefined {
	const tokens = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const provider = tokens.length > 1 && isResetCreditProvider(tokens[0]) ? tokens.shift() : undefined;
	const wanted = tokens.join(" ");
	const matches = rows.filter(
		row =>
			(!provider || row.target.provider === provider) &&
			(wanted === "active"
				? row.active
				: row.label.toLowerCase() === wanted ||
					row.target.email?.toLowerCase() === wanted ||
					row.target.accountId?.toLowerCase() === wanted),
	);
	return matches.find(row => row.availableCount > 0) ?? matches[0];
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	switch (outcome.code) {
		case "reset":
			return `Reset applied for ${label} — your rate-limit window has been refreshed.`;
		case "already_redeemed":
			return `${label}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}: no saved resets available to spend.`;
		case "nothing_to_reset":
			return `${label}: nothing to reset right now — your limits aren't constrained, so no credit was spent.`;
		case "cooldown":
			return `${label}: resets are cooling down — try again later. No credit was spent.`;
		case "ineligible":
			return `${label}: this account is not eligible for usage resets.`;
		case "unavailable":
			return `${label}: usage resets are unavailable right now. No credit was spent.`;
		case "no_organization":
			return `${label}: could not determine the account's organization — sign in again with /login in an interactive veyyon session.`;
		case "status_unavailable":
			return `${label}: could not read the account's reset status. No credit was spent.`;
		case "no_account":
			return `Could not find a stored ${formatProviderName(outcome.provider)} account matching "${label}".`;
		case "account_unavailable":
			// `/usage reset` is a text-mode command, so this sentence reaches ACP, where `/login` is
			// not advertised and not dispatchable. Naming the surface is what keeps it actionable
			// there instead of pointing at a command the caller cannot type.
			return `${label}: could not authenticate this account — sign in again with /login in an interactive veyyon session.`;
		default:
			return `${label}: reset did not apply (${outcome.code}).`;
	}
}
