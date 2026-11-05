/**
 * `INS.HEAD` and `INS.TAIL` of k rows land before and after a one-line base,
 * compared on the whole output, for sampled k from 5001 to 60000 (see
 * support/anchor-sweep.ts). Every k up to 5000 is in
 * head-and-tail-inserts-keep-the-base-at-every-row-count.test.ts.
 */
import { describe, it } from "bun:test";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectRowsAroundOneLineBase } from "./support/numbered-base";

const SWEPT_ROWS = 5000;
const SAMPLED_RANGES = [6000, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 40000, 50000, 60000];
const ROW_COUNTS = [...new Set(SAMPLED_RANGES.flatMap(n => sampleAnchors(n)))]
	.filter(k => k > SWEPT_ROWS)
	.sort((a, b) => a - b);

describe("INS.HEAD and INS.TAIL on a 1-line base, sampled large row counts", () => {
	for (const k of ROW_COUNTS) {
		it(`k=${k}`, () => expectRowsAroundOneLineBase(k));
	}
});
