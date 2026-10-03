import { describe, expect, it } from "bun:test";
import { resolveSessionContextWindow } from "../src/context-window";
import { getBundledChatModels, getBundledModels } from "../src/models";

// Defect: a catalog row advertising 1M (or a 922K ceiling) reached compaction and
// budgeting unclamped, so a session crossed the premium long-context tier or the
// endpoint ceiling. Gap: does not exercise the registry wiring.
describe("resolveSessionContextWindow", () => {
	const astra = { contextWindow: 1_000_000, maxContextWindow: 872_000, longContextCost: { inputThreshold: 272_000 } };

	it("caps at the standard-pricing threshold unless extended context is on", () => {
		expect(resolveSessionContextWindow(astra as never, false)).toBe(272_000);
	});

	it("uses the advertised maximum, never the 1M floor, with extended context", () => {
		expect(resolveSessionContextWindow(astra as never, true)).toBe(872_000);
	});

	it("leaves a row without long-context pricing or a maximum untouched", () => {
		expect(resolveSessionContextWindow({ contextWindow: 200_000 } as never, false)).toBe(200_000);
		expect(resolveSessionContextWindow({ contextWindow: 200_000 } as never, true)).toBe(200_000);
		expect(resolveSessionContextWindow({ contextWindow: null } as never, true)).toBeNull();
	});

	it("never exceeds the maximum even when the threshold is higher", () => {
		expect(
			resolveSessionContextWindow(
				{
					contextWindow: 1_000_000,
					maxContextWindow: 500_000,
					longContextCost: { inputThreshold: 800_000 },
				} as never,
				false,
			),
		).toBe(500_000);
	});
});

describe("getBundledChatModels", () => {
	it("omits the image runner that getBundledModels carries", () => {
		expect(getBundledModels("openai-codex").some(m => m.id === "gpt-image-2")).toBe(true);
		expect(getBundledChatModels("openai-codex").some(m => m.id === "gpt-image-2")).toBe(false);
		expect(getBundledChatModels("openai-codex").length).toBeGreaterThan(0);
	});
});
