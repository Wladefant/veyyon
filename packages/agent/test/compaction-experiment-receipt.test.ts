import { describe, expect, it } from "bun:test";
import type { Model, Usage } from "@veyyon/ai";
import { CompactionExperimentMeter, toCompactionScorerRow } from "../src/compaction/experiment-receipt";

const THRESHOLD = 1000;
const TIERED = {
	id: "tiered",
	provider: "fixture",
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, total: 0 },
	longContextCost: { inputThreshold: THRESHOLD, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
} as unknown as Model;
const FLAT = { ...TIERED, id: "flat", longContextCost: undefined } as unknown as Model;
const SHA = "a".repeat(64);
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(parts: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: ZERO_COST,
		...parts,
	};
}

function meter(model: Model = TIERED, arm = "36k-48k"): CompactionExperimentMeter {
	return new CompactionExperimentMeter("case-1", SHA, arm, model);
}

describe("CompactionExperimentMeter construction", () => {
	it("rejects identifiers outside the scorer's formats", () => {
		expect(() => new CompactionExperimentMeter("Case_1", SHA, "baseline", TIERED)).toThrow();
		expect(() => new CompactionExperimentMeter("case-1", "ABC", "baseline", TIERED)).toThrow();
		expect(() => new CompactionExperimentMeter("case-1", SHA, "12k-16k", TIERED)).toThrow();
		expect(
			() => new CompactionExperimentMeter("case-1", SHA, "baseline", { ...TIERED, provider: "a b" } as Model),
		).toThrow();
	});

	it("accepts the preset and numeric arm IDs", () => {
		for (const arm of ["baseline", "36k-48k", "24k-32k", "123-456"]) {
			expect(meter(TIERED, arm).finish(true).arm).toBe(arm);
		}
	});
});

describe("long-context tier boundary", () => {
	it("bills a prompt exactly at the threshold as standard", () => {
		const m = meter();
		m.observe(usage({ input: 500, cacheRead: 300, cacheWrite: 200, output: 10 }));
		const receipt = m.finish(true);
		expect(receipt.long_context_price_tier_splits.long).toBeUndefined();
		expect(receipt.long_context_price_tier_splits.standard.uncached).toBe(500);
	});

	it("bills a prompt one token above the threshold as long", () => {
		const m = meter();
		m.observe(usage({ input: 500, cacheRead: 300, cacheWrite: 201, output: 10 }));
		const receipt = m.finish(true);
		expect(receipt.long_context_price_tier_splits.standard).toEqual({
			uncached: 0,
			cache_read: 0,
			cache_write: 0,
			output: 0,
		});
		expect(receipt.long_context_price_tier_splits.long).toEqual({
			uncached: 500,
			cache_read: 300,
			cache_write: 201,
			output: 10,
		});
	});

	it("counts orchestration prompt tokens toward the threshold", () => {
		const atBoundary = meter();
		atBoundary.observe(usage({ input: 600, orchestration: { input: 400 } }));
		expect(atBoundary.finish(true).long_context_price_tier_splits.long).toBeUndefined();

		const over = meter();
		over.observe(usage({ input: 600, orchestration: { input: 400, cacheRead: 1 } }));
		expect(over.finish(true).long_context_price_tier_splits.long?.cache_read).toBe(1);
	});

	it("never assigns the long tier to a model without a long card", () => {
		const m = meter(FLAT);
		m.observe(usage({ input: 5000, output: 1 }));
		expect(m.finish(true).long_context_price_tier_splits.long).toBeUndefined();
	});
});

describe("totals and receipt shape", () => {
	it("emits exactly the flat keys and splits that sum to the totals", () => {
		const m = meter();
		m.observe(
			usage({
				input: 100,
				cacheRead: 200,
				cacheWrite: 300,
				output: 40,
				orchestration: { input: 5, cacheRead: 6, output: 7 },
			}),
		);
		m.observe(usage({ input: 1200, output: 9 }));
		const receipt = m.finish(true);
		expect(Object.keys(receipt).sort()).toEqual(
			[
				"arm",
				"cache_read_tokens",
				"cache_write_tokens",
				"case_id",
				"compactions",
				"long_context_price_tier_splits",
				"model",
				"output_tokens",
				"peak_context_tokens",
				"settings_sha256",
				"success",
				"uncached_input_tokens",
				"wall_ms",
			].sort(),
		);
		expect(receipt.model).toBe("fixture/tiered");
		expect(receipt.uncached_input_tokens).toBe(100 + 5 + 1200);
		expect(receipt.cache_read_tokens).toBe(200 + 6);
		expect(receipt.cache_write_tokens).toBe(300);
		expect(receipt.output_tokens).toBe(40 + 7 + 9);
	});

	it("reports wall time as a non-negative integer", () => {
		const receipt = meter().finish(false);
		expect(Number.isInteger(receipt.wall_ms)).toBe(true);
		expect(receipt.wall_ms).toBeGreaterThanOrEqual(0);
	});
});

describe("discarded attempts", () => {
	it("bills a single discarded attempt at its own tier and counts its context toward peak", () => {
		const m = meter();
		m.observe(
			usage({
				input: 10,
				output: 1,
				discarded: { attempts: 1, input: 1200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			}),
		);
		const receipt = m.finish(true);
		expect(receipt.long_context_price_tier_splits.long?.uncached).toBe(1200);
		expect(receipt.uncached_input_tokens).toBe(1210);
		expect(receipt.peak_context_tokens).toBe(1200);
	});

	it("bills several discarded attempts whose aggregate stays under the threshold as standard", () => {
		const m = meter();
		m.observe(
			usage({
				input: 10,
				discarded: { attempts: 2, input: 300, output: 0, cacheRead: 300, cacheWrite: 300, cost: 0 },
			}),
		);
		const receipt = m.finish(true);
		expect(receipt.long_context_price_tier_splits.long).toBeUndefined();
		expect(receipt.cache_read_tokens).toBe(300);
	});

	it("gates several discarded attempts whose aggregate may straddle the threshold", () => {
		const m = meter();
		m.observe(
			usage({
				input: 10,
				discarded: { attempts: 2, input: 800, output: 0, cacheRead: 400, cacheWrite: 0, cost: 0 },
			}),
		);
		expect(() => m.finish(true)).toThrow(/gated/);
	});

	it("does not count several discarded attempts toward peak", () => {
		const m = meter();
		m.observe(
			usage({
				input: 100,
				output: 5,
				discarded: { attempts: 2, input: 400, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 },
			}),
		);
		expect(m.finish(true).peak_context_tokens).toBe(105);
	});

	it("rejects discarded tokens that carry no attempts", () => {
		expect(() =>
			meter().observe(
				usage({ discarded: { attempts: 0, input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
			),
		).toThrow();
	});
});

describe("peak context", () => {
	it("keeps the largest single billed request including its output", () => {
		const m = meter();
		m.observe(usage({ input: 100, cacheRead: 100, cacheWrite: 100, output: 100 }));
		m.observe(usage({ input: 50, cacheRead: 50, output: 900 }));
		expect(m.finish(true).peak_context_tokens).toBe(1000);
	});
});

describe("run lifecycle and grading", () => {
	it("records compactions and the grader's success verdict", () => {
		const m = meter();
		m.noteCompaction();
		m.noteCompaction();
		const receipt = m.finish(false);
		expect(receipt.compactions).toBe(2);
		expect(receipt.success).toBe(false);
	});

	it("refuses observations and a second finish after finish", () => {
		const m = meter();
		m.finish(true);
		expect(() => m.observe(usage({ input: 1 }))).toThrow();
		expect(() => m.finish(true)).toThrow();
		expect(() => m.noteCompaction()).toThrow();
	});
});

describe("scorer projection", () => {
	it("emits exactly the scorer's sample keys", () => {
		const m = meter(TIERED, "24k-32k");
		m.observe(usage({ input: 1200, output: 3 }));
		const row = toCompactionScorerRow(m.finish(true));
		expect(Object.keys(row).sort()).toEqual([
			"arm",
			"case",
			"compactions",
			"peak_context",
			"success",
			"tokens",
			"wall_ms",
		]);
		expect(row.case).toBe("case-1");
		expect(row.arm).toBe("24k-32k");
		expect(row.peak_context).toBe(1203);
		expect(row.tokens.standard).toEqual({ uncached: 0, cache_read: 0, cache_write: 0, output: 0 });
		expect(row.tokens.long).toEqual({ uncached: 1200, cache_read: 0, cache_write: 0, output: 3 });
	});

	it("maps a numeric receipt arm to a native preset with armOverride", () => {
		const receipt = meter(TIERED, "123-456").finish(true);
		expect(() => toCompactionScorerRow(receipt)).toThrow();
		expect(toCompactionScorerRow(receipt, "36k-48k").arm).toBe("36k-48k");
	});

	it("allows A/A labels only for baseline receipts", () => {
		const baseline = meter(TIERED, "baseline").finish(true);
		expect(toCompactionScorerRow(baseline, "aa3").arm).toBe("aa3");
		expect(() => toCompactionScorerRow(baseline, "36k-48k")).toThrow();
		const treatment = meter(TIERED, "36k-48k").finish(true);
		expect(() => toCompactionScorerRow(treatment, "aa3")).toThrow();
	});

	it("rejects receipts with extra fields or splits that disagree with totals", () => {
		const receipt = meter(TIERED, "baseline").finish(true);
		expect(() => toCompactionScorerRow({ ...receipt, prompt: "secret" } as never)).toThrow();
		expect(() => toCompactionScorerRow({ ...receipt, uncached_input_tokens: 1 })).toThrow();
	});
});
