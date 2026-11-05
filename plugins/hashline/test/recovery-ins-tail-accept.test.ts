import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * Recovery INS.TAIL with late drift.
 */

const PATH = "src/it.ts";

describe("Recovery INS.TAIL accept", () => {
	it("appends with late drift preserved", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["A", "B"]);
		const v1 = linesText(["A", "B-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("INS.TAIL:\n+T").edits,
		});
		if (recovered) {
			expect(recovered.text).toContain("T");
			expect(recovered.text).toContain("B-DRIFT");
		}
	});
});
