/**
 * WHY: the snapshot store is where every producer mints the tag a model edits with, and the
 * patcher hashes the file BOM-stripped. A store that hashed the text it was handed minted, for a
 * reader that keeps a BOM on line 1, a tag the patcher never computes, so every edit made with it
 * was rejected as a file changed since the read, or went through only by stale-tag recovery.
 *
 * The invariant pinned here sits at that one choke point: a text recorded with a leading BOM gets
 * the tag of the same text without it, is the same version as that text, and a patch that names
 * the tag applies to the file on disk -- BOM, LF or CRLF -- with no warning, on line 1 and on
 * every other line. The coding-agent suite drives the same defect through the read and edit tools.
 *
 * Not caught: a producer that computes a tag itself instead of recording through the store.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	normalizeToLF,
	Patch,
	Patcher,
} from "@veyyon/hashline";

const BOM = "\uFEFF";
const BODY = ["one", "two", "three"];

describe("a snapshot of a text with a BOM carries the tag the patcher computes", () => {
	it("records the text without its BOM, as one version with the BOM-free text", () => {
		const text = "one\ntwo\n";
		const store = new InMemorySnapshotStore();
		const withBom = store.record("f.txt", `${BOM}${text}`);
		const without = store.record("f.txt", text);
		expect({ withBom, without }).toEqual({ withBom: computeFileHash(text), without: computeFileHash(text) });
		expect(store.versions("f.txt").map(version => version.text)).toEqual([text]);
		expect(store.byContent("f.txt", text)?.hash).toBe(withBom);
	});

	for (const eol of ["\n", "\r\n"]) {
		for (const target of [1, 2, 3]) {
			it(`a tag minted over the BOM-carrying ${eol === "\n" ? "LF" : "CRLF"} lines edits line ${target}`, async () => {
				const disk = `${BOM}${BODY.join(eol)}${eol}`;
				const fs = new InMemoryFilesystem([["f.txt", disk]]);
				const snapshots = new InMemorySnapshotStore();
				// What a line-streaming reader hands the store: the lines as read, BOM still on line 1.
				const tag = snapshots.record("f.txt", normalizeToLF(disk));
				const patcher = new Patcher({ fs, snapshots });

				const { sections } = await patcher.apply(
					Patch.parse(`${formatHashlineHeader("f.txt", tag)}\nSWAP ${target}.=${target}:\n+CHANGED`),
				);

				expect(sections.map(section => section.warnings)).toEqual([[]]);
				const expected = BODY.map((line, index) => (index + 1 === target ? "CHANGED" : line));
				expect(fs.get("f.txt")).toBe(`${BOM}${expected.join(eol)}${eol}`);
			});
		}
	}
});
