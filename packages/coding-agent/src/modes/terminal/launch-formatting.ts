/**
 * Formatting helpers for the launch card and status line before session resolution.
 */

import { defaultModelSelector, type LaunchFacts, readLaunchFacts } from "../../config/launch-facts";

/**
 * What the card prints for the model before a catalog exists to name it.
 *
 * The display name recorded for this model, in whatever project it was last used in, and failing
 * that the configured default model reduced to its final path segment. A selector is stored
 * qualified — `nous-research/z-ai/glm-5.1` — and printing it whole costs the row the segments that
 * trail it, the context gauge first: at eighty columns that one id is twenty-six of them, so a row
 * with no recorded name drew no gauge and then grew one when the session resolved a display name.
 * The tail is the part a display name is derived from anyway, so the row states a narrower form of
 * the same fact rather than a different fact.
 *
 * A `:` or `@` suffix is left attached. It carries a thinking level, an upstream route or an Ollama
 * tag, telling them apart needs the resolver this path may not load, and the tail is short with
 * them on. Empty when no default model is configured, which is the one case where the card has
 * nothing to state and says so.
 */
export function launchModelLabel(facts?: LaunchFacts, defaultModel?: string): string {
	const modelName = facts !== undefined ? facts.modelName : readLaunchFacts().modelName;
	if (modelName) return modelName;
	const selector = defaultModel !== undefined ? defaultModel : defaultModelSelector();
	if (!selector) return "";
	return selector.slice(selector.lastIndexOf("/") + 1);
}

/**
 * The provider the configured default model names, parsed from the selector itself.
 *
 * A selector is stored `provider/id`, and a provider id never contains a slash, so
 * the first segment is the provider. This is the card's cold answer for the
 * hero's provider: the session records it per model, but a machine's first
 * launch of a model has no recording, and the selector already states the fact
 * for free. Empty when no default model is configured or it carries no provider.
 */
export function launchProviderLabel(defaultModel?: string): string {
	const selector = defaultModel !== undefined ? defaultModel : defaultModelSelector();
	if (!selector) return "";
	const slash = selector.indexOf("/");
	return slash > 0 ? selector.slice(0, slash) : "";
}
