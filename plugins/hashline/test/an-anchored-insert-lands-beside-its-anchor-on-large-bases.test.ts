/**
 * `INS.POST a` lands after line a and `INS.PRE a` before it, with a as the first
 * changed line, on bases from 80 to 100000 lines, compared on the whole output
 * at sampled anchors (see support/anchor-sweep.ts). Every anchor of the smaller
 * bases and of a 5000-line base is in
 * an-anchored-insert-lands-beside-its-anchor-at-every-anchor.test.ts.
 */
import { describe, it } from "bun:test";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectInsertedBesideAnchor, numberedLines } from "./support/numbered-base";

const SIZES = [
	80, 100, 120, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000, 15000,
	20000, 25000, 30000, 40000, 50000, 60000, 80000, 100000,
];

for (const n of SIZES) {
	describe(`INS.POST and INS.PRE on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (const a of sampleAnchors(n)) {
			it(`anchor ${a}`, () => expectInsertedBesideAnchor(base, a));
		}
	});
}
