/**
 * INS.TAIL k rows then DEL the last k lines restores original.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits INS.TAIL k then DEL tail k", () => {
	for (const k of [1, 2, 5]) {
		for (const base of ["body", "a\nb\nc"]) {
			it(`k=${k} base=${JSON.stringify(base)}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
				let t = applyPatch(base, `INS.TAIL:\n${rows}`);
				const n = t.split("\n").length;
				const start = n - k + 1;
				const del = k === 1 ? `DEL ${n}` : `DEL ${start}.=${n}`;
				t = applyPatch(t, del);
				expect(t).toBe(base);
			});
		}
	}
});
