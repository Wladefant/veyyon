import { describe, expect, it } from "bun:test";
import { getBundledModels } from "@veyyon/catalog/models";
import { getCodexServiceTierCostMultiplier } from "../src/providers/openai-codex-responses";

// Defect: the multiplier was hard-coded by model id, ignoring the catalog's serviceTierCost.
// Gap: does not drive a full stream; only the billing multiplier.
describe("getCodexServiceTierCostMultiplier", () => {
	const astra = getBundledModels("openai-codex").find(m => m.id === "gpt-6-astra");

	it("bills gpt-6-astra priority at the catalog's 2.5", () => {
		expect(astra?.serviceTierCost?.priority).toBe(2.5);
		expect(getCodexServiceTierCostMultiplier(astra as never, "priority")).toBe(2.5);
	});

	it("keeps historical rates for a model without serviceTierCost", () => {
		expect(getCodexServiceTierCostMultiplier({ id: "other" }, "priority")).toBe(2);
		expect(getCodexServiceTierCostMultiplier({ id: "gpt-5.5" }, "priority")).toBe(2.5);
		expect(getCodexServiceTierCostMultiplier({ id: "other" }, "flex")).toBe(0.5);
		expect(getCodexServiceTierCostMultiplier({ id: "other" }, "default")).toBe(1);
	});
});
