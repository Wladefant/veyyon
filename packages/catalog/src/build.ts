/**
 * The single Model constructor. Resolution order is a dependency chain, each
 * step materialized exactly once per spec:
 *
 *   1. compat   — URL/provider/id detection resolved into a complete record,
 *                 then shared with every model whose record is equal;
 *   2. thinking — derived from identity + resolved compat (or trusted verbatim
 *                 when the spec carries explicit metadata).
 *
 * Request handlers read fields — they never detect, parse ids, or allocate
 * compat per request.
 */
import { buildAnthropicCompat } from "./compat/anthropic";
import { buildCursorCompat } from "./compat/cursor";
import { buildDevinCompat } from "./compat/devin";
import {
	buildOpenAICompat,
	buildOpenAIResponsesCompat,
	buildOpenRouterCompat,
} from "./compat/openai";
import { shareCompat } from "./compat/share";
import { resolveModelThinking } from "./model-thinking";
import {
	type Api,
	type CompatOf,
	MODEL_KINDS,
	type Model,
	type ModelSpec,
	type WebSearchGrounding,
} from "./types";
import { cleanModelName, normalizeModelCost } from "./utils";

function resolveProviderWebSearch(
	provider: string,
): WebSearchGrounding | undefined {
	switch (provider) {
		case "google":
		case "google-antigravity":
			return "gemini";
		case "anthropic":
			return "anthropic";
		case "openai-codex":
			return "codex";
		case "xai":
		case "xai-oauth":
			return "xai";
		case "openrouter":
			return "openrouter";
		default:
			return undefined;
	}
}

export function buildModel<TApi extends Api>(
	spec: ModelSpec<TApi>,
): Model<TApi> {
	const compat = shareCompat(buildCompat(spec)) as CompatOf<TApi>;
	const rawKind =
		spec.kind ??
		(spec.provider === "typesafe"
			? "judge"
			: spec.provider === "web"
				? "search"
				: undefined);
	const resolvedKind = MODEL_KINDS.find((k) => k === rawKind);
	const kind = resolvedKind !== "chat" ? resolvedKind : undefined;

	const rawWebSearch =
		spec.webSearch ?? resolveProviderWebSearch(spec.provider);
	const webSearch =
		rawWebSearch === "gemini" ||
		rawWebSearch === "anthropic" ||
		rawWebSearch === "codex" ||
		rawWebSearch === "xai" ||
		rawWebSearch === "openrouter"
			? rawWebSearch
			: undefined;
	const {
		kind: _omittedKind,
		webSearch: _omittedWebSearch,
		...restSpec
	} = spec;
	return {
		...restSpec,
		name: cleanModelName(spec.name),
		cost: normalizeModelCost(spec.cost),
		thinking: resolveModelThinking(spec, compat),
		compat,
		compatConfig: spec.compat,
		...(kind !== undefined ? { kind } : {}),
		...(webSearch !== undefined ? { webSearch } : {}),
	} as Model<TApi>;
}

export function buildCompat(spec: ModelSpec<Api>): CompatOf<Api> {
	switch (spec.api) {
		case "openrouter":
			return buildOpenRouterCompat(spec as ModelSpec<"openrouter">);
		case "openai-completions":
			return buildOpenAICompat(spec as ModelSpec<"openai-completions">);
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return buildOpenAIResponsesCompat(spec as ModelSpec<"openai-responses">);
		case "anthropic-messages":
			return buildAnthropicCompat(spec as ModelSpec<"anthropic-messages">);
		case "devin-agent":
			return buildDevinCompat(spec as ModelSpec<"devin-agent">);
		case "cursor-agent":
			return buildCursorCompat(spec as ModelSpec<"cursor-agent">);
		default:
			return undefined;
	}
}
