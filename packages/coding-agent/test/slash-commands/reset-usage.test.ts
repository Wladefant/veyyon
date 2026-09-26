import { describe, expect, it } from "bun:test";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "@veyyon/ai/auth-storage";
import {
	describeRedeemOutcome,
	findResetUsageAccount,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "@veyyon/coding-agent/slash-commands/helpers/reset-usage";

/**
 * `/usage reset` builds its account selector and status lines from these two pure
 * helpers, which had ZERO tests. The selector ORDER matters: the active account must
 * be preselected at the top, then the accounts with the most redeemable resets, so a
 * regression in the comparator silently offers the wrong default account to spend a
 * credit on. The outcome mapping must give a distinct, correct message per backend
 * code (and a safe fallback for the open-ended `http_<status>` codes) so a user is
 * never told "reset applied" when nothing happened.
 *
 * These assert the exact row order, the label fallback chain, the redeem target, and
 * every branch of the message map (product strings asserted verbatim).
 */

const status = (over: Partial<ResetCreditAccountStatus>): ResetCreditAccountStatus => ({
	provider: "openai-codex",
	availableCount: 0,
	credits: [],
	active: false,
	...over,
});
const labels = (rows: ResetUsageAccount[]): string[] => rows.map(r => r.label);

describe("toResetUsageAccounts", () => {
	it("orders active-first, then most credits, then label ascending", () => {
		const rows = toResetUsageAccounts([
			status({ email: "b@x.com", availableCount: 1 }),
			status({ accountId: "acc-active", active: true }),
			status({ email: "a@x.com", availableCount: 3 }),
			status({ email: "c@x.com", availableCount: 3 }),
		]);
		expect(labels(rows)).toEqual(["acc-active", "a@x.com", "c@x.com", "b@x.com"]);
	});

	it("labels by email, then accountId, then the literal 'account'", () => {
		const rows = toResetUsageAccounts([
			status({ email: "has@mail.com" }),
			status({ accountId: "acct-123" }),
			status({ error: "token fail" }),
		]);
		// All availableCount 0 and inactive -> tie broken by label ascending.
		expect(labels(rows)).toEqual(["account", "acct-123", "has@mail.com"]);
		expect(rows.find(r => r.label === "account")?.error).toBe("token fail");
	});

	it("carries the redeem target fields through for the selected account", () => {
		const [row] = toResetUsageAccounts([
			status({ email: "e@x.com", accountId: "a1", credentialId: 7, availableCount: 2 }),
		]);
		expect(row.target).toEqual({ provider: "openai-codex", credentialId: 7, accountId: "a1", email: "e@x.com" });
		expect(row.providerName).toBe("OpenAI Codex");
		expect(row.availableCount).toBe(2);
	});

	it("breaks a credit tie between providers by provider id before label", () => {
		const rows = toResetUsageAccounts([
			status({ provider: "openai-codex", email: "a@x.com", availableCount: 1 }),
			status({ provider: "anthropic", email: "z@x.com", availableCount: 1 }),
		]);
		expect(rows.map(r => r.target.provider)).toEqual(["anthropic", "openai-codex"]);
	});
});

describe("findResetUsageAccount", () => {
	const rows = toResetUsageAccounts([
		status({ provider: "openai-codex", email: "me@x.com", accountId: "cx-1", availableCount: 0, active: true }),
		status({ provider: "anthropic", email: "me@x.com", accountId: "an-1", availableCount: 2, active: true }),
		status({ provider: "anthropic", email: "other@x.com", availableCount: 1 }),
	]);
	const pick = (arg: string) => findResetUsageAccount(rows, arg)?.target;

	it("prefers the matching row that has redeemable resets when an email spans providers", () => {
		expect(pick("ME@x.com")).toMatchObject({ provider: "anthropic", accountId: "an-1" });
		expect(pick("active")).toMatchObject({ provider: "anthropic", accountId: "an-1" });
	});

	it("restricts the match to the provider named before the account", () => {
		expect(pick("openai-codex active")).toMatchObject({ provider: "openai-codex", accountId: "cx-1" });
		expect(pick("openai-codex me@x.com")).toMatchObject({ provider: "openai-codex", accountId: "cx-1" });
		expect(pick("openai-codex other@x.com")).toBeUndefined();
	});

	it("matches by account id and returns undefined for an unknown account", () => {
		expect(pick("CX-1")).toMatchObject({ provider: "openai-codex" });
		expect(pick("nobody@x.com")).toBeUndefined();
	});
});

describe("describeRedeemOutcome", () => {
	const message = (code: ResetCreditRedeemOutcome["code"]): string =>
		describeRedeemOutcome({ ok: code === "reset", code, provider: "anthropic" }, "L");

	it("returns a distinct message for every named backend and local code", () => {
		expect(message("reset")).toBe("Reset applied for L — your rate-limit window has been refreshed.");
		expect(message("already_redeemed")).toBe("L: that reset was already redeemed.");
		expect(message("no_credit")).toBe("L: no saved resets available to spend.");
		expect(message("nothing_to_reset")).toBe(
			"L: nothing to reset right now — your limits aren't constrained, so no credit was spent.",
		);
		expect(message("cooldown")).toBe("L: resets are cooling down — try again later. No credit was spent.");
		expect(message("ineligible")).toBe("L: this account is not eligible for usage resets.");
		expect(message("unavailable")).toBe("L: usage resets are unavailable right now. No credit was spent.");
		expect(message("no_organization")).toBe(
			"L: could not determine the account's organization — sign in again with /login in an interactive veyyon session.",
		);
		expect(message("status_unavailable")).toBe("L: could not read the account's reset status. No credit was spent.");
		expect(message("no_account")).toBe('Could not find a stored Anthropic account matching "L".');
		expect(message("account_unavailable")).toBe(
			"L: could not authenticate this account — sign in again with /login in an interactive veyyon session.",
		);
	});

	it("falls back to a safe message that names the unexpected code", () => {
		expect(message("http_500" as ResetCreditRedeemOutcome["code"])).toBe("L: reset did not apply (http_500).");
	});
});
