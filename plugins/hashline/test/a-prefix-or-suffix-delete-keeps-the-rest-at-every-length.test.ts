/**
 * `DEL 1.=k` keeps lines k+1..n and `DEL (n-k+1).=n` keeps lines 1..n-k, for
 * every k from 1 to n including the delete that empties the file, compared on
 * the whole output. Other base sizes take sampled lengths in
 * a-prefix-or-suffix-delete-keeps-the-rest-on-large-bases.test.ts.
 */
import { describe, it } from "bun:test";
import { expectPrefixAndSuffixDeleted, numberedLines } from "./support/numbered-base";

const SIZES = [60, 80, 100, 120, 150, 200, 5000];

for (const n of SIZES) {
	describe(`DEL prefix and suffix on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (let k = 1; k <= n; k++) {
			it(`k=${k}`, () => expectPrefixAndSuffixDeleted(base, n, k));
		}
	});
}
