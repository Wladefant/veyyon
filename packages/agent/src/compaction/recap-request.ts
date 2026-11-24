/**
 * Marks a compaction recap request and the request it was derived from.
 *
 * A recap request is a side request the session sends on the source request's behalf. The stream
 * wrapper bypasses the session payload hooks for a marked recap, while it still redacts the wire
 * payload under the source request's secret lease. The mark lives in a WeakMap keyed by the recap
 * context object, so no payload field a provider or extension can read or write carries it.
 */

import type { Context } from "@veyyon/ai";

const sourceByRecap = new WeakMap<Context, Context>();

/** Brand `recap` as a compaction recap request derived from `source`. */
export function markCompactionRecapRequest(recap: Context, source: Context): void {
	sourceByRecap.set(recap, source);
}

/** The source request `context` was branded from, or `undefined` for an ordinary request. */
export function compactionRecapSource(context: Context): Context | undefined {
	return sourceByRecap.get(context);
}
