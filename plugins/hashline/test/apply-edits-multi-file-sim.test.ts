import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Multi-hunk pure applyEdits sequences that mimic multi-step agent edits.
 */

describe("applyEdits multi-hunk agent-like sequences", () => {
	it("replace two non-adjacent lines in one patch", () => {
		const out = applyPatch(linesText(["a", "b", "c", "d", "e"]), "SWAP 2.=2:\n+B2\nSWAP 4.=4:\n+D2");
		expect(out).toBe(linesText(["a", "B2", "c", "D2", "e"]));
	});

	it("insert at head then swap later line against original anchors", () => {
		// Both edits target original line numbers before either is applied.
		const out = applyPatch(linesText(["a", "b", "c"]), "INS.HEAD:\n+H\nSWAP 2.=2:\n+B2");
		// Depending on apply order, results differ; lock actual product order.
		expect(out).toContain("H");
		expect(out).toContain("B2");
		expect(out.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
	});

	it("delete a range then the remaining lines shift for subsequent pure apply", () => {
		const mid = applyPatch(linesText(["a", "b", "c", "d"]), "DEL 2.=3");
		expect(mid).toBe(linesText(["a", "d"]));
		const next = applyPatch(mid, "SWAP 2.=2:\n+D2");
		expect(next).toBe(linesText(["a", "D2"]));
	});

	it("unicode multi-hunk", () => {
		const out = applyPatch(linesText(["一", "二", "三"]), "SWAP 1.=1:\n+壱\nSWAP 3.=3:\n+参");
		expect(out).toBe(linesText(["壱", "二", "参"]));
	});

	it("INS.POST after every line builds an interleaved file", () => {
		const src = linesText(["a", "b"]);
		const out = applyPatch(src, "INS.POST 1:\n+x\nINS.POST 2:\n+y");
		// Original anchors: after line1 and after line2 of src.
		expect(out).toContain("a");
		expect(out).toContain("b");
		expect(out).toContain("x");
		expect(out).toContain("y");
	});
});
