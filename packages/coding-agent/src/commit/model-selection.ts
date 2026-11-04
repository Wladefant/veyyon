import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import {
	fallbackForUnavailableDefault,
	getModelMatchPreferences,
	type ModelLookupRegistry,
	resolveModelSelectorValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { resolveHelperModel } from "../task/helper-settings";
import { concreteThinkingLevel } from "../thinking";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	warn: (message: string) => void = message => process.stderr.write(`Warning: ${message}\n`),
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? resolveModelSelectorValue(override, available, { settings, matchPreferences })
		: resolveHelperModel(settings, "commit", available);
	let model = resolved?.model;
	let thinkingLevel = resolved?.thinkingLevel;
	if (!model && !override) {
		// Parity with the interactive/print surface (main.ts): a configured
		// default whose provider lost auth substitutes LOUDLY instead of
		// failing here while `-p` succeeds. An explicit --model override stays
		// authoritative and still fails hard. With no configured default at all
		// there is nothing to warn about — picking an available model IS the
		// default resolution (mirrors main.ts's un-warned scopedModels[0] path).
		const configuredDefault = settings.get("defaultModel");
		const defaultPattern = Array.isArray(configuredDefault) ? configuredDefault[0] : configuredDefault;
		const fallback = fallbackForUnavailableDefault(defaultPattern, available);
		if (fallback) {
			if (defaultPattern) warn(fallback.warning);
			model = fallback.model;
			thinkingLevel = undefined;
		}
	}
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: concreteThinkingLevel(thinkingLevel),
	};
}

export async function resolveCommitHelperModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
	warn: (message: string) => void = message => process.stderr.write(`Warning: ${message}\n`),
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolved = resolveHelperModel(settings, "commit", available);
	if (resolved?.model) {
		const apiKey = await modelRegistry.getApiKey(resolved.model);
		if (apiKey) {
			return {
				model: resolved.model,
				apiKey: modelRegistry.resolver(resolved.model),
				thinkingLevel: concreteThinkingLevel(resolved.thinkingLevel),
			};
		}
		if (!resolved.inherited) {
			warn(
				`Configured commit helper model ${resolved.model.provider}/${resolved.model.id} has no stored credentials; picking a substitute — run \`veyyon auth-broker login ${resolved.model.provider}\` to sign in.`,
			);
		}
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
