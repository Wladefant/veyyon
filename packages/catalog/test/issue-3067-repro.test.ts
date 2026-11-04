/**
 * Antigravity serves Claude 4.6 asymmetrically: Sonnet only as the bare `claude-sonnet-4-6` and Opus only
 * as `claude-opus-4-6-thinking`. Routing Sonnet to the dead `-thinking` id, or Opus to the dead bare id,
 * fails every turn (issue #3067). The routing comes from the collapse table, so it is tested there with
 * the ids discovery lists rather than through bundled rows, which follow whatever the endpoint serves.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { resolveWireModelId } from "@veyyon/catalog/model-thinking";
import type { ModelSpec } from "@veyyon/catalog/types";
import { ANTIGRAVITY_VARIANT_COLLAPSE_TABLE, collapseEffortVariants } from "@veyyon/catalog/variant-collapse";

const EFFORTS = [undefined, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const;

function listed(id: string): ModelSpec<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function collapsedModel(ids: readonly string[], logicalId: string) {
	const out = collapseEffortVariants(ids.map(listed), ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
	const spec = out.find(candidate => candidate.id === logicalId);
	expect(spec, `${logicalId} did not collapse`).toBeDefined();
	return buildModel(spec as ModelSpec<"google-gemini-cli">);
}

describe("issue #3067 — Antigravity Claude 4.6 wire-id routing", () => {
	it("never routes Sonnet 4.6 to the dead `claude-sonnet-4-6-thinking` wire id", () => {
		for (const ids of [["claude-sonnet-4-6"], ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"]]) {
			const model = collapsedModel(ids, "claude-sonnet-4-6");
			for (const effort of EFFORTS) expect(resolveWireModelId(model, effort)).toBe("claude-sonnet-4-6");
		}
	});

	it("routes Opus 4.6 to the live `claude-opus-4-6-thinking` wire id for every effort", () => {
		for (const ids of [["claude-opus-4-6-thinking"], ["claude-opus-4-6", "claude-opus-4-6-thinking"]]) {
			const model = collapsedModel(ids, "claude-opus-4-6");
			for (const effort of EFFORTS) expect(resolveWireModelId(model, effort)).toBe("claude-opus-4-6-thinking");
		}
	});
});
