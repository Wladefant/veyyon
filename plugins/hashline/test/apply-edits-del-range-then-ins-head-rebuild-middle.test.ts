/**
 * DEL middle range then INS.HEAD new middle content — documents sequential
 * reindexing (HEAD prepends, does not fill the gap).
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits DEL range then INS.HEAD rebuild middle", () => {
	it("del mid then head prepends not fill", () => {
		let t = "a\nb\nc\nd\ne";
		t = applyPatch(t, "DEL 2.=4");
		expect(t).toBe("a\ne");
		t = applyPatch(t, "INS.HEAD:\n+X\n+Y\n+Z");
		expect(t).toBe("X\nY\nZ\na\ne");
	});

	it("del mid then post after first fills gap area", () => {
		let t = "a\nb\nc\nd\ne";
		t = applyPatch(t, "DEL 2.=4");
		expect(t).toBe("a\ne");
		t = applyPatch(t, "INS.POST 1:\n+X\n+Y\n+Z");
		expect(t).toBe("a\nX\nY\nZ\ne");
	});
});
