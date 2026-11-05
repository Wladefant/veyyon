/**
 * `INS.HEAD` puts its k rows before the base and `INS.TAIL` after it, for every
 * row count k from 1 up, compared on the whole output.
 *
 * Up to 100 rows the check runs on three short bases; the one-line base then
 * continues to 5000 rows. Sampled larger counts are in
 * head-and-tail-inserts-keep-the-base-for-sampled-large-row-counts.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { expectRowsAroundOneLineBase } from "./support/numbered-base";

const SHORT_BASES = [
	["A", "B", "C"],
	["A", "B"],
];
const SHORT_BASE_ROWS = 100;
const SWEPT_ROWS = 5000;

function rows(prefix: string, k: number): string[] {
	return Array.from({ length: k }, (_, i) => `${prefix}${i + 1}`);
}

function insertPatch(op: "INS.HEAD" | "INS.TAIL", inserted: string[]): string {
	return `${op}:\n${inserted.map(row => `+${row}`).join("\n")}`;
}

for (const baseLines of SHORT_BASES) {
	describe(`INS.HEAD and INS.TAIL on a ${baseLines.length}-line base`, () => {
		const base = baseLines.join("\n");

		for (let k = 1; k <= SHORT_BASE_ROWS; k++) {
			it(`HEAD k=${k}`, () => {
				const head = rows("H", k);
				const { text, firstChangedLine } = applyEdits(base, parsePatch(insertPatch("INS.HEAD", head)).edits);
				expect(text.split("\n")).toEqual([...head, ...baseLines]);
				expect(firstChangedLine).toBe(1);
			});

			it(`TAIL k=${k}`, () => {
				const tail = rows("T", k);
				const { text } = applyEdits(base, parsePatch(insertPatch("INS.TAIL", tail)).edits);
				expect(text.split("\n")).toEqual([...baseLines, ...tail]);
			});
		}
	});
}

describe("INS.HEAD and INS.TAIL on a 1-line base", () => {
	for (let k = 1; k <= SWEPT_ROWS; k++) {
		it(`k=${k}`, () => expectRowsAroundOneLineBase(k));
	}
});
