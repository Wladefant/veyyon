/**
 * Headers from formatDeleteHeader / formatReplaceHeader apply to the line they
 * name on bases from 200 to 30000 lines, compared on the whole output at
 * sampled anchors (see support/anchor-sweep.ts). Every anchor of the smaller
 * bases and of a 5000-line base is in
 * formatted-delete-and-replace-headers-apply-at-every-anchor.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, formatReplaceHeader } from "@veyyon/hashline";
import { sampleAnchors } from "./support/anchor-sweep";
import { expectLineDeleted, expectLineReplaced, numberedLines } from "./support/numbered-base";

const SIZES = [
	200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 10000, 12000, 15000, 20000, 25000, 30000,
];

for (const n of SIZES) {
	describe(`headers on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (const i of sampleAnchors(n)) {
			it(`formatDeleteHeader ${i}`, () => {
				const header = formatDeleteHeader(i);
				expect(header).toBe(`DEL ${i}`);
				expectLineDeleted(base, n, i, header);
			});

			it(`formatReplaceHeader ${i}`, () => {
				const header = formatReplaceHeader(i, i);
				expect(header).toBe(`SWAP ${i}.=${i}:`);
				expectLineReplaced(base, i, `${header}\n+Z${i}`, `Z${i}`);
			});
		}
	});
}
