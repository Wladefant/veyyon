import { describe, expect, it } from "bun:test";
import {
	FIREWORKS_FAST_SUFFIX,
	isFireworksFastModelId,
	toFirepassPublicModelId,
	toFirepassWireModelId,
	toFireworksBaseModelId,
	toFireworksPublicModelId,
	toFireworksWireModelId,
} from "../src/fireworks-model-id";
import { getBundledModels } from "../src/models";
import { buildFireworksFastSeed } from "../src/provider-models/openai-compat";

describe("fireworks wire/public id translation", () => {
	it("round-trips version dots through the p-encoded wire form", () => {
		expect(toFireworksWireModelId("kimi-k2.6")).toBe("accounts/fireworks/models/kimi-k2p6");
		expect(toFireworksPublicModelId("accounts/fireworks/models/kimi-k2p6")).toBe("kimi-k2.6");
		expect(toFireworksPublicModelId(toFireworksWireModelId("glm-5.1"))).toBe("glm-5.1");
	});

	it("only rewrites digit-p-digit, not letter p", () => {
		expect(toFireworksWireModelId("deepseek-prover")).toBe("accounts/fireworks/models/deepseek-prover");
		expect(toFireworksPublicModelId("accounts/fireworks/models/deepseek-prover")).toBe("deepseek-prover");
	});

	it("is idempotent when given an already-wire-form id", () => {
		expect(toFireworksWireModelId("accounts/fireworks/models/kimi-k2p6")).toBe("accounts/fireworks/models/kimi-k2p6");
	});

	it("firepass ids use the routers namespace with the same p-encoding", () => {
		expect(toFirepassWireModelId("kimi-k2.6-turbo")).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
		expect(toFirepassPublicModelId("accounts/fireworks/routers/kimi-k2p6-turbo")).toBe("kimi-k2.6-turbo");
		expect(toFirepassWireModelId("accounts/fireworks/routers/kimi-k2p6-turbo")).toBe(
			"accounts/fireworks/routers/kimi-k2p6-turbo",
		);
	});
});

describe("fireworks fast id helpers", () => {
	it("detects the -fast serving-path suffix", () => {
		expect(FIREWORKS_FAST_SUFFIX).toBe("-fast");
		expect(isFireworksFastModelId("kimi-k2.6-fast")).toBe(true);
		expect(isFireworksFastModelId("glm-5.1-fast")).toBe(true);
		expect(isFireworksFastModelId("kimi-k2.6")).toBe(false);
		expect(isFireworksFastModelId("kimi-k2.7-code")).toBe(false);
	});

	it("recovers the base id and is idempotent on non-fast ids", () => {
		expect(toFireworksBaseModelId("kimi-k2.6-fast")).toBe("kimi-k2.6");
		expect(toFireworksBaseModelId("kimi-k2.7-code-fast")).toBe("kimi-k2.7-code");
		expect(toFireworksBaseModelId("glm-5.1-fast")).toBe("glm-5.1");
		expect(toFireworksBaseModelId("kimi-k2.6")).toBe("kimi-k2.6");
	});
});

describe("buildFireworksFastSeed", () => {
	const seed = buildFireworksFastSeed();
	const byId = new Map(seed.map(model => [model.id, model]));

	it("emits one fireworks fast variant per curated base", () => {
		expect([...byId.keys()].sort()).toEqual(["glm-5.1-fast", "kimi-k2.6-fast", "kimi-k2.7-code-fast"]);
		for (const model of seed) {
			expect(model.provider).toBe("fireworks");
			expect(isFireworksFastModelId(model.id)).toBe(true);
		}
	});

	it("overrides cost with the Fast pricing and zeroes cache-write", () => {
		expect(byId.get("kimi-k2.6-fast")?.cost).toEqual({ input: 2, output: 8, cacheRead: 0.3, cacheWrite: 0 });
		expect(byId.get("kimi-k2.7-code-fast")?.cost).toEqual({ input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 });
		expect(byId.get("glm-5.1-fast")?.cost).toEqual({ input: 2.8, output: 8.8, cacheRead: 0.52, cacheWrite: 0 });
	});

	it("inherits limits and modalities from the base model", () => {
		const bundled = getBundledModels("fireworks");
		for (const fast of seed) {
			const baseId = toFireworksBaseModelId(fast.id);
			const base = bundled.find(model => model.id === baseId);
			if (!base) {
				throw new Error(`Missing bundled Fireworks model: ${baseId}`);
			}
			expect(fast.input).toEqual(base.input);
			expect(fast.contextWindow).toBe(base.contextWindow);
			expect(fast.maxTokens).toBe(base.maxTokens);
			expect(fast.reasoning).toBe(base.reasoning);
		}
	});
});
