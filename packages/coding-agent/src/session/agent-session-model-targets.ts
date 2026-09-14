/**
 * Which model a role, a promotion or a compaction resolves to, over the settings and the model
 * list it is given.
 *
 * These answers were seven private members on the session runtime, and not one of them read or
 * wrote a field of it: every input is `settings`, a model and the available list. That made them
 * part of an 18,600-line class for no reason other than where they were typed, and it made the
 * candidate walk — the part that decides which model writes the summary that shapes the rest of a
 * session — reachable only by constructing a whole session.
 *
 * The rule this file keeps is the one its siblings keep: it imports nothing from
 * `agent-session.ts`, so the pair is two modules rather than one module in two files.
 */
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import {
	getModelMatchPreferences,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveCompactionModelPatterns,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT, SELECTABLE_MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { AUTO_THINKING } from "../thinking";

/** The identity a model is deduplicated, memoized and reported under. */
export function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The model a configured target string names, or undefined when it names nothing available.
 *
 * A bare id resolves against the CURRENT model's provider, so a catalog row recommending
 * `claude-haiku-4` does not reach into whichever provider happens to publish that id.
 */
export function configuredModelTarget(
	configuredTarget: string | undefined,
	currentModel: Model,
	availableModels: Model[],
): Model | undefined {
	const trimmedTarget = configuredTarget?.trim();
	if (!trimmedTarget) return undefined;

	const parsed = parseModelString(trimmedTarget, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => availableModels.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
		if (explicitModel) return explicitModel;
	}

	return availableModels.find(m => m.provider === currentModel.provider && m.id === trimmedTarget);
}

/** The promotion target this model's own catalog row recommends. */
export function contextPromotionTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
	return configuredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
}

/** The compaction sibling this model's own catalog row recommends. */
export function compactionTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
	return configuredModelTarget(currentModel.compactionModel, currentModel, availableModels);
}

/** What a model role resolves to, with the thinking level its selector carries. */
export function roleModelValue(
	settings: Settings,
	role: string,
	availableModels: Model[],
	currentModel: Model | undefined,
): ResolvedModelRoleValue {
	const roleModelStr =
		role === "default"
			? (settings.getModelRole(DEFAULT_MODEL_SLOT) ??
				(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
			: settings.getModelRole(role);

	if (!roleModelStr) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	return resolveModelRoleValue(roleModelStr, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
}

/**
 * The models compaction may try, in the order it tries them.
 *
 * Deduplicated by {@link modelKey}, so a model named twice is tried once and the first position it
 * earned is the one it keeps.
 */
export function compactionModelCandidates(
	settings: Settings,
	preferredModel: Model | null | undefined,
	availableModels: Model[],
	filter?: (model: Model) => boolean,
): Model[] {
	const candidates: Model[] = [];
	const seen = new Set<string>();

	const addCandidate = (model: Model | undefined): void => {
		if (!model) return;
		const key = modelKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		if (filter && !filter(model)) return;
		candidates.push(model);
	};

	const configuredPatterns = resolveCompactionModelPatterns(settings);
	for (const pattern of configuredPatterns) {
		const resolved = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		addCandidate(resolved.model);
	}

	// `configured-only` stops at the chain the user wrote down. With no chain
	// configured, `compaction.model` means "inherit", so the one model they
	// chose is the main model and that is where the list ends.
	const fallbackStrategy = settings.get("compaction.modelFallbackStrategy");
	if (fallbackStrategy === "configured-only") {
		if (configuredPatterns.length === 0) addCandidate(preferredModel ?? undefined);
		return candidates;
	}

	if (preferredModel) {
		// The compaction sibling this model's own catalog row recommends. Nobody
		// named it, so `auto` takes it only while it stays inside the provider
		// the operator DID name; a cross-provider recommendation spends someone
		// else's credit and belongs to `any-model`.
		const recommended = compactionTarget(preferredModel, availableModels);
		if (recommended && (fallbackStrategy === "any-model" || recommended.provider === preferredModel.provider)) {
			addCandidate(recommended);
		}
	}
	addCandidate(preferredModel ?? undefined);
	for (const role of SELECTABLE_MODEL_ROLE_IDS) {
		addCandidate(roleModelValue(settings, role, availableModels, preferredModel ?? undefined).model);
	}

	// The widest window among everything authenticated is the only tier that
	// can reach a provider the operator never chose for this session, and
	// compaction fires unattended: under `auto` that tier is an accidental
	// bill on an unrelated account (a Cursor session summarized on a Hugging
	// Face key and surfaced its 402 as a compaction failure). `any-model` is
	// the opt-in that keeps the historical never-fails behavior. The tier
	// walks every authenticated row widest-first rather than staking the
	// session on the single widest: a dead key on that one row must not fail
	// compaction when a slightly narrower usable row exists, because
	// never-failing is the strategy's whole point.
	if (fallbackStrategy === "any-model") {
		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			addCandidate(model);
		}
	}

	return candidates;
}

/**
 * Map each configured `compaction.model` candidate to the explicit thinking
 * effort its selector carries (the `:level` suffix picked in settings). Only
 * patterns that name an explicit level land here; role/main/largest-context
 * fallbacks are absent and fall back to the session effort at run time. `auto`
 * is treated as "no explicit level" so compact() applies its own default. The
 * resolution mirrors {@link compactionModelCandidates} so a candidate and its
 * configured effort always agree.
 */
export function configuredCompactionEfforts(settings: Settings, availableModels: Model[]): Map<string, ThinkingLevel> {
	const efforts = new Map<string, ThinkingLevel>();
	for (const pattern of resolveCompactionModelPatterns(settings)) {
		const resolved = resolveModelRoleValue(pattern, availableModels, {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (
			resolved.model &&
			resolved.explicitThinkingLevel &&
			resolved.thinkingLevel !== undefined &&
			resolved.thinkingLevel !== AUTO_THINKING
		) {
			const key = modelKey(resolved.model);
			if (!efforts.has(key)) efforts.set(key, resolved.thinkingLevel);
		}
	}
	return efforts;
}
