/**
 * INS.HEAD k rows then DEL 1.=k restores original for any base.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits INS.HEAD k then DEL head k", () => {
	for (const k of [1, 2, 5, 8]) {
		for (const base of ["", "body", "a\nb\nc"]) {
			it(`k=${k} base=${JSON.stringify(base)}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
				let t = applyPatch(base, `INS.HEAD:\n${rows}`);
				const del = k === 1 ? "DEL 1" : `DEL 1.=${k}`;
				t = applyPatch(t, del);
				expect(t).toBe(base);
			});
		}
	}
});
