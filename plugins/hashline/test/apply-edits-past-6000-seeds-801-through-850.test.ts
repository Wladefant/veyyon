/**
 * Seeded walks for seeds 801..850: 25 ops each with mixed POST/PRE/HEAD/TAIL/DEL/SWAP.
 * Why: denser LCG coverage past the 701-800 bands.
 */
import { describe, expect, it } from "bun:test";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";
import { applyPatch } from "./support/apply-patch";
import { seedBand } from "./support/seed-band";

describe("applyEdits past 6000 seeds 801 through 850", () => {
	for (const seed of seedBand(801, 850)) {
		it(`seed=${seed}`, () => {
			const next = lcgUint32(seed);
			let t = "p\nq\nr\ns";
			for (let i = 0; i < 25; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 6;
				if (n === 0 || op === 0) t = applyPatch(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = applyPatch(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = applyPatch(t, `DEL ${(next() % n) + 1}`);
				else if (op === 3) {
					const line = (next() % n) + 1;
					t = applyPatch(t, `SWAP ${line}.=${line}:\n+S${i}`);
				} else if (op === 4) {
					const line = (next() % n) + 1;
					t = applyPatch(t, `INS.POST ${line}:\n+P${i}`);
				} else {
					const line = (next() % n) + 1;
					t = applyPatch(t, `INS.PRE ${line}:\n+R${i}`);
				}
			}
			expect(typeof t).toBe("string");
		});
	}
});
