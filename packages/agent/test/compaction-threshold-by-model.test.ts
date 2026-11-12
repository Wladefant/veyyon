import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	resolveThresholdWithOrigin,
} from "@veyyon/agent-core/compaction/threshold";

const WINDOW = 200_000;
const withReserve = (over: Partial<CompactionSettings> = {}): CompactionSettings => ({
	...DEFAULT_COMPACTION_SETTINGS,
	reserveTokens: 40_000,
	...over,
});

const resolve = (settings: Partial<CompactionSettings>) => resolveThresholdWithOrigin(WINDOW, withReserve(settings));

describe("per-model compaction thresholds", () => {
	it("prefers an exact model entry to a matching glob", () => {
		expect(resolve({ activeModelId: "anthropic/claude-sonnet", threshold: "80%", thresholdByModel: {
			"anthropic/*": "50%",
			"anthropic/claude-sonnet": "25%",
		} }).tokens).toBe(50_000);
	});

	it("uses a matching glob instead of the base threshold", () => {
		expect(resolve({ activeModelId: "anthropic/claude-sonnet", threshold: "80%", thresholdByModel: {
			"anthropic/*": "50%",
		} }).tokens).toBe(100_000);
	});

	it("selects the glob with the most literal characters", () => {
		expect(resolve({ activeModelId: "anthropic/claude-sonnet-4", thresholdByModel: {
			"anthropic/*": "40%",
			"anthropic/claude-*": "60%",
		} }).tokens).toBe(120_000);
	});

	it("breaks equal-specificity glob ties by lexical pattern order", () => {
		expect(resolve({ activeModelId: "anthropic/claude-sonnet", thresholdByModel: {
			"anthropic/*-sonnet": "30%",
			"anthropic/claude-*": "60%",
		} }).tokens).toBe(60_000);
	});

	it("matches question-mark wildcards", () => {
		expect(resolve({ activeModelId: "openai/gpt-5", thresholdByModel: { "openai/gpt-?": "35%" } }).tokens).toBe(70_000);
	});

	it("falls back to the base threshold for an unknown model", () => {
		expect(resolve({ activeModelId: "unknown/model", threshold: "75%", thresholdByModel: { "anthropic/*": "25%" } }).tokens).toBe(150_000);
	});

	it("falls back to the base threshold when there is no active model identity", () => {
		expect(resolve({ threshold: "75%", thresholdByModel: { "anthropic/*": "25%" } }).tokens).toBe(150_000);
	});

	it("resolves percent and absolute entries per model", () => {
		expect(resolve({ activeModelId: "percent-model", thresholdByModel: { "percent-model": "25%" } }).tokens).toBe(50_000);
		expect(resolve({ activeModelId: "fixed-model", thresholdByModel: { "fixed-model": "42000" } }).tokens).toBe(42_000);
	});

	it("does not apply retired thresholds when the selected entry is auto", () => {
		const resolved = resolve({
			activeModelId: "model-a",
			threshold: "80%",
			thresholdByModel: { "model-a": "auto" },
			thresholdTokens: 50_000,
			thresholdPercent: 25,
		});
		expect(resolved).toMatchObject({ tokens: 160_000, origin: "auto" });
		expect(resolved.legacyKey).toBeUndefined();
	});

	it("preserves the auto ceiling for an oversized absolute per-model value", () => {
		expect(resolve({ activeModelId: "small-window-model", thresholdByModel: { "small-window-model": "500000" } }))
			.toMatchObject({ tokens: 160_000, origin: "tokens", clamped: true, configured: 500_000 });
	});
});
