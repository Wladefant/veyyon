/**
 * Contract for sampleAnchors, the anchor selector the large-base edit suites use.
 *
 * Why this suite exists: the large-base suites once swept every anchor 1..n on
 * bases up to n=100000. Each edit rebuilds the whole base (O(n)), so the full
 * sweep was O(n^2): the n=100000 file alone was ~10^10 ops, which SIGKILLed the
 * ci-test-ts 600s bucket (exit 137). These tests pin both halves of the sample:
 * it stays bounded on a large base, and it never drops an end or the anchor
 * beside it, where off-by-one placement bugs show.
 */
import { describe, expect, it } from "bun:test";
import { INTERIOR_SAMPLES, sampleAnchors } from "./anchor-sweep";

describe("sampleAnchors", () => {
	it("returns an empty list for a non-positive base", () => {
		expect(sampleAnchors(0)).toEqual([]);
		expect(sampleAnchors(-5)).toEqual([]);
	});

	it("covers every anchor of a base no longer than its boundary set", () => {
		for (const n of [1, 2, 3, 4, 5, 6]) {
			expect(sampleAnchors(n)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
		}
	});

	it("pins the ends, their neighbours and an even interior spread", () => {
		expect(sampleAnchors(160)).toEqual([
			1, 2, 3, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 158, 159, 160,
		]);
	});

	it("stays bounded on a large base", () => {
		const anchors = sampleAnchors(100000);
		expect(anchors.length).toBeLessThanOrEqual(6 + INTERIOR_SAMPLES - 1);
		expect(anchors.length).toBeGreaterThanOrEqual(INTERIOR_SAMPLES);
	});

	it("always covers both ends and their off-by-one boundaries on a large base", () => {
		const n = 50000;
		const anchors = sampleAnchors(n);
		for (const boundary of [1, 2, 3, n - 2, n - 1, n]) {
			expect(anchors).toContain(boundary);
		}
	});

	it("returns strictly ascending, de-duplicated, in-range anchors", () => {
		for (const n of [7, 80, 4000, 80000]) {
			const anchors = sampleAnchors(n);
			for (const a of anchors) {
				expect(a).toBeGreaterThanOrEqual(1);
				expect(a).toBeLessThanOrEqual(n);
			}
			for (let i = 1; i < anchors.length; i++) {
				expect(anchors[i]).toBeGreaterThan(anchors[i - 1]);
			}
		}
	});
});
