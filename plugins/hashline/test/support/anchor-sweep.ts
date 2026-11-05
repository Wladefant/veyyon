/**
 * Anchor sampling for the large-base edit suites.
 *
 * Each of those suites exercises a single-line edit (INS.POST / INS.PRE / DEL /
 * SWAP / header round-trip) at anchor `a` for a base of `n` lines. Each
 * `applyEdits` call rebuilds the whole base, so it is O(n), and sweeping all `n`
 * anchors is O(n^2): at n=100000 that is ~10^10 operations, which blows both
 * bun's per-test timeout and the ci-test-ts 600s bucket watchdog (a SIGKILL
 * reported as exit 137). The placement logic is identical at every interior
 * anchor, so the full sweep repeats one assertion n times.
 *
 * Each edit is swept at every anchor of a 5000-line base once, in its
 * companion every-anchor suite; every other base size takes this bounded,
 * deterministic sample: both ends, the anchors adjacent to each end (the
 * off-by-one boundaries), and evenly spaced interior anchors.
 */

/**
 * Number of evenly spaced interior probes taken on a base.
 *
 * Kept small (a few dozen) on purpose: some suites do an O(range) operation per
 * anchor — a `DEL 1.=k` prefix delete expands to k edits — so the per-`it` cost
 * is the number of anchors times that. On a slow CI runner ~66 anchors of a
 * 60000-line prefix delete crossed bun's 5s per-test timeout; a smaller sample
 * keeps every large-base `it` comfortably under it while still probing both ends
 * and the interior.
 */
export const INTERIOR_SAMPLES = 16;

/**
 * The sorted 1-based anchors to exercise for a base of `n` lines: both ends,
 * their adjacent boundaries, and `INTERIOR_SAMPLES - 1` evenly spaced interior
 * anchors, de-duplicated.
 */
export function sampleAnchors(n: number): number[] {
	if (n <= 0) {
		return [];
	}
	const picks = new Set<number>();
	for (const a of [1, 2, 3, n - 2, n - 1, n]) {
		if (a >= 1 && a <= n) {
			picks.add(a);
		}
	}
	for (let step = 1; step < INTERIOR_SAMPLES; step++) {
		const a = Math.round((step * n) / INTERIOR_SAMPLES);
		if (a >= 1 && a <= n) {
			picks.add(a);
		}
	}
	return [...picks].sort((a, b) => a - b);
}
