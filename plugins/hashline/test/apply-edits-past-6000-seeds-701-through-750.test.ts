/**
 * Seeded walks for seeds 701..750: 20 ops each, exact non-throw + final string type.
 * Why: expands pure LCG coverage past the 651-700 band with more ops per seed.
 */
import { describe, expect, it } from "bun:test";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";
import { applyPatch } from "./support/apply-patch";
import { seedBand } from "./support/seed-band";

describe("applyEdits past 6000 seeds 701 through 750", () => {
	for (const seed of seedBand(701, 750)) {
		it(`seed=${seed}`, () => {
			const next = lcgUint32(seed);
			let t = "a\nb\nc";
			for (let i = 0; i < 20; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 5;
				if (n === 0 || op === 0) t = applyPatch(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = applyPatch(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = applyPatch(t, `DEL ${(next() % n) + 1}`);
				else if (op === 3) {
					const line = (next() % n) + 1;
					t = applyPatch(t, `SWAP ${line}.=${line}:\n+S${i}`);
				} else {
					const line = (next() % n) + 1;
					t = applyPatch(t, `INS.POST ${line}:\n+P${i}`);
				}
			}
			expect(typeof t).toBe("string");
			if (t !== "") expect(t.split("\n").length).toBeGreaterThan(0);
		});
	}
});
