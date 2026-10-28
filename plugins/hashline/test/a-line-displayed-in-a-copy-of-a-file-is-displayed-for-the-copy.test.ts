/**
 * WHY: the snapshot store records displayed lines per path, while a tag is a
 * hash of the content. When a file was copied (a `cp` of a versioned script, a
 * draft worktree of the same crate) and the model read the original, a ranged
 * read of the copy minted the same tag with only that range displayed, and an
 * edit of the copy on a line the model had read in the original was refused as
 * "never displayed".
 *
 * The class closed here: before refusing, the patcher merges the displayed and
 * clipped lines of every other version with the same text, whether the store
 * still holds it or dropped it and kept its provenance. A version with no
 * displayed-line record, or a different text that shares the 4-hex tag,
 * contributes nothing.
 *
 * Not caught: a copy whose text differs by any byte, such as line endings or a
 * BOM the store normalized differently; it is a different text and is refused.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

const TEN = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
const COPY = "copy.ts";
const ORIGINAL = "original.ts";

function fixture(options?: ConstructorParameters<typeof InMemorySnapshotStore>[0]) {
	const fs = new InMemoryFilesystem([
		[ORIGINAL, TEN],
		[COPY, TEN],
	]);
	const snapshots = new InMemorySnapshotStore(options);
	return { fs, snapshots, patcher: new Patcher({ fs, snapshots }) };
}

async function editCopy(patcher: Patcher, tag: string, body: string): Promise<void> {
	await patcher.apply(Patch.parse(`[${COPY}#${tag}]\n${body}`));
}

/** A text other than `TEN` whose 4-hex tag equals `TEN`'s, built by `candidate`. */
function collidingText(candidate: (i: number) => string): string {
	const tag = computeFileHash(TEN);
	for (let i = 0; ; i++) {
		const text = candidate(i);
		if (text !== TEN && computeFileHash(text) === tag) return text;
	}
}

/** Colliding texts of `TEN`'s length, whose first three lines are a hex counter, and longer. */
const COLLIDING = [
	collidingText(i => `${i.toString(16).padStart(8, "0")}${TEN.slice(8)}`),
	collidingText(i => `${TEN}collide ${i}\n`),
];

describe("a line displayed in a copy of a file is displayed for the copy", () => {
	it("applies an edit on a line displayed only in the original", async () => {
		const { fs, snapshots, patcher } = fixture();
		snapshots.record(ORIGINAL, TEN, [1, 2, 3]);
		const tag = snapshots.record(COPY, TEN, [9]);
		await editCopy(patcher, tag, "SWAP 2.=2:\n+changed 2");
		expect(fs.get(COPY)).toBe(TEN.replace("l2\n", "changed 2\n"));
	});

	it("still refuses a line neither file displayed", async () => {
		const { fs, snapshots, patcher } = fixture();
		snapshots.record(ORIGINAL, TEN, [1, 2, 3]);
		const tag = snapshots.record(COPY, TEN, [9]);
		await expect(editCopy(patcher, tag, "SWAP 5.=5:\n+changed 5")).rejects.toThrow(/never displayed/);
		expect(fs.get(COPY)).toBe(TEN);
	});

	it("takes a line the original displayed clipped as clipped, held or dropped: an insertion beside it applies, a rewrite is refused", async () => {
		/** A copy whose original displayed line 1 in full and line 3 clipped, then optionally left the store. */
		function clippedOriginal(dropped: boolean) {
			const fixed = fixture({ maxPaths: 2 });
			const originalTag = fixed.snapshots.record(ORIGINAL, TEN, [1]);
			fixed.snapshots.recordClippedLines(ORIGINAL, originalTag, [3]);
			if (dropped) {
				fixed.snapshots.record("other1.ts", "x\n", [1]);
				fixed.snapshots.record("other2.ts", "y\n", [1]);
				expect(fixed.snapshots.head(ORIGINAL)).toBeNull();
			}
			return { ...fixed, tag: fixed.snapshots.record(COPY, TEN, [9]) };
		}
		for (const dropped of [false, true]) {
			const inserted = clippedOriginal(dropped);
			await editCopy(inserted.patcher, inserted.tag, "INS.POST 3:\n+inserted");
			expect(inserted.fs.get(COPY)).toBe(TEN.replace("l3\n", "l3\ninserted\n"));

			const rewritten = clippedOriginal(dropped);
			await expect(editCopy(rewritten.patcher, rewritten.tag, "SWAP 3.=3:\n+changed 3")).rejects.toThrow(
				/never displayed/,
			);
			expect(rewritten.fs.get(COPY)).toBe(TEN);
		}
	});

	it("takes the lines the original displayed before the store dropped it, and keeps them for the original", async () => {
		const { fs, snapshots, patcher } = fixture({ maxPaths: 2 });
		snapshots.record(ORIGINAL, TEN, [1, 2]);
		snapshots.record("other1.ts", "x\n", [1]);
		snapshots.record("other2.ts", "y\n", [1]);
		expect(snapshots.head(ORIGINAL)).toBeNull();
		const tag = snapshots.record(COPY, TEN, [9]);
		await editCopy(patcher, tag, "SWAP 2.=2:\n+changed 2");
		expect(fs.get(COPY)).toBe(TEN.replace("l2\n", "changed 2\n"));
		snapshots.record(ORIGINAL, TEN, [5]);
		expect([...(snapshots.byContent(ORIGINAL, TEN)?.seenLines ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 5]);
	});

	it("takes nothing from an original with no displayed-line record", async () => {
		const { fs, snapshots, patcher } = fixture();
		snapshots.record(ORIGINAL, TEN);
		const tag = snapshots.record(COPY, TEN, [9]);
		await expect(editCopy(patcher, tag, "SWAP 2.=2:\n+changed 2")).rejects.toThrow(/never displayed/);
		expect(fs.get(COPY)).toBe(TEN);
	});

	it("takes nothing from a different text that shares the tag, of the same length or not, held or dropped", async () => {
		const tag = computeFileHash(TEN);
		expect(COLLIDING[0]!.length).toBe(TEN.length);
		for (const colliding of COLLIDING) {
			for (const dropped of [false, true]) {
				const { fs, snapshots, patcher } = fixture({ maxPaths: 2 });
				fs.set(ORIGINAL, colliding);
				snapshots.record(ORIGINAL, colliding, [1, 2, 3]);
				if (dropped) {
					snapshots.record("other1.ts", "x\n", [1]);
					snapshots.record("other2.ts", "y\n", [1]);
					expect(snapshots.head(ORIGINAL)).toBeNull();
				}
				expect(snapshots.record(COPY, TEN, [9])).toBe(tag);
				await expect(editCopy(patcher, tag, "SWAP 2.=2:\n+changed 2")).rejects.toThrow(/never displayed/);
				expect(fs.get(COPY)).toBe(TEN);
			}
		}
	});
});
