/**
 * `DEL 1.=k` keeps lines k+1..n and `DEL (n-k+1).=n` keeps lines 1..n-k on bases
 * from 250 to 60000 lines, compared on the whole output at sampled lengths k
 * (see support/anchor-sweep.ts). Every length on the smaller bases and on a
 * 5000-line base is in a-prefix-or-suffix-delete-keeps-the-rest-at-every-length.test.ts.
 */
import { describe, it } from "bun:test";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectPrefixAndSuffixDeleted, numberedLines } from "./support/numbered-base";

const SIZES = [
	250, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 40000,
	50000, 60000,
];

for (const n of SIZES) {
	describe(`DEL prefix and suffix on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (const k of sampleAnchors(n)) {
			it(`k=${k}`, () => expectPrefixAndSuffixDeleted(base, n, k));
		}
	});
}
