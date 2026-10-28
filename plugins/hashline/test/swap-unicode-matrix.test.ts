import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * SWAP with unicode bodies across multiple line positions.
 */

describe("SWAP unicode matrix", () => {
	const glyphs = ["日", "本", "語", "🙂", "é", "Ω", "中"];

	it("replaces each line with a unicode glyph", () => {
		const src = linesText(glyphs.map((_, i) => `L${i}`));
		for (let i = 0; i < glyphs.length; i++) {
			const out = applyPatch(src, `SWAP ${i + 1}.=${i + 1}:\n+${glyphs[i]}`);
			const lines = out.split("\n").filter((l, idx, a) => idx < a.length - 1 || l);
			expect(lines[i]).toBe(glyphs[i]!);
		}
	});

	it("replaces entire file of unicode with one line", () => {
		const src = linesText(["一", "二", "三"]);
		const out = applyPatch(src, "SWAP 1.=3:\n+合");
		expect(out).toBe(linesText(["合"]));
	});

	it("emoji multi-line body swap", () => {
		const src = linesText(["x"]);
		const out = applyPatch(src, "SWAP 1.=1:\n+🙂\n+🎉");
		expect(out).toBe(linesText(["🙂", "🎉"]));
	});
});
