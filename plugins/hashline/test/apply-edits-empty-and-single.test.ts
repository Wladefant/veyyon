import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * applyEdits on empty and single-line files.
 */

describe("applyEdits empty and single-line", () => {
	it("INS.TAIL on single-line appends", () => {
		expect(applyPatch(linesText(["only"]), "INS.TAIL:\n+more")).toBe(linesText(["only", "more"]));
	});

	it("INS.HEAD on single-line prepends", () => {
		expect(applyPatch(linesText(["only"]), "INS.HEAD:\n+more")).toBe(linesText(["more", "only"]));
	});

	it("SWAP only line", () => {
		expect(applyPatch(linesText(["only"]), "SWAP 1.=1:\n+new")).toBe(linesText(["new"]));
	});

	it("DEL only line", () => {
		const out = applyPatch(linesText(["only"]), "DEL 1.=1");
		expect(out === "" || out === "\n").toBe(true);
	});

	it("INS.HEAD on empty-ish newline file", () => {
		const out = applyPatch("\n", "INS.HEAD:\n+X");
		expect(out).toContain("X");
	});
});
