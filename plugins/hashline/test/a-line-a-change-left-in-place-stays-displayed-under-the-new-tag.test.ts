/**
 * WHY: the snapshot store records displayed lines per version of a file. After
 * the model read part of a file, a formatter or a shell command changed it,
 * and a ranged read of the changed file minted a new tag with only that range
 * displayed. An edit under the new tag on a line the model had read before the
 * change, which the change left at the same line, was refused as "never
 * displayed".
 *
 * The class closed here: before refusing, the patcher merges the displayed and
 * clipped lines of every other retained version of the path that the change
 * between the two left at the same line: in the unchanged head, in the
 * unchanged tail when the change kept the line count, and between two changes.
 * A version recorded after the tagged one counts as well as one recorded
 * before it. A line the change rewrote, added or moved, a version with no
 * displayed-line record, and another path's version contribute nothing.
 *
 * The diff between the two versions is bounded: past the bound, only lines
 * outside the changed middle carry, and the merge ends in bounded time.
 *
 * Not caught: a version that left the store (the per-path ring or the path's
 * eviction) keeps its provenance without its text, so the lines it displayed
 * cannot be placed in the new version and are refused; and a line inside the
 * middle of a change past the diff bound is refused even when a full diff
 * would pair it.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

const PATH = "probe.ts";
const LINES = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const BEFORE = `${LINES.join("\n")}\n`;

function withLines(edit: (lines: string[]) => void): string {
	const lines = [...LINES];
	edit(lines);
	return `${lines.join("\n")}\n`;
}

/** `BEFORE` with lines 5 and 15 rewritten: lines 1-4, 6-14 and 16-20 stay in place. */
const REWRITTEN = withLines(lines => {
	lines[4] = "changed 5";
	lines[14] = "changed 15";
});
/** `BEFORE` with a line inserted after line 10: lines 11-20 move down by one. */
const INSERTED = withLines(lines => lines.splice(10, 0, "inserted"));

/** A store that holds `before` with `displayed` lines, and the file changed to `after` with line 1 displayed. */
function changedFile(before: string, displayed: readonly number[], after: string) {
	const fs = new InMemoryFilesystem([[PATH, after]]);
	const snapshots = new InMemorySnapshotStore();
	snapshots.record(PATH, before, displayed);
	const tag = snapshots.record(PATH, after, [1]);
	return { fs, snapshots, tag, patcher: new Patcher({ fs, snapshots }) };
}

async function edit(patcher: Patcher, tag: string, body: string): Promise<void> {
	await patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${body}`));
}

describe("a line a change left in place stays displayed under the new tag", () => {
	it("applies an edit on a line displayed before the change, in the head, between the changes and in the tail", async () => {
		for (const line of [2, 10, 18]) {
			const { fs, patcher, tag } = changedFile(BEFORE, [line], REWRITTEN);
			await edit(patcher, tag, `SWAP ${line}.=${line}:\n+edited`);
			expect(fs.get(PATH)).toBe(REWRITTEN.replace(`\nl${line}\n`, "\nedited\n"));
		}
	});

	it("refuses a line the change rewrote", async () => {
		const { fs, patcher, tag } = changedFile(BEFORE, [5, 15], REWRITTEN);
		for (const line of [5, 15]) {
			await expect(edit(patcher, tag, `SWAP ${line}.=${line}:\n+edited`)).rejects.toThrow(/never displayed/);
		}
		expect(fs.get(PATH)).toBe(REWRITTEN);
	});

	it("refuses a line the change moved, and the line the change wrote at its old number", async () => {
		const { fs, patcher, tag } = changedFile(BEFORE, [11, 12], INSERTED);
		for (const line of [11, 12]) {
			await expect(edit(patcher, tag, `SWAP ${line}.=${line}:\n+edited`)).rejects.toThrow(/never displayed/);
		}
		expect(fs.get(PATH)).toBe(INSERTED);
	});

	it("applies an edit on a line displayed in a version recorded after the tagged one", async () => {
		const fs = new InMemoryFilesystem([[PATH, BEFORE]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, BEFORE, [1]);
		snapshots.record(PATH, REWRITTEN, [10]);
		expect(snapshots.record(PATH, BEFORE, [2])).toBe(tag);
		await edit(new Patcher({ fs, snapshots }), tag, "SWAP 10.=10:\n+edited");
		expect(fs.get(PATH)).toBe(BEFORE.replace("\nl10\n", "\nedited\n"));
	});

	it("takes a line displayed clipped as clipped: an insertion beside it applies, a rewrite is refused", async () => {
		function clipped() {
			const fs = new InMemoryFilesystem([[PATH, REWRITTEN]]);
			const snapshots = new InMemorySnapshotStore();
			const before = snapshots.record(PATH, BEFORE, [1]);
			snapshots.recordClippedLines(PATH, before, [10]);
			const tag = snapshots.record(PATH, REWRITTEN, [1]);
			return { fs, tag, patcher: new Patcher({ fs, snapshots }) };
		}
		const inserted = clipped();
		await edit(inserted.patcher, inserted.tag, "INS.POST 10:\n+added");
		expect(inserted.fs.get(PATH)).toBe(REWRITTEN.replace("\nl10\n", "\nl10\nadded\n"));

		const rewritten = clipped();
		await expect(edit(rewritten.patcher, rewritten.tag, "SWAP 10.=10:\n+edited")).rejects.toThrow(/never displayed/);
		expect(rewritten.fs.get(PATH)).toBe(REWRITTEN);
	});

	it("takes nothing from a version with no displayed-line record", async () => {
		const fs = new InMemoryFilesystem([[PATH, REWRITTEN]]);
		const snapshots = new InMemorySnapshotStore();
		snapshots.record(PATH, BEFORE);
		const tag = snapshots.record(PATH, REWRITTEN, [1]);
		await expect(edit(new Patcher({ fs, snapshots }), tag, "SWAP 10.=10:\n+edited")).rejects.toThrow(
			/never displayed/,
		);
		expect(fs.get(PATH)).toBe(REWRITTEN);
	});

	it("takes nothing from a version of another path", async () => {
		const fs = new InMemoryFilesystem([[PATH, REWRITTEN]]);
		const snapshots = new InMemorySnapshotStore();
		snapshots.record("other.ts", BEFORE, [10]);
		const tag = snapshots.record(PATH, REWRITTEN, [1]);
		await expect(edit(new Patcher({ fs, snapshots }), tag, "SWAP 10.=10:\n+edited")).rejects.toThrow(
			/never displayed/,
		);
		expect(fs.get(PATH)).toBe(REWRITTEN);
	});

	it("past its diff bound, carries the lines outside a change throughout a large file and none inside it, in bounded time", async () => {
		const lines = Array.from({ length: 5000 }, (_, i) => `    value ${i + 1}`);
		const before = `${lines.join("\n")}\n`;
		// Lines 10 to 4990 reindented except line 2500, which a full diff pairs with itself.
		const after = `${lines.map((line, i) => (i >= 9 && i < 4990 && i !== 2499 ? line.trimStart() : line)).join("\n")}\n`;
		for (const [line, applies] of [
			[5, true],
			[2500, false],
			[4995, true],
		] as const) {
			const fs = new InMemoryFilesystem([[PATH, after]]);
			const snapshots = new InMemorySnapshotStore();
			snapshots.record(PATH, before, [line]);
			const tag = snapshots.record(PATH, after, [1]);
			const started = performance.now();
			const applied = edit(new Patcher({ fs, snapshots }), tag, `SWAP ${line}.=${line}:\n+edited`);
			if (applies) await applied;
			else await expect(applied).rejects.toThrow(/never displayed/);
			// A full diff of this change takes seconds; the bounded one, under a millisecond.
			expect(performance.now() - started).toBeLessThan(1000);
			expect(fs.get(PATH)).toBe(applies ? after.replace(`\n${lines[line - 1]}\n`, "\nedited\n") : after);
		}
	});
});
