/**
 * formatDeleteHeader / formatReplaceHeader print the header parsePatch accepts,
 * and it applies to the line it names, at every anchor of each base here,
 * compared on the whole output. formatReplaceHeader includes the trailing
 * colon. The 50-line base also covers short delete ranges. Other base sizes
 * take sampled anchors in formatted-delete-and-replace-headers-apply-on-large-bases.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";
import {
	expectLineDeleted,
	expectLineReplaced,
	expectSplicedBase,
	numberedLineStart,
	numberedLines,
} from "./support/numbered-base";

const SIZES = [50, 80, 100, 150, 5000];
const RANGE_BASE = 50;

for (const n of SIZES) {
	describe(`headers on ${n} lines`, () => {
		const base = numberedLines(n).join("\n");

		for (let i = 1; i <= n; i++) {
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

describe(`formatDeleteHeader ranges on ${RANGE_BASE} lines`, () => {
	const base = numberedLines(RANGE_BASE).join("\n");

	for (let start = 1; start <= 10; start++) {
		for (let end = start; end <= start + 5; end++) {
			it(`DEL ${start}.=${end}`, () => {
				const header = formatDeleteHeader(start, end);
				expect(header).toBe(start === end ? `DEL ${start}` : `DEL ${start}.=${end}`);
				const { text } = applyEdits(base, parsePatch(header).edits);
				expectSplicedBase(text, base, numberedLineStart(start), numberedLineStart(end + 1), "");
			});
		}
	}
});
