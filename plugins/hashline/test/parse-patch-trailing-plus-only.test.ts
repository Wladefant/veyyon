import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * SWAP with a lone + empty body line.
 */

describe("parsePatch trailing plus only", () => {
	it("SWAP with lone + produces edits without throw", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+");
		expect(edits.length).toBeGreaterThan(0);
		const out = applyEdits(linesText(["X"]), edits).text;
		expect(typeof out).toBe("string");
	});
});
