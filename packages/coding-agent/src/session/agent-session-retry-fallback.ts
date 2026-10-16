/**
 * Retry fallback chains: the `provider/model` selector syntax the setting is
 * written in, the parse and format of one, and the resolution of the chain
 * that covers a failing model and the candidates that follow it.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	parseModelString,
} from "../config/model-resolver";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";

/** `retry.fallbackChains` config: chain key (`default` or a model selector) → ordered fallback selectors. */
export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: `default` or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are `default` (the chain of the `defaultModel` primary) or model
 * selectors (`provider/model-id[:thinking]`, `provider/*`). A slash marks a model-keyed chain
 * whose primary is the key itself.
 */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A `provider/*` fallback-chain key: matches any active model of that provider,
 * so one entry covers every current and future model behind the provider.
 */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** The model lookups chain resolution and validation read. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	getAll(): readonly Model[];
}

/**
 * The configured `retry.fallbackChains` value with every chain that is not an
 * array, and every entry that is not a string, dropped. A configured value that
 * is not a mapping reads as the empty default and the settings type report
 * names it. This is the only reader of the raw setting that hands chains on;
 * {@link retryFallbackChainWarnings} reports what it drops.
 */
export function sanitizeRetryFallbackChains(value: Record<string, unknown>): RetryFallbackChains {
	const chains: RetryFallbackChains = {};
	for (const key in value) {
		const chain = value[key];
		if (!Array.isArray(chain)) continue;
		chains[key] = chain.filter((entry): entry is string => typeof entry === "string");
	}
	return chains;
}

/** The one chain key that is not a model selector: the chain of the `defaultModel` primary. */
export const DEFAULT_RETRY_FALLBACK_KEY = "default";

/** One warning per malformed or unresolvable key and entry of a configured `retry.fallbackChains` value. */
export function retryFallbackChainWarnings(value: Record<string, unknown>, models: RetryFallbackModelLookup): string[] {
	const warnings: string[] = [];
	const providerExists = (provider: string) => models.getAll().some(model => model.provider === provider);
	for (const key in value) {
		const chain = value[key];
		if (isRetryFallbackWildcardKey(key)) {
			if (!providerExists(key.slice(0, -2))) {
				warnings.push(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
			}
		} else if (isRetryFallbackModelKey(key)) {
			const parsedKey = parseRetryFallbackSelector(key, models);
			if (!parsedKey) {
				warnings.push(`Invalid model selector key in retry.fallbackChains: ${key}`);
			} else if (!models.find(parsedKey.provider, parsedKey.id)) {
				warnings.push(`retry.fallbackChains key references unknown model: ${key}`);
			}
		} else if (key !== DEFAULT_RETRY_FALLBACK_KEY) {
			warnings.push(
				`retry.fallbackChains key '${key}' is neither \`default\` nor a model selector; the chain never applies.`,
			);
		}
		if (!Array.isArray(chain)) {
			warnings.push(`Fallback chain '${key}' must be an array of selector strings.`);
			continue;
		}
		for (const selector of chain) {
			if (typeof selector !== "string") {
				warnings.push(`Fallback chain '${key}' contains a non-string selector.`);
				continue;
			}
			if (isRetryFallbackWildcardKey(selector)) {
				if (!providerExists(selector.slice(0, -2))) {
					warnings.push(`Fallback chain '${key}' references unknown provider: ${selector}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selector, models);
			if (!parsed) {
				warnings.push(`Invalid fallback selector format in chain '${key}': ${selector}`);
			} else if (!models.find(parsed.provider, parsed.id)) {
				warnings.push(`Fallback chain '${key}' references unknown model: ${selector}`);
			}
		}
	}
	return warnings;
}

/** What chain resolution reads: the chains, the session's default model, the registry and the active model. */
export interface RetryFallbackChainSource {
	/** Sanitized chains, as {@link sanitizeRetryFallbackChains} returns them. */
	readonly chains: RetryFallbackChains;
	/** The primary selector of `defaultModel`, when one is configured. */
	defaultModel(): string | undefined;
	readonly models: RetryFallbackModelLookup;
	/** The model the failing turn ran on. */
	readonly activeModel: Model | undefined;
}

/**
 * The failing selector in every spelling a chain entry may match it by: as
 * written, without routing (`plain`), and as `provider/id` for each.
 */
interface CurrentRetryFallbackSelector {
	readonly raw: string;
	readonly parsed: RetryFallbackSelector | undefined;
	readonly plain: string | undefined;
	readonly base: string | undefined;
	readonly plainBase: string | undefined;
}

function describeCurrentSelector(source: RetryFallbackChainSource, raw: string): CurrentRetryFallbackSelector {
	const parsed = parseRetryFallbackSelector(raw, source.models);
	if (!parsed) return { raw, parsed, plain: undefined, base: undefined, plainBase: undefined };
	const plain = source.activeModel
		? formatModelSelectorValue(formatModelString(source.activeModel), parsed.thinkingLevel)
		: undefined;
	const plainBase =
		plain && plain !== raw ? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(plain) ?? parsed) : undefined;
	return { raw, parsed, plain, base: formatRetryFallbackBaseSelector(parsed), plainBase };
}

/** The model a chain key names as its primary: the key itself, or the `defaultModel` primary for `default`. */
export function retryFallbackPrimarySelector(
	source: RetryFallbackChainSource,
	key: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(key)) return undefined;
	if (isRetryFallbackModelKey(key)) return parseRetryFallbackSelector(key, source.models);
	if (key !== DEFAULT_RETRY_FALLBACK_KEY) return undefined;
	const configuredSelector = source.defaultModel();
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, source.models) : undefined;
}

/** Whether a non-empty `default` chain exists with no `defaultModel` configured. */
function defaultChainHasNoPrimary(source: RetryFallbackChainSource): boolean {
	const defaultChain = source.chains[DEFAULT_RETRY_FALLBACK_KEY];
	return (
		defaultChain !== undefined &&
		defaultChain.length > 0 &&
		retryFallbackPrimarySelector(source, DEFAULT_RETRY_FALLBACK_KEY) === undefined
	);
}

/**
 * Parse one configured chain entry. A `provider/*` entry keeps the failing
 * model's id and swaps the provider (google-antigravity/x → google/x); ids the
 * target provider lacks are skipped by the candidate loop's registry lookup.
 */
function parseChainEntry(
	source: RetryFallbackChainSource,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(entry)) {
		if (!current) return undefined;
		const provider = entry.slice(0, -2);
		return { raw: `${provider}/${current.id}`, provider, id: current.id, thinkingLevel: undefined };
	}
	return parseRetryFallbackSelector(entry, source.models);
}

/** `head` followed by the parsed entries of `entries`, each selector once. */
function chainFrom(
	source: RetryFallbackChainSource,
	head: RetryFallbackSelector,
	entries: readonly string[],
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector[] {
	const seen = new Set<string>([head.raw]);
	const chain = [head];
	for (const entry of entries) {
		const parsed = parseChainEntry(source, entry, current);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Map the failing model selector to the chain key that owns it, by
 * specificity: an exact model-selector key, then a `provider/*` wildcard, then
 * `default` when the `defaultModel` primary matches or no `defaultModel` is set.
 */
export function resolveRetryFallbackKey(source: RetryFallbackChainSource, currentSelector: string): string | undefined {
	const current = describeCurrentSelector(source, currentSelector);
	if (!current.parsed) return undefined;
	const matchesCurrent = (primary: RetryFallbackSelector | undefined): boolean => {
		if (!primary) return false;
		if (primary.raw === current.raw || primary.raw === current.plain) return true;
		const base = formatRetryFallbackBaseSelector(primary);
		return base === current.base || base === current.plainBase;
	};

	for (const key in source.chains) {
		if (!isRetryFallbackModelKey(key) || isRetryFallbackWildcardKey(key)) continue;
		if (matchesCurrent(retryFallbackPrimarySelector(source, key))) return key;
	}
	const wildcardKey = `${current.parsed.provider}/*`;
	if (source.chains[wildcardKey]) return wildcardKey;
	if (
		source.chains[DEFAULT_RETRY_FALLBACK_KEY] !== undefined &&
		matchesCurrent(retryFallbackPrimarySelector(source, DEFAULT_RETRY_FALLBACK_KEY))
	) {
		return DEFAULT_RETRY_FALLBACK_KEY;
	}
	return defaultChainHasNoPrimary(source) ? DEFAULT_RETRY_FALLBACK_KEY : undefined;
}

/**
 * The selectors of `key`'s chain that come after the failing one, in order.
 * A wildcard key and a `default` chain with no assigned primary take the
 * failing model as their primary. Empty when the chain has nothing past it.
 */
export function findRetryFallbackCandidates(
	source: RetryFallbackChainSource,
	key: string,
	currentSelector: string,
): RetryFallbackSelector[] {
	const current = describeCurrentSelector(source, currentSelector);
	const entries = source.chains[key] ?? [];
	let chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(key)) {
		chain = current.parsed ? chainFrom(source, current.parsed, entries, current.parsed) : [];
	} else {
		const primary = retryFallbackPrimarySelector(source, key);
		if (primary) {
			chain = chainFrom(source, primary, entries, current.parsed);
		} else if (key === DEFAULT_RETRY_FALLBACK_KEY && current.parsed && defaultChainHasNoPrimary(source)) {
			chain = chainFrom(source, current.parsed, entries, current.parsed);
		}
	}
	if (chain.length <= 1) return [];
	const exactIndex = chain.findIndex(selector => selector.raw === current.raw || selector.raw === current.plain);
	if (exactIndex >= 0) return chain.slice(exactIndex + 1);
	if (current.base !== undefined) {
		const baseIndex = chain.findIndex(selector => {
			const selectorBase = formatRetryFallbackBaseSelector(selector);
			return selectorBase === current.base || selectorBase === current.plainBase;
		});
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
	}
	return chain.slice(1);
}
