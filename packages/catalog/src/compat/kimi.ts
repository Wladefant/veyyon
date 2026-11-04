/**
 * Which models are Moonshot's Kimi K2.7 Code family.
 *
 * The family needs thinking forced on, and the OpenAI-compatible and Anthropic-compatible
 * compat layers both have to recognise it. Each carried its own copy of the pattern AND of the
 * match, with one of them documenting itself as mirroring the other, so one model-identity rule
 * had four statements. A drift there is silent in the worst way: the model is recognised on one
 * transport and not the other, so the same account gets thinking on some requests and not
 * others depending on which compat layer handled it.
 *
 * Whether the host is Moonshot's own API is the CALLER's question. This answers only whether the
 * model is that family; a Kimi served through an aggregator needs different handling and the
 * compat layers gate on their own host checks.
 */

/** Ids the family publishes, including the `highspeed` variant and the punctuation spellings. */
const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

/** The model spec fields these decisions read, so both compat layers' generics fit. */
interface KimiModelIdentity {
	id: string;
	name?: string;
	reasoningOptions?: { requiresEffort?: boolean };
}

/**
 * Is this a Kimi K2.7 Code model?
 *
 * `kimi-for-coding` is checked separately because that id names whatever coding model the
 * account is currently entitled to, so only its display name says which one: it is the family
 * when the name says K2.7 Code, and something else when it does not.
 */
export function matchesKimiK27CodeFamily(spec: KimiModelIdentity): boolean {
	if (KIMI_K27_CODE_MODEL_PATTERN.test(spec.id)) return true;
	return spec.id === "kimi-for-coding" && /k2\.?7 code/i.test(spec.name ?? "");
}

/**
 * Does this Kimi model reject a request with thinking turned off?
 *
 * True for the K2.7 Code family, and for a model whose row states that it reasons on every request
 * (`reasoningOptions.requiresEffort`, which the Kimi Code `/models` listing declares as
 * `reasoning.type: "only"`). Such a model takes no `thinking.type: "disabled"` and no forced tool
 * choice. As with the family, whether the host is Moonshot's own API is the caller's question.
 */
export function rejectsKimiThinkingOff(spec: KimiModelIdentity): boolean {
	return matchesKimiK27CodeFamily(spec) || spec.reasoningOptions?.requiresEffort === true;
}
