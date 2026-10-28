/**
 * Byte-aware ~4-bytes-per-token estimate. Char-based `length / 4` heuristics
 * under-count non-ASCII text (CJK is ~3 UTF-8 bytes per char), so budget checks
 * built on them overflow real context windows; this is the ONE owner for the
 * fallback estimate. Accurate native tokenizers (agent countTokens) still win
 * where available — use this only when no real tokenizer is reachable.
 */
export function estimateTokensFromText(text: string): number {
	if (text.length === 0) return 0;
	return estimateTokensFromBytes(Buffer.byteLength(text, "utf-8"));
}

/** {@link estimateTokensFromText} for a text of `bytes` UTF-8 bytes. */
export function estimateTokensFromBytes(bytes: number): number {
	return bytes <= 0 ? 0 : (bytes + 3) >> 2;
}
