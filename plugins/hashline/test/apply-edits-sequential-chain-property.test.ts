/**
 * Sequential applyEdits chains: each step's output is the next input.
 * Exact final line lists for expand→shrink→insert→delete pipelines.
 */
import { describe, expect, it } from "bun:test";
import { applyPatch } from "./support/apply-patch";

describe("applyEdits sequential chain property", () => {
	it("build file from empty via HEAD then mutations", () => {
		let t = "";
		t = applyPatch(t, "INS.HEAD:\n+a\n+b\n+c");
		expect(t).toBe("a\nb\nc");
		t = applyPatch(t, "SWAP 2.=2:\n+B2");
		expect(t).toBe("a\nB2\nc");
		t = applyPatch(t, "INS.POST 2:\n+mid");
		expect(t).toBe("a\nB2\nmid\nc");
		t = applyPatch(t, "DEL 1");
		expect(t).toBe("B2\nmid\nc");
		t = applyPatch(t, "INS.TAIL:\n+z");
		expect(t).toBe("B2\nmid\nc\nz");
		t = applyPatch(t, "DEL 1.=4");
		expect(t).toBe("");
	});

	for (const n of [3, 5, 8]) {
		it(`del from front until empty n=${n}`, () => {
			let t = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			for (let i = 0; i < n; i++) {
				t = applyPatch(t, "DEL 1");
			}
			expect(t).toBe("");
		});

		it(`del from back until empty n=${n}`, () => {
			let t = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
			for (let left = n; left >= 1; left--) {
				t = applyPatch(t, `DEL ${left}`);
			}
			expect(t).toBe("");
		});
	}

	it("expand mid then shrink same region back", () => {
		const base = "a\nb\nc\nd\ne";
		const expanded = applyPatch(base, "SWAP 2.=4:\n+X\n+Y\n+Z\n+W");
		expect(expanded).toBe("a\nX\nY\nZ\nW\ne");
		const shrunk = applyPatch(expanded, "SWAP 2.=5:\n+b\n+c\n+d");
		expect(shrunk).toBe("a\nb\nc\nd\ne");
	});

	it("INS.HEAD stack then DEL head count restores original", () => {
		const base = "body";
		let t = applyPatch(base, "INS.HEAD:\n+h1\n+h2\n+h3");
		expect(t).toBe("h1\nh2\nh3\nbody");
		t = applyPatch(t, "DEL 1.=3");
		expect(t).toBe("body");
	});
});
