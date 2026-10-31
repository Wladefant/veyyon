/**
 * How a configured patch lands on a built model: `modelOverrides` entries, custom model
 * definitions from models.yml and provider-level compat. Every function here returns a new model
 * built through `buildModel`; none reads registry state.
 */
import type { Api, Model, ModelSpec, ThinkingConfig } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { resolveBundledModelReference } from "@veyyon/catalog/identity";
import { getVariantAliasSources } from "@veyyon/catalog/variant-collapse";
import { isRecord, logger } from "@veyyon/utils";
import { createLiveConfigHeaders } from "./live-config-headers";
import type { ModelOverride, ProviderAuthMode } from "./models-config-schema";

/** Deep-merge two compat records; a nested record merges, any other value from `overrideCompat` wins. */
export function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

/**
 * The patchable subset of `Model` fields shared by `modelOverrides` entries,
 * custom model definitions, and parsed custom-model overlays. `undefined`
 * always means "leave the base value alone".
 */
export interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: Model<Api>["input"];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	contextPromotionTarget?: string;
	compactionModel?: string;
	premiumMultiplier?: number;
}

/**
 * How a patch treats the base model's transport metadata (headers/compat):
 * - `merge`: fold the patch into the base's (modelOverrides semantics).
 * - `replace`: the patch owns transport wholesale — same-id custom definitions
 *   already folded provider-level headers/compat in during parsing, so bundled
 *   transport metadata must not be re-merged (see `mergeCustomModels` in
 *   `config/model-registry.ts`).
 */
export type ModelTransportPolicy = "merge" | "replace";

export function applyModelPatch(base: Model<Api>, patch: ModelPatch, transport: ModelTransportPolicy): Model<Api> {
	const result = { ...base };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.thinking !== undefined) result.thinking = patch.thinking;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.supportsTools !== undefined) result.supportsTools = patch.supportsTools;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.omitMaxOutputTokens !== undefined) result.omitMaxOutputTokens = patch.omitMaxOutputTokens;
	if (patch.contextPromotionTarget !== undefined) result.contextPromotionTarget = patch.contextPromotionTarget;
	if (patch.compactionModel !== undefined) result.compactionModel = patch.compactionModel;
	if (patch.premiumMultiplier !== undefined) result.premiumMultiplier = patch.premiumMultiplier;
	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? base.cost.input,
			output: patch.cost.output ?? base.cost.output,
			cacheRead: patch.cost.cacheRead ?? base.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? base.cost.cacheWrite,
		};
	}
	let compat: ModelSpec<Api>["compat"];
	if (transport === "merge") {
		if (patch.headers) {
			result.headers = { ...base.headers, ...patch.headers };
		}
		compat = mergeCompat(base.compatConfig, patch.compat);
	} else {
		result.headers = patch.headers;
		compat = patch.compat;
	}
	return buildModel({ ...result, compat } as ModelSpec<Api>);
}

export function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return applyModelPatch(model, override as ModelPatch, "merge");
}

export interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
}

export interface CustomModelBuildOptions {
	useDefaults: boolean;
}

export interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	isOAuth?: boolean;
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 * - Any other explicit `auth` → unset.
 * - No `auth` and the `anthropic-messages` API → force on: such custom
 *   endpoints are typically Claude-Code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

export function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		headers: createLiveConfigHeaders([providerHeaders, modelDef.headers], {
			authHeader,
			apiKeyConfig: providerApiKey,
		}),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		compactionModel: modelDef.compactionModel,
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

export function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults ? resolveBundledModelReference(resolvedModel.id) : undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const supportsTools = resolvedModel.supportsTools ?? reference?.supportsTools;
	return buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking ?? reference?.thinking,
		input: input as ("text" | "image")[],
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow: resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		compactionModel: resolvedModel.compactionModel,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
}

/**
 * Look up a model's override, falling back to entries keyed by retired
 * effort-tier variant ids (models.yml authored before collapsing). A raw key
 * only re-binds when no live model holds that id.
 */
export function resolveModelOverrideWithAliases(
	overrides: Map<string, ModelOverride>,
	model: Model<Api>,
	hasLiveModel: (provider: string, id: string) => boolean,
): ModelOverride | undefined {
	const direct = overrides.get(model.id);
	if (direct) return direct;
	for (const rawId of getVariantAliasSources(model.provider, model.id)) {
		if (hasLiveModel(model.provider, rawId)) continue;
		const remapped = overrides.get(rawId);
		if (remapped) {
			logger.debug("model override re-keyed through variant alias", {
				provider: model.provider,
				from: rawId,
				to: model.id,
			});
			return remapped;
		}
	}
	return undefined;
}

export function applyProviderCompat(compat: ModelSpec<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
	if (!compat) return models;
	return models.map(model =>
		buildModel({ ...model, compat: mergeCompat(model.compatConfig, compat) } as ModelSpec<Api>),
	);
}

export function applyModelOverrides(
	models: Model<Api>[],
	overrides: Map<string, Map<string, ModelOverride>>,
): Model<Api>[] {
	if (overrides.size === 0) return models;
	let liveKeys: Set<string> | null = null;
	const hasLiveModel = (provider: string, id: string) => {
		liveKeys ??= new Set(models.map(m => `${m.provider}\u0000${m.id}`));
		return liveKeys.has(`${provider}\u0000${id}`);
	};
	return models.map(model => {
		const providerOverrides = overrides.get(model.provider);
		if (!providerOverrides) return model;
		const override = resolveModelOverrideWithAliases(providerOverrides, model, hasLiveModel);
		if (!override) return model;
		return applyModelOverride(model, override);
	});
}
