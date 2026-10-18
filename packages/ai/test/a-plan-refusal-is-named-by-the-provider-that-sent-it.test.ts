/**
 * WHY: `ModelNotInPlan` was a Cursor-only flag, and the flag's name hid Codex's ChatGPT-account
 * refusal, which is a different sentence about a different entitlement. A caller asking "did the
 * plan refuse this?" had no answer for Codex, and a Cursor-shaped predicate would have accepted
 * Codex's sentence under the provider `cursor`. Class closed: each provider-specific predicate
 * answers only for its own provider's refusal, and the generic account-policy predicate answers for
 * both.
 *
 * Not caught: a refusal sentence neither provider has written yet. It classifies as nothing until a
 * rule names it.
 */
import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";

const CURSOR_REFUSAL = new Error(
	"resource_exhausted: Named models unavailable (ERROR_RATE_LIMITED_CHANGEABLE)",
);
const CODEX_REFUSAL = new Error(
	"The 'gpt-5.1' model is not supported when using Codex with a ChatGPT account.",
);
const CODEX_UNSUPPORTED_MODEL = new Error("The model gpt-5.1 is not supported");
const QUOTA = new Error("You've reached your usage limit. Upgrade to increase your limit.");

describe("a plan refusal is named by the provider that sent it", () => {
	test("Cursor's refusal is a Cursor plan refusal and not a Codex one", () => {
		expect(AIError.isCursorPlanAccountPolicyError(CURSOR_REFUSAL, "cursor")).toBe(true);
		expect(AIError.isCursorPlanAccountPolicyError(CURSOR_REFUSAL, "openai-codex")).toBe(false);
	});

	test("Codex's ChatGPT-account refusal is not a Cursor plan refusal even under the cursor provider", () => {
		expect(AIError.isCursorPlanAccountPolicyError(CODEX_REFUSAL, "cursor")).toBe(false);
	});

	test("Codex's refusal is a Codex account-policy refusal for the model it names, bare or prefixed", () => {
		expect(AIError.isCodexChatGPTAccountPolicyError(CODEX_REFUSAL, "openai-codex", "gpt-5.1")).toBe(true);
		expect(AIError.isCodexChatGPTAccountPolicyError(CODEX_REFUSAL, "openai-codex", "openai/gpt-5.1")).toBe(true);
	});

	test("Codex's refusal does not apply to a different model or another provider", () => {
		expect(AIError.isCodexChatGPTAccountPolicyError(CODEX_REFUSAL, "openai-codex", "gpt-5")).toBe(false);
		expect(AIError.isCodexChatGPTAccountPolicyError(CODEX_REFUSAL, "cursor", "gpt-5.1")).toBe(false);
	});

	test("a generic unsupported-model answer is not Codex's account refusal", () => {
		expect(AIError.isCodexChatGPTAccountPolicyError(CODEX_UNSUPPORTED_MODEL, "openai-codex", "gpt-5.1")).toBe(
			false,
		);
	});

	test("the generic predicate answers for both providers' refusals and not for a spent quota", () => {
		expect(AIError.isAccountPolicyError(CURSOR_REFUSAL)).toBe(true);
		expect(AIError.isAccountPolicyError(CODEX_REFUSAL)).toBe(true);
		expect(AIError.isAccountPolicyError(QUOTA)).toBe(false);
	});
});
