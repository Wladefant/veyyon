/**
 * `DEL i` removes line i and reports i as the first changed line, at every
 * anchor of each base here, compared on the whole output. The 5000-line base
 * covers one- to four-digit anchor numbers in the patch text. Other base sizes
 * take sampled anchors in a-single-line-delete-removes-that-line-on-large-bases.test.ts.
 */
import { describe, it } from "bun:test";
import { expectLineDeleted, numberedLines } from "./support/numbered-base";

const SIZES = [80, 100, 120, 150, 200, 250, 300, 5000];

for (const n of SIZES) {
	describe(`DEL on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (let i = 1; i <= n; i++) {
			it(`DEL ${i}`, () => expectLineDeleted(base, n, i, `DEL ${i}`));
		}
	});
}
