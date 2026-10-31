/**
 * `SWAP i.=i` replaces line i with its row and reports i as the first changed
 * line, at every anchor of each base here, compared on the whole output so a
 * change to any other line fails. Other base sizes take sampled anchors in
 * a-single-line-swap-rewrites-only-that-line-on-large-bases.test.ts.
 */
import { describe, it } from "bun:test";
import { expectLineReplaced, numberedLines } from "./support/numbered-base";

const SIZES = [80, 100, 120, 5000];

for (const n of SIZES) {
	describe(`SWAP on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (let i = 1; i <= n; i++) {
			it(`SWAP ${i}`, () => expectLineReplaced(base, i, `SWAP ${i}.=${i}:\n+X${i}`, `X${i}`));
		}
	});
}
