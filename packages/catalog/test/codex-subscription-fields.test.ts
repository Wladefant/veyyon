// WHY: the Codex subscription fields (1M floor, extended-context ceiling, long-context
// pricing, tier multipliers, free cache writes, gpt-image-2) were missing from the
// catalog. Not caught: live endpoint values, which discovery tests cover.
import { describe, expect, it } from "bun:test";
import {
	CODEX_IMAGE_MODEL,
	codexContextWindowFloor,
	codexCostPatch,
	codexLongContextCost,
	codexServiceTierCost,
	resolveCodexMaxContextWindow,
} from "@veyyon/catalog/provider-models/codex-subscription";

describe("Codex subscription fields", () => {
	it("floors only the gpt-5.6 luna/sol/terra SKUs to 1M", () => {
		expect(codexContextWindowFloor("gpt-5.6-sol")).toBe(1_000_000);
		expect(codexContextWindowFloor("gpt-5.5")).toBeUndefined();
		expect(codexContextWindowFloor("gpt-daybreak-blue-latest")).toBeUndefined();
		expect(codexContextWindowFloor("constructor")).toBeUndefined();
	});

	it("takes the larger of the live and curated extended-context maximum", () => {
		expect(resolveCodexMaxContextWindow("gpt-6-astra", undefined)).toBe(922_000);
		expect(resolveCodexMaxContextWindow("gpt-6-astra", 872_000)).toBe(922_000);
		expect(resolveCodexMaxContextWindow("gpt-6-astra", 1_000_000)).toBe(1_000_000);
		expect(resolveCodexMaxContextWindow("gpt-5.5", undefined)).toBeUndefined();
	});

	it("prices priority at 2.5x for gpt-5.5 and astra and 2x elsewhere, flex at half", () => {
		expect(codexServiceTierCost("gpt-5.5")).toEqual({ flex: 0.5, priority: 2.5 });
		expect(codexServiceTierCost("gpt-6-astra")).toEqual({ flex: 0.5, priority: 2.5 });
		expect(codexServiceTierCost("gpt-5.6-sol")).toEqual({ flex: 0.5, priority: 2 });
	});

	it("bills subscription GPT-6 cache writes at zero and Daybreak blue at its rate card", () => {
		expect(codexCostPatch("gpt-6-sol")?.cacheWrite).toBe(0);
		expect(codexCostPatch("gpt-daybreak-blue-latest")).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(codexCostPatch("gpt-5.5")).toBeUndefined();
	});

	it("applies the 272K long-context card to GPT-5.6 families, bare and variant ids", () => {
		expect(codexLongContextCost("gpt-5.6")?.input).toBe(10);
		expect(codexLongContextCost("gpt-5.6-sol-pro")?.inputThreshold).toBe(272_000);
		expect(codexLongContextCost("gpt-5.6-terra")?.input).toBe(4);
		expect(codexLongContextCost("gpt-5.5")).toBeUndefined();
	});

	it("seeds gpt-image-2 as a non-chat image runner", () => {
		expect(CODEX_IMAGE_MODEL.id).toBe("gpt-image-2");
		expect(CODEX_IMAGE_MODEL.kind).toBe("image");
	});
});
