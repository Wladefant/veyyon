import type { Model } from "./types";

/** A positive finite advertised maximum, or `undefined` when the row carries none. */
export function resolveMaxContextWindow(model: Pick<Model, "maxContextWindow">): number | undefined {
	const maximum = model.maxContextWindow;
	return typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0 ? maximum : undefined;
}

/**
 * The window a session may use for `model`.
 *
 * The catalog row carries the largest window the model has ever been offered
 * at (`contextWindow`, e.g. the 1M a subscription SKU advertises) together with
 * the ceiling the endpoint honors (`maxContextWindow`). A session never sends
 * more than that ceiling, and never crosses a premium long-context price tier
 * unless extended context is on:
 *
 * - off: the standard-pricing window, i.e. `contextWindow` capped at
 *   `longContextCost.inputThreshold`;
 * - on: the advertised maximum, or `contextWindow` when the row has none.
 *
 * With a maximum, the result never exceeds it. `null` stays `null`.
 */
export function resolveSessionContextWindow(
	model: Pick<Model, "contextWindow" | "maxContextWindow" | "longContextCost">,
	extendedContext: boolean,
): number | null {
	const window = model.contextWindow;
	if (window === null) return null;
	const maximum = resolveMaxContextWindow(model);
	if (extendedContext) return maximum ?? window;
	const threshold = model.longContextCost?.inputThreshold;
	const standard = threshold !== undefined && window > threshold ? threshold : window;
	return maximum === undefined ? standard : Math.min(standard, maximum);
}
