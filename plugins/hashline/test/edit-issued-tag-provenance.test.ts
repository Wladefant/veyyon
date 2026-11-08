import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";
import { buildCompactDiffPreview, parsePreviewRow } from "../src/diff-preview";

const PATH = "handler.ts";
const SOURCE = Array.from({ length: 1400 }, (_, index) => {
	const line = index + 1;
	if (line === 1164) return "function earlyHandler() {";
	if (line === 1350) return "async function handleRequest(req: Request) {";
	return `// source line ${line}`;
}).join("\n") + "\n";

function setup() {
	const fs = new InMemoryFilesystem([[PATH, SOURCE]]);
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(PATH, SOURCE);
	snapshots.recordSeenLines(PATH, tag, Array.from({ length: SOURCE.split("\n").length }, (_, index) => index + 1));
	const options = { fs, snapshots, inheritSeenLines: false };
	return { fs, snapshots, patcher: new Patcher(options), tag };
}

function change(line: number, count: number) {
	return `SWAP ${line}.=${line}:\n${Array.from({ length: count }, (_, index) => `+// inserted ${line}-${index + 1}`).join("\n")}`;
}

describe("edit-issued tag provenance", () => {
	it("rejects stale coordinates outside the new tag's displayed preview", async () => {
		const fixture = setup();
		const initial = await fixture.patcher.apply(Patch.parse(`[${PATH}#${fixture.tag}]\nSWAP 1164.=1170:\n${Array.from({ length: 14 }, (_, index) => `+// inserted ${index + 1}`).join("\n")}`));
		const first = initial.sections[0]!;
		const diff = [1164, ...Array.from({ length: 14 }, (_, index) => 1165 + index)]
			.map((line) => `+${line}|${first.after.split("\n")[line - 1]}`)
			.join("\n");
		fixture.patcher.recordPreviewLines(first, buildCompactDiffPreview(diff).preview);
		const beforeRejectedEdit = fixture.fs.get(PATH);
		expect(beforeRejectedEdit).not.toBe(SOURCE);
		await expect(fixture.patcher.apply(Patch.parse(`[${PATH}#${first.fileHash}]\nSWAP 1353.=1359:\n${Array.from({ length: 7 }, (_, index) => `+// replacement ${index + 1}`).join("\n")}`))).rejects.toThrow(/re-read|never displayed/i);
		expect(fixture.fs.get(PATH)).toBe(beforeRejectedEdit);
	});
	it("recovers an unchanged handler through an original tag after an earlier edit shifts it", async () => {
		const fixture = setup();
		await fixture.patcher.apply(Patch.parse(`[${PATH}#${fixture.tag}]\nINS.PRE 1:\n${Array.from({ length: 7 }, (_, index) => `+// inserted ${index + 1}`).join("\n")}`));
		const second = await fixture.patcher.apply(Patch.parse(`[${PATH}#${fixture.tag}]\nSWAP 1350.=1350:\n+async function handleUpdatedRequest(req: Request) {`));
		expect(second.sections[0]!.after).toContain("async function handleUpdatedRequest(req: Request) {");
		expect(second.sections[0]!.after.split("\n")[1356]).toBe("async function handleUpdatedRequest(req: Request) {");
		expect(second.sections[0]!.after).toContain("// inserted 7");
	});


	it("allows multiple hunks shown by the edit-issued tag preview", async () => {
		const fixture = setup();
		const initial = await fixture.patcher.apply(Patch.parse(`[${PATH}#${fixture.tag}]\nSWAP 1164.=1170:\n${Array.from({ length: 14 }, (_, index) => `+// inserted ${index + 1}`).join("\n")}`));
		const first = initial.sections[0]!;
		const changedLines = first.after.split("\n");
		const diff = [1164, 1165, 1178, 1357, 1358, 1359]
			.map((line) => `+${line}|${changedLines[line - 1]}`)
			.join("\n");
		const preview = buildCompactDiffPreview(diff).preview;
		fixture.patcher.recordPreviewLines(first, preview);
		const shownLines = preview.split("\n").map(parsePreviewRow).filter((row) => row !== undefined);
		const second = await fixture.patcher.apply(Patch.parse(`[${PATH}#${first.fileHash}]\n${change(shownLines[1]!.line, 1)}\n${change(shownLines.at(-1)!.line, 1)}`));
		expect(second.sections[0]!.after).toContain(`// inserted ${shownLines[1]!.line}-1`);
	});
});

