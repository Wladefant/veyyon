/**
 * WHY. Model target selection was seven private members on `AgentSession`, and the only suites that
 * reached them drove a whole session through a compaction. That left branches nobody could see: a
 * mutation dropping the provider from the dedup key, and a mutation counting `auto` as an explicit
 * thinking effort, both stayed green against the entire compaction bucket. Those are not exotic
 * edits — they are what a reader shortening `` `${provider}/${id}` `` to `id`, or simplifying a
 * three-clause condition, would write.
 *
 * THE CLASS THIS CLOSES. A decision that reads only its arguments, kept where only an integration
 * test can reach it. Extracting the family to
 * `packages/coding-agent/src/session/agent-session-model-targets.ts` is half the fix; this suite is
 * the other half. It pins each decision at the boundary every caller passes through, so a candidate
 * list, a dedup, an effort map or a bare-id lookup is checkable without constructing a session.
 *
 * The decisions defended here:
 *   - a model's identity carries its provider, so one id published by two providers is two models;
 *   - `auto` is the absence of an explicit effort, not an effort named `auto`;
 *   - a bare configured id resolves inside the CURRENT model's provider, never into whichever
 *     provider happens to publish that id;
 *   - `configured-only` stops at the chain that was written down;
 *   - a cross-provider recommendation is spending an account nobody chose, so `auto` refuses it and
 *     `any-model` takes it.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about whether a chosen model can actually summarize —
 * auth, capacity and payload size are the compaction suites' subject, and
 * `a-payload-too-large-for-every-summarizer-is-cut-not-parked.test.ts` owns the dead-end floor. It
 * pins the candidate ORDER only where order is a decision (the configured chain first, the widest
 * window last); it does not pin the relative order of two role models.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	compactionModelCandidates,
	configuredCompactionEfforts,
	configuredModelTarget,
	modelKey,
} from "@veyyon/coding-agent/session/agent-session-model-targets";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";

useIsolatedGlobalSettings();

const BASE = getBundledModel("anthropic", "claude-sonnet-4-5");

/**
 * A model that exists only for this suite. Built from a real bundled row so every field the
 * resolver reads is populated the way production populates it, with the few this suite is about
 * overridden by name.
 */
function model(
	provider: string,
	id: string,
	overrides: { contextWindow?: number; compactionModel?: string } = {},
): Model<Api> {
	return {
		...BASE,
		provider,
		id,
		name: id,
		contextWindow: overrides.contextWindow ?? BASE.contextWindow,
		compactionModel: overrides.compactionModel,
	} as Model<Api>;
}

let settings: Settings;

beforeEach(async () => {
	settings = await Settings.init({ inMemory: true });
	settings.set("compaction.model", "");
	settings.set("compaction.modelFallbackStrategy", "auto");
});

describe("a model's identity", () => {
	it("carries the provider, so one id from two providers is two models", () => {
		const fromAnthropic = model("anthropic", "claude-sonnet-4-5");
		const fromBedrock = model("amazon-bedrock", "claude-sonnet-4-5");

		expect(modelKey(fromAnthropic)).not.toBe(modelKey(fromBedrock));

		settings.set("compaction.modelFallbackStrategy", "any-model");
		const candidates = compactionModelCandidates(settings, fromAnthropic, [fromAnthropic, fromBedrock]);

		// The dedup runs over both. Collapsing the key to the bare id drops one.
		expect(candidates.map(modelKey)).toEqual(["anthropic/claude-sonnet-4-5", "amazon-bedrock/claude-sonnet-4-5"]);
	});

	it("is stable enough to dedup a model named twice, keeping the position it first earned", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		const other = model("anthropic", "claude-haiku-4-5");
		settings.set("compaction.model", "anthropic/claude-haiku-4-5, anthropic/claude-haiku-4-5");
		settings.set("compaction.modelFallbackStrategy", "configured-only");

		expect(compactionModelCandidates(settings, main, [main, other]).map(modelKey)).toEqual([
			"anthropic/claude-haiku-4-5",
		]);
	});
});

describe("a configured effort", () => {
	it("is recorded when the selector names a level", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		settings.set("compaction.model", "anthropic/claude-sonnet-4-5:high");

		expect(configuredCompactionEfforts(settings, [main]).get("anthropic/claude-sonnet-4-5")).toBe(ThinkingLevel.High);
	});

	it("is absent when the selector says auto, because auto is the absence of a level", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		settings.set("compaction.model", "anthropic/claude-sonnet-4-5:auto");

		const efforts = configuredCompactionEfforts(settings, [main]);

		// An entry here — of any value, including the string "auto" — makes compact() apply a
		// level nobody chose instead of the session's own effort.
		expect(efforts.has("anthropic/claude-sonnet-4-5")).toBe(false);
		expect(efforts.size).toBe(0);
	});

	it("is absent when no chain is configured at all", () => {
		expect(configuredCompactionEfforts(settings, [model("anthropic", "claude-sonnet-4-5")]).size).toBe(0);
	});
});

describe("a configured target naming a bare id", () => {
	it("resolves inside the current model's provider", () => {
		const current = model("openai", "shared-id");
		const elsewhere = model("anthropic", "shared-id");

		expect(configuredModelTarget("shared-id", current, [elsewhere, current])).toBe(current);
	});

	it("resolves to nothing when the current provider does not publish it", () => {
		const current = model("openai", "gpt-5");
		const elsewhere = model("anthropic", "shared-id");

		expect(configuredModelTarget("shared-id", current, [elsewhere, current])).toBeUndefined();
	});

	it("resolves a fully qualified target across providers, because that names one", () => {
		const current = model("openai", "gpt-5");
		const elsewhere = model("anthropic", "claude-haiku-4-5");

		expect(configuredModelTarget("anthropic/claude-haiku-4-5", current, [current, elsewhere])).toBe(elsewhere);
	});
});

describe("the fallback strategy", () => {
	it("stops at the configured chain under configured-only", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		const cheap = model("anthropic", "claude-haiku-4-5");
		const wide = model("google", "gemini-3-pro", { contextWindow: 2_000_000 });
		settings.set("compaction.model", "anthropic/claude-haiku-4-5");
		settings.set("compaction.modelFallbackStrategy", "configured-only");

		expect(compactionModelCandidates(settings, main, [main, cheap, wide]).map(modelKey)).toEqual([
			"anthropic/claude-haiku-4-5",
		]);
	});

	it("falls back to the one chosen model under configured-only with no chain written down", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		const wide = model("google", "gemini-3-pro", { contextWindow: 2_000_000 });
		settings.set("compaction.modelFallbackStrategy", "configured-only");

		expect(compactionModelCandidates(settings, main, [main, wide]).map(modelKey)).toEqual([
			"anthropic/claude-sonnet-4-5",
		]);
	});

	it("refuses a cross-provider recommendation under auto, because nobody chose that account", () => {
		const main = model("anthropic", "claude-sonnet-4-5", { compactionModel: "google/gemini-3-flash" });
		const recommended = model("google", "gemini-3-flash");

		const candidates = compactionModelCandidates(settings, main, [main, recommended]);

		expect(candidates.map(modelKey)).not.toContain("google/gemini-3-flash");
		expect(candidates.map(modelKey)[0]).toBe("anthropic/claude-sonnet-4-5");
	});

	it("takes a same-provider recommendation under auto, ahead of the model itself", () => {
		const main = model("anthropic", "claude-sonnet-4-5", { compactionModel: "anthropic/claude-haiku-4-5" });
		const recommended = model("anthropic", "claude-haiku-4-5");

		expect(compactionModelCandidates(settings, main, [main, recommended]).map(modelKey)[0]).toBe(
			"anthropic/claude-haiku-4-5",
		);
	});

	it("takes a cross-provider recommendation under any-model, which is the opt-in for it", () => {
		const main = model("anthropic", "claude-sonnet-4-5", { compactionModel: "google/gemini-3-flash" });
		const recommended = model("google", "gemini-3-flash");
		settings.set("compaction.modelFallbackStrategy", "any-model");

		expect(compactionModelCandidates(settings, main, [main, recommended]).map(modelKey)[0]).toBe(
			"google/gemini-3-flash",
		);
	});

	it("reaches every authenticated model widest-first under any-model, so one dead row cannot end it", () => {
		const main = model("anthropic", "claude-sonnet-4-5", { contextWindow: 200_000 });
		const widest = model("google", "gemini-3-pro", { contextWindow: 2_000_000 });
		const middle = model("openai", "gpt-5", { contextWindow: 400_000 });
		settings.set("compaction.modelFallbackStrategy", "any-model");

		const keys = compactionModelCandidates(settings, main, [main, middle, widest]).map(modelKey);

		expect(keys[0]).toBe("anthropic/claude-sonnet-4-5");
		expect(keys.slice(1)).toEqual(["google/gemini-3-pro", "openai/gpt-5"]);
	});

	it("honours a filter, so a model that cannot be reached is never proposed", () => {
		const main = model("anthropic", "claude-sonnet-4-5");
		const wide = model("google", "gemini-3-pro", { contextWindow: 2_000_000 });
		settings.set("compaction.modelFallbackStrategy", "any-model");

		const keys = compactionModelCandidates(settings, main, [main, wide], m => m.provider !== "google").map(modelKey);

		expect(keys).toEqual(["anthropic/claude-sonnet-4-5"]);
	});
});
