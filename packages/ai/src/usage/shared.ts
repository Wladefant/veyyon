import { clamp } from "@veyyon/utils/math";
import type { UsageAmount, UsageStatus } from "../usage";

/** Consumed fraction at or past which a limit flips from "ok" to "warning". */
export const USAGE_WARNING_FRACTION = 0.9;

/**
 * Map a consumed fraction to a usage status with the shared thresholds: at or
 * past 1.0 the quota is exhausted, at or past {@link USAGE_WARNING_FRACTION} it
 * is a warning, otherwise ok. An undefined fraction (no limit reported) is
 * "unknown". Providers whose status keys off remaining (not used) fraction, use
 * a different warning threshold, or leave the status absent when unknown keep
 * their own derivation on purpose.
 */
export function usageStatusFromUsedFraction(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= USAGE_WARNING_FRACTION) return "warning";
	return "ok";
}

/**
 * The amount of a limit a provider reports as a percent used, clamped to 0..100, with the remaining
 * percent and both fractions derived from it.
 */
export function usageAmountFromUsedPercent(usedPercent: number): UsageAmount {
	const used = clamp(usedPercent, 0, 100);
	const usedFraction = used / 100;
	return {
		used,
		limit: 100,
		remaining: Math.max(0, 100 - used),
		usedFraction,
		remainingFraction: Math.max(0, 1 - usedFraction),
		unit: "percent",
	};
}
