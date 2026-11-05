/**
 * WHY THIS SUITE EXISTS.
 *
 * `veyyon --model <selector>` failed in two ways that each blamed the wrong
 * thing:
 *
 *   1. `--model sonnet:high` and `--provider openai --model gpt-4o` bypassed the
 *      resolution classifier and printed `Model "x" not found` whatever the
 *      registry held. With no credentials configured, the one correct thing on
 *      the line -- the id -- was the thing reported wrong.
 *   2. `--model openai/` (a provider and no id) fuzzy-matched the empty string
 *      and picked the oldest model of that provider, in silence.
 *
 * THE CLASS THIS CLOSES. Every "nothing matched" exit of `resolveCliModel`
 * reads `modelResolutionFailureMessage`, so a `:level` suffix and an explicit
 * `--provider` both report the classifier's verdict; every failure kind the
 * classifier can produce is swept below through the suffix and provider forms,
 * so a new kind that one form skips turns the suite red. An empty id, bare or
 * behind a provider prefix, is a selector error naming the provider's default.
 *
 * WHAT IT DOES NOT CATCH. The wording of each classifier message is pinned in
 * `model-resolution-failure.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { DEFAULT_MODEL_PER_PROVIDER } from "@veyyon/catalog/provider-models";
import {
	describeModelResolutionFailure,
	type ModelResolutionFailureKind,
} from "@veyyon/coding-agent/config/model-resolution-failure";
import { resolveCliModel } from "@veyyon/coding-agent/config/model-resolver";

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const gpt4o = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});
const gpt35 = buildModel({
	id: "gpt-3.5-turbo",
	name: "GPT-3.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.5 },
	contextWindow: 16000,
	maxTokens: 4096,
});
const all: Model[] = [sonnet, gpt4o, gpt35];

type Registry = Parameters<typeof resolveCliModel>[0]["modelRegistry"];

/** A registry whose credential state is chosen per row. */
function registry(models: Model[], available: Model[], error?: string): Registry {
	return {
		getAll: () => models,
		getAvailable: () => available,
		hasConfiguredAuth: (model: Model) => available.includes(model),
		getError: () => (error ? { message: error } : undefined),
	} as unknown as Registry;
}

/**
 * The classifier's verdict for one registry state, read from the classifier
 * itself so the sweep asserts "the selector form reports what the classifier
 * says", never a hand-copied sentence.
 */
function verdict(models: Model[], available: Model[], requested: string[], error?: string) {
	const qualify = (model: Model) => `${model.provider}/${model.id}`;
	return describeModelResolutionFailure({
		requested,
		providers: [...new Set(models.map(model => model.provider))],
		allModelIds: () => models.map(qualify),
		availableModelIds: available.map(qualify),
		registryError: error,
	});
}

/**
 * One registry state per classifier kind the resolver can reach. Resolution
 * ranks by credentials and does not gate on them: an id that names a model in
 * the registry resolves whether or not its provider is authenticated, and the
 * credential failure is raised by the request. So `provider-unauthenticated`,
 * which the classifier produces only for an exact id, is unreachable through a
 * selector and is pinned as the one opt-out below; the sweep drives every other
 * kind with a selector that matches nothing, through both forms.
 */
const REGISTRY_STATES: Partial<
	Record<ModelResolutionFailureKind, { models: Model[]; available: Model[]; error?: string }>
> = {
	"registry-error": { models: [], available: [], error: "models.yml: bad yaml" },
	"empty-registry": { models: [], available: [] },
	"no-credentials": { models: all, available: [] },
	"unknown-model": { models: all, available: all },
};
const UNREACHABLE_KINDS: ModelResolutionFailureKind[] = ["provider-unauthenticated"];

describe("a selector with a :level suffix or a --provider reports the classifier's verdict", () => {
	test("every classifier kind is swept or pinned as unreachable", () => {
		const kinds: ModelResolutionFailureKind[] = [
			"registry-error",
			"empty-registry",
			"no-credentials",
			"provider-unauthenticated",
			"unknown-model",
		];
		expect([...Object.keys(REGISTRY_STATES), ...UNREACHABLE_KINDS].sort()).toEqual(kinds.sort());
		expect(UNREACHABLE_KINDS).toEqual(["provider-unauthenticated"]);
	});

	for (const [kind, state] of Object.entries(REGISTRY_STATES) as [
		ModelResolutionFailureKind,
		{ models: Model[]; available: Model[]; error?: string },
	][]) {
		test(`${kind}: --model nonesuch:high`, () => {
			const result = resolveCliModel({
				cliModel: "nonesuch:high",
				modelRegistry: registry(state.models, state.available, state.error),
			});
			expect(result.model).toBeUndefined();
			const expected = verdict(state.models, state.available, ["nonesuch:high"], state.error);
			expect(expected.kind).toBe(kind);
			expect(result.error).toBe(expected.message);
		});

		test(`${kind}: --provider openai --model nonesuch`, () => {
			const result = resolveCliModel({
				cliProvider: "openai",
				cliModel: "nonesuch",
				modelRegistry: registry(state.models, state.available, state.error),
			});
			expect(result.model).toBeUndefined();
			const expected = verdict(state.models, state.available, ["openai/nonesuch"], state.error);
			expect(expected.kind).toBe(kind);
			expect(result.error).toBe(expected.message);
		});
	}

	test("the unreachable kind: an exact id with no credentials resolves, and the request reports the credential", () => {
		const result = resolveCliModel({
			cliModel: "claude-sonnet-4-5:high",
			modelRegistry: registry(all, [gpt4o, gpt35]),
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});

	test("control: a resolvable suffixed selector still resolves with its level", () => {
		const result = resolveCliModel({ cliModel: "sonnet:high", modelRegistry: registry(all, all) });
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
	});
});

describe("a provider with no model id is a selector error, never the provider's oldest model", () => {
	for (const selector of ["openai/", "openai/*"]) {
		test(`--model ${selector}`, () => {
			const result = resolveCliModel({ cliModel: selector, modelRegistry: registry(all, all) });
			expect(result.model).toBeUndefined();
			expect(result.error).toContain('provider "openai" and no model');
			expect(result.error).toContain(`openai/${DEFAULT_MODEL_PER_PROVIDER.openai}`);
		});
	}

	test("--provider openai --model *", () => {
		const result = resolveCliModel({ cliProvider: "openai", cliModel: "*", modelRegistry: registry(all, all) });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain('provider "openai" and no model');
	});

	test("control: --provider openai --model 4o still fuzzy-matches within the provider", () => {
		const result = resolveCliModel({ cliProvider: "openai", cliModel: "4o", modelRegistry: registry(all, all) });
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("gpt-4o");
	});
});
