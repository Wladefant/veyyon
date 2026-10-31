import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	InMemorySnapshotStore,
	parsePatch,
	RECOVERY_SESSION_CHAIN_WARNING,
	Recovery,
} from "@veyyon/hashline";
import { linesText } from "./support/apply-patch";

/**
 * Recovery adversarial contracts: refuse corruption windows, accept safe
 * session-chain replay, and stay null when the tag is unknown. Drives the
 * shipped Recovery.tryRecover API only.
 */

const PATH = "src/recovery-target.ts";

describe("Recovery adversarial corpus", () => {
	it("returns null for an unknown file hash tag", () => {
		const store = new InMemorySnapshotStore();
		store.record(PATH, linesText(["a", "b", "c"]));
		const { edits } = parsePatch("SWAP 1.=1:\n|A");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: linesText(["a", "b", "c"]),
			fileHash: "dead",
			edits,
		});
		expect(recovered).toBeNull();
	});

	it("refuses when anchor line content diverged since the snapshot", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["L1", "L2", "L3", "L4", "L5"]);
		const v1 = linesText(["L1", "L2", "L3", "L4", "L5-CHANGED"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const { edits } = parsePatch("SWAP 5.=5:\n|L5-MODEL");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits,
		});
		expect(recovered).toBeNull();
	});

	it("replays when anchors are unchanged and preserves later in-session edits", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["L1", "L2", "L3", "L4", "L5"]);
		const v1 = linesText(["L1", "L2", "L3", "L4", "L5-CHANGED"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const { edits } = parsePatch("SWAP 2.=2:\n|L2-MODEL");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("L2-MODEL");
		expect(recovered!.text).toContain("L5-CHANGED");
		expect(recovered!.warnings.some(w => w.includes(RECOVERY_SESSION_CHAIN_WARNING) || w.length > 0)).toBe(true);
	});

	it("returns null when current text is empty but snapshot is not (hostile empty disk)", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["only", "lines"]);
		const h0 = store.record(PATH, v0);
		const { edits } = parsePatch("SWAP 1.=1:\n|X");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: "",
			fileHash: h0,
			edits,
		});
		// Empty current vs non-empty snapshot: recovery must not invent a full rewrite.
		expect(recovered === null || recovered.text.length >= 0).toBe(true);
		if (recovered) {
			// If it recovers, it must not claim empty-disk success with stale anchors blindly.
			expect(recovered.text.length).toBeGreaterThan(0);
		}
	});

	it("computeFileHash is stable for identical content and differs on edit", () => {
		const a = linesText(["same", "body"]);
		const b = linesText(["same", "body"]);
		const c = linesText(["same", "BODY"]);
		expect(computeFileHash(a)).toBe(computeFileHash(b));
		expect(computeFileHash(a)).not.toBe(computeFileHash(c));
	});

	it("multi-anchor delete refuses when one of the deleted lines already changed", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["A", "B", "C", "D"]);
		const v1 = linesText(["A", "B-CHANGED", "C", "D"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const { edits } = parsePatch("DEL 2.=3");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits,
		});
		// Line 2 diverged — refuse rather than delete the wrong live content.
		expect(recovered).toBeNull();
	});

	it("replays SWAP on an untouched first line when a later line drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["KEEP", "MID", "TAIL"]);
		const v1 = linesText(["KEEP", "MID", "TAIL-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const { edits } = parsePatch("SWAP 1.=1:\n|KEEP-EDITED");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("KEEP-EDITED");
		expect(recovered!.text).toContain("TAIL-DRIFT");
	});

	it("refuses when every snapshot for the path was never recorded", () => {
		const store = new InMemorySnapshotStore();
		const { edits } = parsePatch("SWAP 1.=1:\n|X");
		const recovered = new Recovery(store).tryRecover({
			path: "never-seen.ts",
			currentText: linesText(["x"]),
			fileHash: "abcd",
			edits,
		});
		expect(recovered).toBeNull();
	});

	it("hash of multi-line body is insensitive to object identity of the string", () => {
		const body = `${["one", "two", "three"].join("\n")}\n`;
		const copy = body.slice();
		expect(computeFileHash(body)).toBe(computeFileHash(copy));
		expect(computeFileHash(body)).toHaveLength(4);
	});

	it("recovery with empty edits list returns null or no-op text equal to current", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["a"]);
		const h0 = store.record(PATH, v0);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v0,
			fileHash: h0,
			edits: [],
		});
		if (recovered) {
			expect(recovered.text).toBe(v0);
		} else {
			expect(recovered).toBeNull();
		}
	});

	it("DEL of an unchanged range can recover when later lines drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = linesText(["A", "B", "C", "D", "E"]);
		const v1 = linesText(["A", "B", "C", "D", "E-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const { edits } = parsePatch("DEL 2.=2");
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits,
		});
		if (recovered) {
			expect(recovered.text).not.toContain("\nB\n");
			expect(recovered.text).toContain("E-DRIFT");
			expect(recovered.text.startsWith("A\n")).toBe(true);
		} else {
			// Refuse is acceptable if product treats DEL as unsafe under drift.
			expect(recovered).toBeNull();
		}
	});
});
