import { describe, expect, it } from "bun:test";
import { applyPatch, linesText } from "./support/apply-patch";

/**
 * Sequential double INS.HEAD / INS.TAIL.
 */

describe("double INS.HEAD / INS.TAIL sequential", () => {
	it("two HEAD inserts stack in reverse chronological order at top", () => {
		let cur = linesText(["body"]);
		cur = applyPatch(cur, "INS.HEAD:\n+H1");
		cur = applyPatch(cur, "INS.HEAD:\n+H2");
		expect(cur).toBe(linesText(["H2", "H1", "body"]));
	});

	it("two TAIL inserts stack in order at bottom", () => {
		let cur = linesText(["body"]);
		cur = applyPatch(cur, "INS.TAIL:\n+T1");
		cur = applyPatch(cur, "INS.TAIL:\n+T2");
		expect(cur).toBe(linesText(["body", "T1", "T2"]));
	});
});
