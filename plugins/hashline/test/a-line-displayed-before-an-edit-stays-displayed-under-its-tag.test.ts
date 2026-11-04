/**
 * WHY: the patcher recorded the edited text as a new snapshot version with no
 * displayed lines, so the seen-line check was skipped for it. The first ranged
 * read under the new tag then recorded only its own range, and an edit on a
 * line read before the edit, a line the edit wrote, or a line the edit result
 * showed was refused as "never displayed".
 *
 * The class closed here: an edit carries onto the edited version every line it
 * wrote and every displayed or clipped line it left unchanged, at its new
 * position; `recordPreviewLines` adds the rows the edit result showed. A
 * version that had no displayed-line record before the edit, or that the store
 * no longer holds, stays editable at every line. When the file changed outside
 * the session since the tagged read, only the read's lines the change left in
 * place carry, since the model cannot know where a moved line went: a line the
 * change rewrote, added or moved is not displayed. Each hunk keyword of
 * the patch language is swept in
 * `packages/coding-agent/test/edit/a-line-shown-by-an-edit-stays-editable-after-a-later-read.test.ts`
 * through the production read and edit tools.
 *
 * Not caught: a line paired with the wrong unchanged line when lines repeat;
 * the pairing is covered in `a-line-map-pairs-unchanged-lines-like-a-full-diff.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	type PatchSectionResult,
} from "@veyyon/hashline";

const PATH = "a.ts";
const TEN = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`;

interface Fixture {
	fs: InMemoryFilesystem;
	snapshots: InMemorySnapshotStore;
	patcher: Patcher;
	tag: string;
}

function readOf(seen?: number[], clipped?: number[]): Fixture {
	const fs = new InMemoryFilesystem([[PATH, TEN]]);
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(PATH, TEN, seen);
	if (clipped) snapshots.recordClippedLines(PATH, tag, clipped);
	return { fs, snapshots, patcher: new Patcher({ fs, snapshots }), tag };
}

async function edit(fixture: Fixture, path: string, tag: string, body: string): Promise<PatchSectionResult> {
	const result = await fixture.patcher.apply(Patch.parse(`[${path}#${tag}]\n${body}`));
	return result.sections[0]!;
}

/** Edit, then a ranged read of `laterRead` under the edited tag, as the read tool records it. */
async function editThenRead(fixture: Fixture, body: string, laterRead: number[], path = PATH) {
	const result = await edit(fixture, PATH, fixture.tag, body);
	expect(fixture.snapshots.record(path, result.after, laterRead)).toBe(result.fileHash);
	return result;
}

function swaps(lines: number[]): string {
	return lines.map(line => `SWAP ${line}.=${line}:\n+changed ${line}`).join("\n");
}

describe("a line displayed before an edit stays displayed under the edited tag", () => {
	it("keeps the lines an earlier read displayed, at their new positions", async () => {
		const fixture = readOf([1, 2, 3, 8]);
		const result = await editThenRead(fixture, "INS.POST 2:\n+new1\n+new2", [12]);
		// l1 l2 new1 new2 l3 l4 l5 l6 l7 l8 l9 l10: l3 moved to 5, l8 to 10.
		await edit(fixture, PATH, result.fileHash, swaps([1, 2, 3, 4, 5, 10, 12]));
		expect(fixture.fs.get(PATH)).toContain("changed 10\n");
	});

	it("keeps every line the edit wrote, including a run too long for a preview to show", async () => {
		const fixture = readOf([1, 2, 3]);
		const run = Array.from({ length: 12 }, (_, i) => `+w${i}`).join("\n");
		const result = await editThenRead(fixture, `SWAP 2.=2:\n${run}`, [21]);
		await edit(fixture, PATH, result.fileHash, swaps([2, 8, 13]));
		expect(fixture.fs.get(PATH)).toContain("changed 8\n");
	});

	it("still refuses a line no read displayed and the edit did not write", async () => {
		const fixture = readOf([1, 2, 3, 8]);
		const result = await editThenRead(fixture, "INS.POST 2:\n+new1\n+new2", [12]);
		const before = fixture.fs.get(PATH);
		// Line 6 is l4, which no read showed.
		await expect(edit(fixture, PATH, result.fileHash, swaps([6]))).rejects.toThrow(/never displayed \(it showed/);
		expect(fixture.fs.get(PATH)).toBe(before);
	});

	it("keeps a clipped line clipped: an insertion beside it applies", async () => {
		const fixture = readOf([1], [5]);
		const result = await editThenRead(fixture, "INS.HEAD:\n+top", [11]);
		await edit(fixture, PATH, result.fileHash, "INS.POST 6:\n+beside");
		expect(fixture.fs.get(PATH)).toContain("l5\nbeside\n");
	});

	it("keeps a clipped line clipped: a rewrite of it is refused", async () => {
		const fixture = readOf([1], [5]);
		const result = await editThenRead(fixture, "INS.HEAD:\n+top", [11]);
		await expect(edit(fixture, PATH, result.fileHash, swaps([6]))).rejects.toThrow(/never displayed/);
	});

	it("leaves every line editable when the edited version had no displayed-line record", async () => {
		const fixture = readOf();
		const result = await editThenRead(fixture, swaps([2]), [11]);
		await edit(fixture, PATH, result.fileHash, swaps([7]));
		expect(fixture.fs.get(PATH)).toContain("changed 7\n");
	});

	it("leaves a retained version without a record unrestricted when an edit returns to its text", async () => {
		const fixture = readOf([2]);
		const target = TEN.replace("l2\n", "changed 2\n");
		fixture.snapshots.record(PATH, target);
		fixture.snapshots.record(PATH, TEN);
		const result = await edit(fixture, PATH, fixture.tag, swaps([2]));
		expect(result.after).toBe(target);
		fixture.patcher.recordPreviewLines(result, "1:l1\n2:changed 2\n3:l3");
		await edit(fixture, PATH, result.fileHash, swaps([9]));
		expect(fixture.fs.get(PATH)).toContain("changed 9\n");
	});

	it("carries the displayed lines to the destination of a move", async () => {
		const fixture = readOf([1, 2]);
		const result = await editThenRead(fixture, "SWAP 2.=2:\n+TWO\nMV b.ts", [9], "b.ts");
		await expect(edit(fixture, "b.ts", result.fileHash, swaps([5]))).rejects.toThrow(/never displayed/);
		await edit(fixture, "b.ts", result.fileHash, swaps([1, 2]));
		expect(fixture.fs.get("b.ts")).toBe(TEN.replace("l1\nl2\n", "changed 1\nchanged 2\n"));
	});
});

describe("the rows an edit result showed become displayed lines", () => {
	it("marks each row that holds its line verbatim", async () => {
		const fixture = readOf([1, 2, 3]);
		const result = await edit(fixture, PATH, fixture.tag, swaps([2]));
		fixture.patcher.recordPreviewLines(result, "1:l1\n2:changed 2\n3:l3\n4:l4\n…\n6:l6");
		fixture.snapshots.record(PATH, result.after, [11]);
		await edit(fixture, PATH, result.fileHash, swaps([4, 6]));
		expect(fixture.fs.get(PATH)).toContain("changed 4\nl5\nchanged 6\n");
	});

	it("ignores a row whose text is not the line it numbers", async () => {
		const fixture = readOf([1, 2, 3]);
		const result = await edit(fixture, PATH, fixture.tag, swaps([2]));
		fixture.patcher.recordPreviewLines(result, "4:l5\n5:l5x\n6:l");
		await expect(edit(fixture, PATH, result.fileHash, swaps([4]))).rejects.toThrow(/never displayed/);
		await expect(edit(fixture, PATH, result.fileHash, swaps([5]))).rejects.toThrow(/never displayed/);
		await expect(edit(fixture, PATH, result.fileHash, swaps([6]))).rejects.toThrow(/never displayed/);
	});
});

/** `TEN` changed outside the session in place: `l9` rewritten and a line appended. */
const CHANGED = `${TEN.replace("l9\n", "ext9\n")}ext11\n`;
/** `TEN` changed outside the session by a line above every line, which moves each one. */
const SHIFTED = `ext0\n${TEN}`;

/** A fixture whose file no read was recorded for, under the tag of `TEN`. */
function untracked(): Fixture {
	const fs = new InMemoryFilesystem([[PATH, TEN]]);
	const snapshots = new InMemorySnapshotStore();
	return { fs, snapshots, patcher: new Patcher({ fs, snapshots }), tag: computeFileHash(TEN) };
}

describe("an edit applied without a retained pre-edit version", () => {
	it("leaves every line editable after an edit under a tag the store does not hold", async () => {
		const fixture = untracked();
		const result = await editThenRead(fixture, swaps([2]), [11]);
		await edit(fixture, PATH, result.fileHash, swaps([2, 7]));
		expect(fixture.fs.get(PATH)).toContain("changed 7\n");
	});

	it("takes nothing from a retained text that only shares the tag of the file the edit applied to", async () => {
		const fixture = untracked();
		let other = "";
		for (let i = 0; computeFileHash(other) !== fixture.tag; i++) other = `${TEN}collide ${i}\n`;
		fixture.snapshots.record(PATH, other, [1]);
		const result = await editThenRead(fixture, swaps([2]), [11]);
		await edit(fixture, PATH, result.fileHash, swaps([2, 7]));
		expect(fixture.fs.get(PATH)).toContain("changed 7\n");
	});

	it("leaves every line editable after a head insertion onto a changed file whose tag the store does not hold", async () => {
		const fixture = untracked();
		fixture.fs.set(PATH, SHIFTED);
		const result = await editThenRead(fixture, "INS.HEAD:\n+top", [13]);
		expect(result.warnings?.join("\n")).toContain("INS.HEAD");
		await edit(fixture, PATH, result.fileHash, swaps([1, 2, 11]));
		expect(fixture.fs.get(PATH)).toContain("changed 11\n");
	});

	it("keeps the tagged read's lines the change left in place, at the positions the edit moved them to", async () => {
		const fixture = readOf([1, 2, 3, 8]);
		fixture.fs.set(PATH, CHANGED);
		const result = await editThenRead(fixture, "INS.POST 2:\n+new", [12]);
		// l1 l2 new l3 l4 l5 l6 l7 l8 ext9 l10 ext11: l3 is at 4, l8 at 9.
		expect(result.after).toBe(`l1\nl2\nnew\n${CHANGED.slice(6)}`);
		await edit(fixture, PATH, result.fileHash, swaps([1, 2, 3, 4, 9, 12]));
		expect(fixture.fs.get(PATH)).toContain("changed 9\next9\n");
	});

	it("refuses a line the change rewrote or added, and a line the tagged read never displayed", async () => {
		const fixture = readOf([1, 2, 3, 8, 9]);
		fixture.fs.set(PATH, CHANGED);
		const result = await edit(fixture, PATH, fixture.tag, "INS.POST 2:\n+new");
		const before = fixture.fs.get(PATH);
		// ext9, displayed as l9, is at 10; ext11 at 12; l5, never displayed, at 6.
		for (const line of [10, 12, 6]) {
			await expect(edit(fixture, PATH, result.fileHash, swaps([line]))).rejects.toThrow(/never displayed/);
		}
		expect(fixture.fs.get(PATH)).toBe(before);
	});

	it("refuses a line the change moved, whose new position the read never showed", async () => {
		const fixture = readOf([1, 2, 3, 8]);
		fixture.fs.set(PATH, SHIFTED);
		const result = await editThenRead(fixture, swaps([2]), [11]);
		// ext0 l1 changed2 l3 l4 l5 l6 l7 l8 l9 l10: each line the read displayed moved down one.
		expect(result.after).toBe(`ext0\nl1\nchanged 2\n${TEN.slice(6)}`);
		for (const line of [2, 4, 9]) {
			await expect(edit(fixture, PATH, result.fileHash, swaps([line]))).rejects.toThrow(/never displayed/);
		}
		await edit(fixture, PATH, result.fileHash, swaps([3]));
		expect(fixture.fs.get(PATH)).toContain("changed 3\n");
	});

	it("keeps every line a tagged read without a record shares in place with the changed file", async () => {
		const fixture = readOf();
		fixture.fs.set(PATH, CHANGED);
		const result = await editThenRead(fixture, "INS.POST 2:\n+new", [1]);
		await expect(edit(fixture, PATH, result.fileHash, swaps([10]))).rejects.toThrow(/never displayed/);
		await expect(edit(fixture, PATH, result.fileHash, swaps([12]))).rejects.toThrow(/never displayed/);
		await edit(fixture, PATH, result.fileHash, swaps([6]));
		expect(fixture.fs.get(PATH)).toContain("changed 6\n");
	});

	it("keeps a clipped line of the tagged read the change left in place clipped", async () => {
		const fixture = readOf([1, 2], [5]);
		fixture.fs.set(PATH, CHANGED);
		const result = await editThenRead(fixture, swaps([2]), [11]);
		// A refusal reveals the line it names and marks it displayed, so the insertion goes first.
		const inserted = await edit(fixture, PATH, result.fileHash, "INS.POST 5:\n+beside");
		expect(fixture.fs.get(PATH)).toContain("l5\nbeside\n");
		await expect(edit(fixture, PATH, inserted.fileHash, swaps([5]))).rejects.toThrow(/never displayed/);
	});

	it("does not keep a clipped line of the tagged read the change moved", async () => {
		const fixture = readOf([1], [5]);
		fixture.fs.set(PATH, SHIFTED);
		const result = await editThenRead(fixture, swaps([2]), [11]);
		// l4 is at 5, the clipped l5 at 6.
		for (const line of [5, 6]) {
			await expect(edit(fixture, PATH, result.fileHash, `INS.POST ${line}:\n+beside`)).rejects.toThrow(
				/never displayed/,
			);
		}
	});

	it("keeps the tagged read's lines the change left in place after a tail insertion", async () => {
		const fixture = readOf([1, 2, 3]);
		fixture.fs.set(PATH, CHANGED);
		const result = await editThenRead(fixture, "INS.TAIL:\n+bottom", [11]);
		await expect(edit(fixture, PATH, result.fileHash, swaps([9]))).rejects.toThrow(/never displayed/);
		await edit(fixture, PATH, result.fileHash, swaps([2, 12]));
		expect(fixture.fs.get(PATH)).toContain("changed 12\n");
	});
});
