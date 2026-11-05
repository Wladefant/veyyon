/**
 * `SWAP i.=i` replaces line i and reports it as the first changed line on bases
 * from 150 to 40000 lines, compared on the whole output at sampled anchors (see
 * support/anchor-sweep.ts). Every anchor of the smaller bases and of a
 * 5000-line base is in a-single-line-swap-rewrites-only-that-line-at-every-anchor.test.ts.
 */
import { describe, it } from "bun:test";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectLineReplaced, numberedLines } from "./support/numbered-base";

const SIZES = [
	150, 200, 250, 300, 400, 500, 600, 750, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000, 15000, 20000,
	25000, 30000, 40000,
];

for (const n of SIZES) {
	describe(`SWAP on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (const i of sampleAnchors(n)) {
			it(`SWAP ${i}`, () => expectLineReplaced(base, i, `SWAP ${i}.=${i}:\n+X${i}`, `X${i}`));
		}
	});
}
