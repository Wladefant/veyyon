/**
 * Thinking metadata: runtime field-read helpers.
 *
 * Derivation lives in the compat engine (`compat/resolve`) and runs exactly
 * once per model — from `buildModel` for dynamic specs and from the catalog
 * generator for bundled entries. Everything here reads baked fields only: no
 * id parsing, no host matching, no compat detection per request.
 */
import { readCompatEffortMap, resolveModelPolicy } from "./compat/resolve";
import { Effort, THINKING_EFFORTS } from "./effort";
import type { Api, Model, ModelSpec, ThinkingConfig } from "./types";

/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

/**
 * Neutral view of a model whose thinking ladder is unverified: `reasoning: false`
 * and no ladder. Re-entering policy resolution starts from it (the ladder is
 * derived output, not authored input), and requests without an effort send it so
 * no reasoning or disable fields reach an upstream that may reject them.
 */
export function withoutUnverifiedThinking<T extends { reasoning: boolean; thinking?: ThinkingConfig }>(model: T): T {
	if (!model.thinking?.unverified) return model;
	const { thinking: _derived, ...rest } = model;
	return { ...rest, reasoning: false } as T;
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values.
 * When a collapsed family routes `minimal` onto the same wire id as `low`
 * (Antigravity Gemini 3.6/3.7 Flash), emit `LOW` — Cloud Code Assist rejects
 * `MINIMAL` on those `-low` SKUs.
 */
export function mapEffortToGoogleThinkingLevel<TApi extends Api>(
	effort: Effort,
	model?: ApiModel<TApi>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	if (effort === Effort.Minimal) {
		const routing = model?.thinking?.effortRouting;
		if (routing?.[Effort.Minimal] && routing[Effort.Minimal] === routing[Effort.Low]) {
			return "LOW";
		}
		return "MINIMAL";
	}
	switch (effort) {
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

/**
 * Maps a normalized thinking effort to Anthropic adaptive effort values via
 * the model's baked `thinking.effortMap` (identity for unmapped efforts).
 *
 * The Anthropic adaptive wire vocabulary has no `minimal` tier (valid values:
 * `low`, `medium`, `high`, `xhigh`, `max`); a model ladder that exposes
 * `minimal` — custom `anthropic-messages` providers do, unlike the built-in
 * Claude ladders — would otherwise serialize `output_config.effort: "minimal"`
 * and 400 (`level "minimal" not supported`). Clamp it to the lowest real tier,
 * mirroring {@link mapEffortToGoogleThinkingLevel}'s `minimal` handling.
 */
export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
	const supported = requireSupportedEffort(model, effort);
	const mapped = model.thinking?.effortMap?.[supported] ?? supported;
	if (mapped === Effort.Minimal) return "low";
	return mapped as "low" | "medium" | "high" | "xhigh" | "max" | "adaptive";
}

/**
 * Resolves the upstream wire model id for a request at the given effort
 * (`undefined` = thinking off). Collapsed effort-tier variants route through
 * `thinking.effortRouting`; everything else falls back to
 * `requestModelId ?? id`.
 */
export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}

/**
 * Clamp target for effort-less requests on `thinking.requiresEffort` models:
 * the effort whose wire route equals the model's default wire id
 * (`requestModelId`), so a collapsed row clamps to the tier it already
 * advertises as its default rather than the numerically lowest supported tier
 * (e.g. Cursor Grok 4.5/4.6 default to `medium`, the only tier the Start plan
 * serves). Falls back to {@link minimumSupportedEffort} when no route matches
 * the default id — families whose default already is the minimum, or that
 * expose no routing, are unaffected.
 */
export function defaultSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const routing = model.thinking?.effortRouting;
	const defaultWireId = model.requestModelId;
	if (routing !== undefined && defaultWireId !== undefined) {
		const efforts = model.thinking?.efforts;
		for (const effort of THINKING_EFFORTS) {
			if (efforts?.includes(effort) && routing[effort] === defaultWireId) return effort;
		}
	}
	return minimumSupportedEffort(model);
}

/**
 * The thinking surface a spec resolves to, read from the compat engine's single
 * policy pass (`resolveModelPolicy`), the same pass `buildModel` materializes.
 */
export function resolveModelThinking<TApi extends Api>(spec: ModelSpec<TApi>): ThinkingConfig | undefined {
	return resolveModelPolicy(spec).thinking;
}

/**
 * The `thinkingLevel` a thinking-off request sends to a `google-level` model. Gemini 3 cannot switch
 * thinking off, so the request names the lowest level the model declares: `MINIMAL` only where the
 * model accepts it, `LOW` on a model whose ladder starts there.
 */
export function googleThinkingLevelWhenOff<TApi extends Api>(
	model: ApiModel<TApi>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	return mapEffortToGoogleThinkingLevel(minimumSupportedEffort(model) ?? Effort.Minimal);
}

/** Canonical reasoning state after applying user intent to one model capability. */
export type ReasoningSelectionState = "unsupported" | "uncontrolled" | "disabled" | "enabled";

/**
 * Provider-neutral request plan. `effort` is the supported canonical level,
 * `wireEffort` is the model's baked provider value, and `wireModelId` covers
 * providers that expose effort as separate model SKUs.
 */
export interface ReasoningSelection {
	state: ReasoningSelectionState;
	effort: Effort | undefined;
	wireEffort: string | undefined;
	wireModelId: string;
	mode: ThinkingConfig["mode"] | undefined;
	forcedByModel: boolean;
	enabled: boolean;
}

export interface ReasoningSelectionIntent {
	effort?: Effort;
	disabled?: boolean;
}

function resolveSelectedEffort<TApi extends Api>(model: ApiModel<TApi>, requested: Effort): Effort {
	const thinking = model.thinking;
	if (thinking?.efforts.includes(requested)) return requested;
	const compatMapped = readCompatEffortMap(model.compat)?.[requested];
	if (
		compatMapped !== undefined &&
		THINKING_EFFORTS.includes(compatMapped as Effort) &&
		thinking?.efforts.includes(compatMapped as Effort)
	) {
		return compatMapped as Effort;
	}
	const mapped = thinking?.effortMap?.[requested];
	if (
		mapped !== undefined &&
		THINKING_EFFORTS.includes(mapped as Effort) &&
		thinking?.efforts.includes(mapped as Effort)
	) {
		return mapped as Effort;
	}
	if (mapped !== undefined) return requested;
	return requireSupportedEffort(model, requested);
}

/**
 * Resolve reasoning once before provider serialization.
 *
 * `effort` and "thinking level" are the same user intent. Provider-specific
 * controls (enum, token budget, adaptive output effort, or a routed model id)
 * are facts on the returned plan, not separate settings.
 */
export function resolveReasoningSelection<TApi extends Api>(
	model: ApiModel<TApi>,
	intent: ReasoningSelectionIntent = {},
): ReasoningSelection {
	const fallbackWireModelId = model.requestModelId ?? model.id;
	if (!model.reasoning) {
		return {
			state: "unsupported",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: fallbackWireModelId,
			mode: undefined,
			forcedByModel: false,
			enabled: false,
		};
	}
	const thinking = model.thinking;
	if (!thinking) {
		return {
			state: intent.disabled ? "disabled" : "uncontrolled",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: resolveWireModelId(model, undefined),
			mode: undefined,
			forcedByModel: false,
			enabled: false,
		};
	}
	if (intent.disabled || intent.effort === undefined) {
		if (thinking.requiresEffort && !thinking.suppressWhenOff) {
			const floor = minimumSupportedEffort(model);
			if (floor === undefined) {
				throw new Error(`Model ${model.provider}/${model.id} requires thinking but declares no supported effort`);
			}
			return {
				state: "enabled",
				effort: floor,
				wireEffort: thinking.effortMap?.[floor] ?? floor,
				wireModelId: resolveWireModelId(model, floor),
				mode: thinking.mode,
				forcedByModel: true,
				enabled: true,
			};
		}
		return {
			state: "disabled",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: resolveWireModelId(model, undefined),
			mode: thinking.mode,
			forcedByModel: false,
			enabled: false,
		};
	}
	const effort = resolveSelectedEffort(model, intent.effort);
	return {
		state: "enabled",
		effort,
		wireEffort: readCompatEffortMap(model.compat)?.[intent.effort] ?? thinking.effortMap?.[effort] ?? effort,
		wireModelId: resolveWireModelId(model, effort),
		mode: thinking.mode,
		forcedByModel: false,
		enabled: true,
	};
}
