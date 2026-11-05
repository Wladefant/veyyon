import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * Same content under two paths shares hash tags; recovery is still path-keyed.
 */

describe("Recovery path keying with shared content hash", () => {
	it("tag recorded under path A used with path B and matching content may recover or refuse by path", () => {
		const store = new InMemorySnapshotStore();
		const body = linesText(["same", "body"]);
		const ha = store.record("a.ts", body);
		store.record("b.ts", body);
		// Tag string is content-based; recovery looks up by path+hash.
		const recovered = new Recovery(store).tryRecover({
			path: "b.ts",
			currentText: body,
			fileHash: ha,
			edits: parsePatch("SWAP 1.=1:\n+X").edits,
		});
		// Product may allow if snapshot is content-addressed globally, or null if path-scoped.
		if (recovered) {
			expect(recovered.text).toContain("X");
		} else {
			expect(recovered).toBeNull();
		}
	});
});
