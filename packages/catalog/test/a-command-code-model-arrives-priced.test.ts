/**
 * WHY: Command Code's `/provider/v1/models` answers an id, a name and a context
 * length, and nothing else. Discovery mapped that response straight into the
 * catalog, so all 69 served models arrived at zero cost, with no reasoning
 * surface and no output cap, and a session against a $10/M model reported no
 * spend at all. Three of them were bundled with hand-written prices; the other
 * 66 were not bundled at all.
 *
 * The class this closes is "a served model reaches the catalog without the half
 * of its metadata the endpoint does not publish". It is closed by sweeping the
 * bundled provider rows at run time rather than naming models: every row must
 * carry a price verdict, an output ceiling and a reasoning answer, so a model
 * added to the deployment contract without one turns this red, and so does a
 * bundled row the contract forgot.
 *
 * What it does not catch: live upstream drift. The rates here are a snapshot of
 * the published price list, and a change upstream is invisible until someone
 * re-reads it. Nothing in the repo can see that without a network call, which a
 * test must not make.
 */
import { describe, expect, test } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { calculateCost, getBundledModels, getModelPricing } from "@veyyon/catalog/models";
import {
	applyCommandCodeContract,
	COMMAND_CODE_COSTS,
	COMMAND_CODE_DEFAULT_MAX_TOKENS,
	COMMAND_CODE_EFFORTS,
	COMMAND_CODE_FREE_MODELS,
	COMMAND_CODE_LIMITS,
	COMMAND_CODE_LONG_CONTEXT_COSTS,
} from "@veyyon/catalog/provider-models/command-code";
import type { Model, ModelSpec, Usage } from "@veyyon/catalog/types";

function bundled() {
	return getBundledModels("command-code");
}

function servedSpec(id: string): ModelSpec<"openai-completions"> {
	return applyCommandCodeContract({
		id,
		name: id,
		api: "openai-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: null,
	});
}

function usage(fields: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...fields,
	};
}

describe("a Command Code model arrives priced", () => {
	test("every bundled row states a price rather than defaulting to zero", () => {
		const models = bundled();
		expect(models.length).toBeGreaterThan(60);
		const unpriced = models.filter(model => getModelPricing(model) === "unpriced").map(model => model.id);
		expect(unpriced).toEqual([]);
	});

	test("the only zero-cost rows are the ones the provider gives away", () => {
		const free = bundled()
			.filter(model => model.cost.input === 0 && model.cost.output === 0)
			.map(model => model.id)
			.sort();
		expect(free).toEqual([...COMMAND_CODE_FREE_MODELS].sort());
		for (const model of bundled()) {
			if (free.includes(model.id)) expect(getModelPricing(model)).toBe("free");
		}
	});

	test("every bundled row carries an output ceiling", () => {
		// The number itself, not just its name: 64K is what the upstream CLI asks
		// for, and a test that only compares the constant to itself would accept
		// any value someone typed over it.
		expect(COMMAND_CODE_DEFAULT_MAX_TOKENS).toBe(65_536);
		const uncapped = bundled()
			.filter(model => model.maxTokens === null || model.maxTokens === undefined)
			.map(model => model.id);
		expect(uncapped).toEqual([]);
		const overridden = bundled().filter(model => COMMAND_CODE_LIMITS[model.id] !== undefined);
		expect(overridden.length).toBe(Object.keys(COMMAND_CODE_LIMITS).length);
		for (const model of overridden) {
			expect(model.maxTokens).toBe(COMMAND_CODE_LIMITS[model.id]!.maxTokens);
		}
		const plain = bundled().find(model => COMMAND_CODE_LIMITS[model.id] === undefined);
		expect(plain?.maxTokens).toBe(COMMAND_CODE_DEFAULT_MAX_TOKENS);
	});

	test("a model reasons exactly when the contract gives it a ladder", () => {
		for (const model of bundled()) {
			const ladder = COMMAND_CODE_EFFORTS[model.id];
			expect(model.reasoning).toBe(ladder !== undefined);
			if (ladder) {
				expect(model.thinking?.efforts).toEqual([...ladder]);
			} else {
				expect(model.thinking).toBeUndefined();
			}
		}
	});

	test("the contract describes the bundled set and nothing beyond it", () => {
		const served = new Set(bundled().map(model => model.id));
		const described = new Set([
			...Object.keys(COMMAND_CODE_COSTS),
			...COMMAND_CODE_FREE_MODELS,
			...Object.keys(COMMAND_CODE_EFFORTS),
			...Object.keys(COMMAND_CODE_LIMITS),
			...Object.keys(COMMAND_CODE_LONG_CONTEXT_COSTS),
		]);
		expect([...described].filter(id => !served.has(id)).sort()).toEqual([]);
		expect([...served].filter(id => !described.has(id)).sort()).toEqual([]);
	});

	test("a model the router adds between snapshots is unpriced, never free", () => {
		const added = servedSpec("router/model-nobody-has-priced-yet");
		expect(added.pricing).toBe("unknown");
		expect(getModelPricing(added)).toBe("unpriced");
		expect(added.reasoning).toBe(false);
		expect(added.maxTokens).toBe(COMMAND_CODE_DEFAULT_MAX_TOKENS);
	});

	test("a model on the free list is recorded free rather than left unpriced", () => {
		// Through the contract function itself, not the bundle: a generation pass
		// is the only other thing that runs this branch, so without this the free
		// list could stop working and only a regeneration would reveal it.
		for (const id of COMMAND_CODE_FREE_MODELS) {
			const free = servedSpec(id);
			expect(free.pricing).toBe("published");
			expect(free.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(getModelPricing(free)).toBe("free");
		}
	});

	test("the Codex SKU keeps the prompt window it accepts, not the one it advertises", () => {
		const codex = servedSpec("gpt-5.3-codex");
		expect(codex.contextWindow).toBe(272_000);
		expect(codex.maxTokens).toBe(65_536);
		expect(codex.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});
});

describe("a long prompt bills at the tier the upstream charges", () => {
	function model(id: string): Model<"openai-completions"> {
		const spec = servedSpec(id);
		return { ...spec, compat: {} } as Model<"openai-completions">;
	}

	test("a short prompt bills at the base card", () => {
		const grok = model("xai/grok-4.6");
		const used = usage({ input: 100_000, output: 1_000 });
		calculateCost(grok, used);
		expect(used.cost.input).toBeCloseTo((2 / 1e6) * 100_000, 10);
		expect(used.cost.output).toBeCloseTo((6 / 1e6) * 1_000, 10);
	});

	test("crossing the threshold bills the whole request at the tier", () => {
		const grok = model("xai/grok-4.6");
		const used = usage({ input: 200_001, output: 1_000 });
		calculateCost(grok, used);
		expect(used.cost.input).toBeCloseTo((4 / 1e6) * 200_001, 10);
		expect(used.cost.output).toBeCloseTo((12 / 1e6) * 1_000, 10);
	});

	test("cached prompt tokens count toward the threshold", () => {
		const grok = model("xai/grok-4.6");
		// The prompt is 300K tokens; a cache hit means almost none of it is new
		// input. Reading only `input` would bill this at the cheap card.
		const used = usage({ input: 5_000, cacheRead: 295_000, output: 1_000 });
		calculateCost(grok, used);
		expect(used.cost.cacheRead).toBeCloseTo((1 / 1e6) * 295_000, 10);
		expect(used.cost.output).toBeCloseTo((12 / 1e6) * 1_000, 10);
	});

	test("a model with one rate card is unaffected by prompt size", () => {
		const sonnet = model("claude-sonnet-4-6");
		expect(sonnet.longContextCost).toBeUndefined();
		const small = usage({ input: 1_000, output: 1_000 });
		const huge = usage({ input: 900_000, output: 1_000 });
		calculateCost(sonnet, small);
		calculateCost(sonnet, huge);
		expect(small.cost.input / 1_000).toBeCloseTo(huge.cost.input / 900_000, 12);
	});
});
