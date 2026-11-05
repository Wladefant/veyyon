/**
 * `INS.POST a` lands its row right after line a and `INS.PRE a` right before it,
 * with a as the first changed line, at every anchor of each base here, compared
 * on the whole output so a shifted sibling line fails. Other base sizes take
 * sampled anchors in an-anchored-insert-lands-beside-its-anchor-on-large-bases.test.ts.
 */
import { describe, it } from "bun:test";
import { expectInsertedBesideAnchor, numberedLines } from "./support/numbered-base";

const SIZES = [40, 60, 5000];

for (const n of SIZES) {
	describe(`INS.POST and INS.PRE on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (let a = 1; a <= n; a++) {
			it(`anchor ${a}`, () => expectInsertedBesideAnchor(base, a));
		}
	});
}
