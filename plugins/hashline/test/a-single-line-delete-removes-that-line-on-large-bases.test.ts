/**
 * `DEL i` removes line i and reports it as the first changed line on bases from
 * 400 to 40000 lines, compared on the whole output at sampled anchors (see
 * support/anchor-sweep.ts). Every anchor of the smaller bases and of a
 * 5000-line base is in a-single-line-delete-removes-that-line-at-every-anchor.test.ts.
 */
import { describe, it } from "bun:test";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectLineDeleted, numberedLines } from "./support/numbered-base";

const SIZES = [
	400, 500, 600, 750, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 40000,
];

for (const n of SIZES) {
	describe(`DEL on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (const i of sampleAnchors(n)) {
			it(`DEL ${i}`, () => expectLineDeleted(base, n, i, `DEL ${i}`));
		}
	});
}
