import { countTokens as countTokensNat } from "@veyyon/natives";
import { estimateTokensFromBytes, estimateTokensFromText } from "@veyyon/utils/tokens";

const accurate = process.env.VEYYON_TOKENIZER_ACCURATE === "1" && Bun.env.NODE_ENV !== "test";

export function countTokens(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		return text.reduce((sum, t) => sum + estimateTokensFromText(t), 0);
	} else {
		return estimateTokensFromText(text);
	}
}

/**
 * The fewest tokens {@link countTokens} returns for a text of at least `bytes` UTF-8 bytes, or
 * undefined when the native tokenizer counts, whose count no byte length bounds.
 */
export function minTokensForBytes(bytes: number): number | undefined {
	return accurate ? undefined : estimateTokensFromBytes(bytes);
}
