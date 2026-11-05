import { describe, expect, it } from "bun:test";
import { executeUsageResetCommand } from "../src/cli/usage-reset-cli";
import { validateUsageResetOptions } from "../src/cli/usage-reset-options";

describe("usage reset CLI options", () => {
	it("accepts listing or one positive safe-integer credential id for OpenAI Codex JSON output", () => {
		expect(validateUsageResetOptions({ resetCredits: true, provider: "openai-codex", json: true })).toEqual({
			mode: "list",
			provider: "openai-codex",
		});
		expect(validateUsageResetOptions({ redeem: "42", provider: "openai-codex", json: true })).toEqual({
			mode: "redeem",
			provider: "openai-codex",
			credentialId: 42,
		});
	});

	it("rejects missing, malformed, conflicting and non-OpenAI reset requests", () => {
		for (const options of [
			{ redeem: "" },
			{ redeem: "0" },
			{ redeem: "1.5" },
			{ redeem: "1e2" },
			{ redeem: "42,43" },
			{ redeem: "9007199254740992" },
			{ resetCredits: true, redeem: "42" },
			{ redeem: "42", provider: "anthropic" },
			{ redeem: "42", history: true },
		]) {
			expect(() => validateUsageResetOptions(options)).toThrow();
		}
	});
	it("returns the accounts envelope and targets redemption by the exact Codex credential ID", async () => {
		const calls: unknown[] = [];
		const authStorage = {
			async listResetCredits(options: { provider: "openai-codex" }) {
				calls.push(["list", options]);
				return [];
			},
			async redeemResetCredit(options: { target: { provider: "openai-codex"; credentialId: number } }) {
				calls.push(["redeem", options]);
				return { ok: false, code: "no_account", provider: options.target.provider };
			},
		};
		expect(await executeUsageResetCommand(authStorage, { mode: "list", provider: "openai-codex" })).toEqual({
			accounts: [],
		});
		expect(
			await executeUsageResetCommand(authStorage, {
				mode: "redeem",
				provider: "openai-codex",
				credentialId: 42,
			}),
		).toEqual({ ok: false, code: "no_account", provider: "openai-codex" });
		expect(calls).toEqual([
			["list", { provider: "openai-codex" }],
			["redeem", { target: { provider: "openai-codex", credentialId: 42 } }],
		]);
	});
});
