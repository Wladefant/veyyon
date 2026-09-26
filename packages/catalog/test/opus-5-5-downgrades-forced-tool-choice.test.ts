/**
 * WHY: Claude Opus 5.5 rejects `tool_choice` of type `tool` or `any` with
 * 400 invalid_request_error ("type \"tool\" and \"any\" are not supported
 * for this model"), exactly like Fable/Mythos. The catalog must resolve
 * `supportsForcedToolChoice: false` so transports downgrade forced tool
 * choice to `auto` instead of failing the request.
 *
 * Negative control: for models that accept forced tool choice (e.g. Opus 4.8),
 * `supportsForcedToolChoice` must remain `true`.
 */

import { describe, expect, test } from "bun:test";
import { isAnthropicOpus55Model } from "@veyyon/catalog/identity";
import { getBundledModel } from "@veyyon/catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@veyyon/catalog/provider-models";
import type { ResolvedAnthropicCompat } from "@veyyon/catalog/types";

describe("Claude Opus 5.5 catalog metadata and tool choice compat", () => {
	test("identifies Opus 5.5 variants across dotted, dashed, namespaced, and Bedrock ids", () => {
		expect(isAnthropicOpus55Model("claude-opus-5-5")).toBe(true);
		expect(isAnthropicOpus55Model("claude-opus-5.5")).toBe(true);
		expect(isAnthropicOpus55Model("us.anthropic.claude-opus-5-5")).toBe(true);
		expect(isAnthropicOpus55Model("anthropic/claude-opus-5.5")).toBe(true);

		// Non-Opus 5.5 models must not match
		expect(isAnthropicOpus55Model("claude-opus-4-8")).toBe(false);
		expect(isAnthropicOpus55Model("claude-opus-4-7")).toBe(false);
		expect(isAnthropicOpus55Model("claude-sonnet-5")).toBe(false);
		expect(isAnthropicOpus55Model("claude-fable-5-1")).toBe(false);
		// Separator-collapsed revision 45 is Opus 4.5, not 5.5
		expect(isAnthropicOpus55Model("claude-opus-45")).toBe(false);
	});
	test("downgrades forced tool choice for Opus 5.5 but preserves it for Opus 4.8 (negative control)", () => {
		const opus55 = getBundledModel("anthropic", "claude-opus-5-5");
		if (!opus55) throw new Error("expected bundled anthropic/claude-opus-5-5");
		const compat55 = opus55.compat as ResolvedAnthropicCompat;
		expect(compat55.supportsForcedToolChoice).toBe(false);

		// Negative control: Opus 4.8 supports forced tool choice
		const opus48 = getBundledModel("anthropic", "claude-opus-4-8");
		if (!opus48) throw new Error("expected bundled anthropic/claude-opus-4-8");
		const compat48 = opus48.compat as ResolvedAnthropicCompat;
		expect(compat48.supportsForcedToolChoice).toBe(true);
	});

	test("retains Opus 4.7+ API restrictions and mid-conversation system support for Opus 5.5", () => {
		const opus55 = getBundledModel("anthropic", "claude-opus-5-5");
		if (!opus55) throw new Error("expected bundled anthropic/claude-opus-5-5");
		const compat55 = opus55.compat as ResolvedAnthropicCompat;
		expect(compat55.supportsMidConversationSystem).toBe(true);
		expect(compat55.supportsSamplingParams).toBe(false);
	});

	test("promotes default models for anthropic, amazon-bedrock, and litellm to Opus 5.5", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.anthropic).toBe("claude-opus-5-5");
		expect(DEFAULT_MODEL_PER_PROVIDER["amazon-bedrock"]).toBe("us.anthropic.claude-opus-5-5");
		expect(DEFAULT_MODEL_PER_PROVIDER.litellm).toBe("claude-opus-5-5");
	});
});
