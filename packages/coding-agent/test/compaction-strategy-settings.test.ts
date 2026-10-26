import { describe, expect, it } from "bun:test";
import {
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
} from "@veyyon/coding-agent/config/compaction-strategy";
import { resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { resolveAgentModel } from "@veyyon/coding-agent/task/agent-settings";

describe("compaction strategy settings", () => {
	// Every historical strategy token now folds to the sole in-place `summary`
	// strategy. Session transfer is owned only by the explicit `/handoff` command.
	it("normalizes every legacy strategy token to summary", () => {
		for (const strategy of ["snapcompact", "snap", "summary", "context-full", "shake", "handoff", "off"]) {
			expect(normalizeCompactionStrategy(strategy)).toBe("summary");
			expect(migrateCompactionStrategyValue(strategy)).toBe("summary");
		}
	});

	it("migrates persisted compaction.strategy values on settings load", () => {
		for (const strategy of ["snapcompact", "context-full", "shake-summary", "handoff"]) {
			const migrated = Settings.isolated({ "compaction.strategy": strategy });
			expect(migrated.get("compaction.strategy")).toBe("summary");
		}

		const fromOff = Settings.isolated({ "compaction.strategy": "off" });
		expect(fromOff.get("compaction.strategy")).toBe("summary");
		expect(fromOff.get("compaction.enabled")).toBe(false);
	});

	it("offers summary as the only strategy in settings", () => {
		const entry = SETTINGS_SCHEMA["compaction.strategy"];

		expect(entry.type).toBe("enum");
		expect(entry.values).toEqual(["summary"]);
		expect(entry.ui?.options?.map(option => option.value)).toEqual(["summary"]);
	});

	it("normalizes every unrecognized strategy to summary rather than passing it through", () => {
		// The default is deliberate: an unreadable strategy must still compact, so
		// a typo cannot silently leave a session with no context management. It is
		// `summary` and not `handoff` because summarizing in place is the
		// lower-consequence of the two when the intent is unknown.
		for (const unknown of ["shake-summary", "SUMMARY", "handoff ", "archive", "", "snapshot", "0", "true"]) {
			expect(normalizeCompactionStrategy(unknown)).toBe("summary");
		}
		expect(normalizeCompactionStrategy(undefined)).toBe("summary");
	});

	it("maps every known and unknown string to summary", () => {
		const inputs = ["handoff", "summary", "snap", "snapcompact", "context-full", "shake", "off", "nonsense"];
		expect(inputs.map(value => normalizeCompactionStrategy(value))).toEqual(inputs.map(() => "summary"));
	});

	it("migrates compactionModel into compaction.model when unset", () => {
		const settings = Settings.isolated({
			compaction: { compactionModel: "openai/gpt-5" },
		} as Record<string, unknown>);
		expect(settings.get("compaction.model")).toBe("openai/gpt-5");
	});
});

describe("agent and compaction model resolution", () => {
	/**
	 * An agent's own lane outranks its definition's `model:` frontmatter, and
	 * moves that agent alone. The full matrix lives in the agent-model suite;
	 * this keeps the neighbouring compaction case honest company.
	 */
	it("prefers an agent's lane over its frontmatter model", () => {
		const settings = Settings.isolated({
			"agent.agents": { scout: { model: "openai/gpt-5" } },
		} as Parameters<typeof Settings.isolated>[0]);
		const resolved = resolveAgentModel({
			settings,
			agentName: "scout",
			agentModel: "anthropic/claude-sonnet-4-5",
		});
		expect(resolved.source).toBe("lane");
		expect(resolved.patterns[0]).toContain("gpt-5");
	});

	it("reads compaction.model from settings", () => {
		const settings = Settings.isolated({ "compaction.model": "openai/gpt-5" });
		expect(resolveCompactionModelPatterns(settings)).toEqual(["openai/gpt-5"]);
	});
});

describe("model tab compaction UI", () => {
	it("exposes the three compaction fields on the model tab", () => {
		const modelTab = getSettingsForTab("model");
		const paths = modelTab.map(def => def.path);
		expect(paths).toContain("compaction.threshold");
		expect(paths).toContain("compaction.strategy");
		expect(paths).toContain("compaction.model");
	});

	/**
	 * There is EXACTLY ONE row for the compaction trigger.
	 *
	 * Two rows both labelled "Compaction Threshold" (`thresholdTokens` and
	 * `thresholdPercent`) shipped for months: an operator could not tell which was
	 * in force, and editing the wrong one silently did nothing. This asserts on the
	 * visible LABEL, not the path, because the confusion was a label collision —
	 * a future percent/token split under different paths would reproduce it.
	 */
	it("shows exactly one compaction-threshold row, with the retired keys hidden", () => {
		const visible = getSettingsForTab("model");
		const thresholdRows = visible.filter(def => /compaction threshold/i.test(def.label));
		expect(thresholdRows.map(def => def.path)).toEqual(["compaction.threshold"]);

		const paths = visible.map(def => def.path);
		expect(paths).not.toContain("compaction.thresholdTokens");
		expect(paths).not.toContain("compaction.thresholdPercent");
	});

	it("keeps advanced compaction knobs schema-only", () => {
		const visible = getSettingsForTab("model").map(def => def.path);
		expect(visible).not.toContain("compaction.enabled");
		expect(visible).not.toContain("compaction.autoContinue");
	});
});
