/**
 * Scalar value extractors for untrusted inputs. Dependency-free leaf module.
 */

/** String passthrough; anything else (including null/undefined) → null. */
export function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
