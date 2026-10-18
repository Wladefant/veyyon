import { describe, expect, it } from "bun:test";
import * as diffModule from "@veyyon/coding-agent/edit/diff";
import { generateDiffString, generateUnifiedDiffString } from "@veyyon/coding-agent/edit/diff";
import * as Diff from "diff";

/**
 * WHY: both diff generators handed jsdiff the two whole files, and jsdiff splits and compares every line,
 * so an edit to one line of a 3.5 MB source held the event loop 44-67 ms per diff. Each generator now cuts
 * the lines both texts start and end with, diffs the rest, and frames it with the unchanged context.
 *
 * The class closed: a generator that compares lines outside the changed span (the cost contract below), and
 * a trimmed diff that is wrong at a cut — a row naming the wrong line, a hunk that does not rebuild the new
 * text, a diff that is no longer minimal, a first changed line that moved, short leading or trailing context,
 * or a missing or extra "No newline at end of file" row. The sweep runs every `*DiffString` export.
 *
 * Gaps: an edit placed inside a run of identical lines can sit at a different line than a whole-file diff
 * puts it (as GNU diff and git place it), so the rows are checked for validity, not for byte equality with
 * whole-file jsdiff. The cost contract skips the boundary-row pass, whose whole-file line splits are not part
 * of this defect.
 */

type DiffGenerator = (oldContent: string, newContent: string, contextLines?: number) => Promise<diffModule.DiffResult>;

const GENERATORS: Record<string, DiffGenerator> = { generateDiffString, generateUnifiedDiffString };

const NUMBERED_ROW = /^([ +-])(\d+)\|(.*)$/s;
const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/;

function linesOf(text: string): string[] {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The first changed line, in new-file coordinates, and the line counts a minimal diff adds and removes. */
function wholeFileDiff(oldContent: string, newContent: string): { first?: number; added: number; removed: number } {
	let line = 1;
	let first: number | undefined;
	let added = 0;
	let removed = 0;
	for (const part of Diff.diffLines(oldContent, newContent)) {
		const count = part.count ?? 0;
		if ((part.added || part.removed) && first === undefined) first = line;
		if (part.removed) removed += count;
		else {
			line += count;
			if (part.added) added += count;
		}
	}
	return { first, added, removed };
}

/** Every way the rows of one generated diff fail to describe `oldContent` -> `newContent`. */
function violations(
	name: string,
	oldContent: string,
	newContent: string,
	context: number,
	result: diffModule.DiffResult,
): string[] {
	const found: string[] = [];
	const oldLines = linesOf(oldContent);
	const newLines = linesOf(newContent);
	const whole = wholeFileDiff(oldContent, newContent);
	const rows = result.diff === "" ? [] : result.diff.split("\n");
	const unified = name === "generateUnifiedDiffString";
	const oldOpen = oldContent !== "" && !oldContent.endsWith("\n");
	const newOpen = newContent !== "" && !newContent.endsWith("\n");

	if (result.firstChangedLine !== whole.first)
		found.push(`first changed line ${result.firstChangedLine} vs ${whole.first}`);

	const numbered: { kind: string; line: number }[] = [];
	const rebuilt: string[] = [];
	let copied = 0;
	let added = 0;
	let removed = 0;
	let markersDue = 0;
	let markers = 0;
	let hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number } | undefined;
	let hunkOld = 0;
	let hunkNew = 0;
	let firstOldRow: number | undefined;
	const closeHunk = () => {
		if (!hunk) return;
		if (hunkOld !== hunk.oldLines || hunkNew !== hunk.newLines) found.push(`hunk counts ${hunkOld},${hunkNew}`);
		if (firstOldRow !== undefined && firstOldRow !== hunk.oldStart) found.push(`hunk start ${hunk.oldStart}`);
	};
	for (const row of rows) {
		const header = HUNK_HEADER.exec(row);
		if (header) {
			closeHunk();
			hunk = {
				oldStart: Number(header[1]),
				oldLines: Number(header[2]),
				newStart: Number(header[3]),
				newLines: Number(header[4]),
			};
			if (hunk.newStart - hunk.oldStart !== added - removed) found.push(`hunk new start ${row}`);
			// jsdiff starts a hunk with no old lines at the old line it inserts before.
			while (copied < hunk.oldStart - 1) rebuilt.push(oldLines[copied++]);
			hunkOld = 0;
			hunkNew = 0;
			firstOldRow = undefined;
			continue;
		}
		if (row === "\\ No newline at end of file") {
			markers++;
			continue;
		}
		const match = NUMBERED_ROW.exec(row);
		if (!match) {
			found.push(`unparsed row ${JSON.stringify(row)}`);
			continue;
		}
		const [, kind, number, text] = match;
		const line = Number(number);
		numbered.push({ kind, line });
		if (kind === "+") {
			added++;
			hunkNew++;
			if (newLines[line - 1] !== text) found.push(`+${line} is not new line ${line}`);
			if (newOpen && line === newLines.length) markersDue++;
			rebuilt.push(text);
			continue;
		}
		if (oldLines[line - 1] !== text) found.push(`${kind}${line} is not old line ${line}`);
		if (oldOpen && line === oldLines.length) markersDue++;
		firstOldRow ??= line;
		hunkOld++;
		while (copied < line - 1) rebuilt.push(oldLines[copied++]);
		copied = line;
		if (kind === "-") removed++;
		else {
			hunkNew++;
			rebuilt.push(text);
		}
	}
	closeHunk();

	if (added !== whole.added || removed !== whole.removed) {
		found.push(`+${added}-${removed} is not the minimal +${whole.added}-${whole.removed}`);
	}
	if (unified) {
		while (copied < oldLines.length) rebuilt.push(oldLines[copied++]);
		if (JSON.stringify(rebuilt) !== JSON.stringify(newLines)) found.push("hunks do not rebuild the new text");
		if (markers !== markersDue) found.push(`${markers} end-of-file markers where ${markersDue} are due`);
	}

	const firstChange = numbered.findIndex(row => row.kind !== " ");
	if (firstChange !== -1) {
		const before = Math.min(context, (result.firstChangedLine ?? 1) - 1);
		if (firstChange !== before) found.push(`${firstChange} leading context rows where ${before} are due`);
		let lastChange = numbered.length - 1;
		while (numbered[lastChange].kind === " ") lastChange--;
		const last = numbered[lastChange];
		const after = Math.min(context, (last.kind === "+" ? newLines.length : oldLines.length) - last.line);
		const trailing = numbered.length - 1 - lastChange;
		if (trailing !== after) found.push(`${trailing} trailing context rows where ${after} are due`);
	}
	return found;
}

/** A deterministic text of short lines over a small alphabet: runs of identical lines are where cuts go wrong. */
function sampleText(next: () => number, alphabet: number, maxLines: number): string {
	let text = next() < 0.1 ? "\n" : "";
	const count = Math.floor(next() * maxLines);
	for (let line = 0; line < count; line++) {
		text += `${String.fromCharCode(65 + Math.floor(next() * alphabet))}${next() < 0.05 ? "\r" : ""}\n`;
	}
	if (next() < 0.3) text += String.fromCharCode(65 + Math.floor(next() * alphabet));
	return text;
}

function samplePairs(count: number): [string, string][] {
	let seed = 20261018;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const pairs: [string, string][] = [
		["", ""],
		["", "A\n"],
		["A\n", ""],
		["A", "A\n"],
		["A\nB", "A\nB\n"],
		["\nA\n", "B\nA\n"],
		["\n\nA\n", "\nB\nA\n"],
		["A\nB\nC\n", "A\nB\nC\n"],
		["A\nA\nA\nA\nA\nA\nA\nA\n", "A\nA\nA\nB\nA\nA\nA\nA\nA\n"],
		["A\r\nB\r\nC\r\n", "A\r\nX\r\nC\r\n"],
	];
	// Texts past the 4096-unit compare block, edited on each side of a block edge from either end, so
	// the prefix and suffix scans run their block compare and their per-unit tail.
	let long = "";
	while (long.length < 3 * 4096) long += `${String.fromCharCode(65 + Math.floor(next() * 3))}\n`;
	for (const offset of [4095, 4096, 4097, 8191, 8192, 8193]) {
		for (const at of [offset, long.length - offset]) {
			pairs.push([long, `${long.slice(0, at)}X${long.slice(at)}`]);
			pairs.push([long, `${long.slice(0, at)}X${long.slice(at + 1)}`]);
		}
	}
	while (pairs.length < count) {
		const alphabet = 1 + Math.floor(next() * 5);
		const oldContent = sampleText(next, alphabet, 30);
		const from = Math.floor(next() * (oldContent.length + 1));
		const to = from + Math.floor(next() * (oldContent.length + 1 - from));
		const newContent =
			next() < 0.2
				? sampleText(next, alphabet, 30)
				: oldContent.slice(0, from) + sampleText(next, alphabet, 4) + oldContent.slice(to);
		pairs.push([oldContent, newContent]);
	}
	return pairs;
}

describe("a diff compares only the lines that changed", () => {
	it("sweeps every diff generator the module exports", () => {
		const exported = Object.keys(diffModule)
			.filter(name => name.endsWith("DiffString"))
			.sort();
		expect(exported).toEqual(Object.keys(GENERATORS).sort());
	});

	it.each(Object.keys(GENERATORS))("%s describes the edit exactly, with full context, at every cut", async name => {
		const generate = GENERATORS[name];
		const failures: string[] = [];
		for (const [oldContent, newContent] of samplePairs(1200)) {
			for (const context of [0, 1, 3]) {
				const result = await generate(oldContent, newContent, context);
				for (const violation of violations(name, oldContent, newContent, context, result)) {
					if (failures.length < 5) {
						failures.push(
							`${JSON.stringify(oldContent)} -> ${JSON.stringify(newContent)} @${context}: ${violation}`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it.each(Object.keys(GENERATORS))(
		"%s on one changed line of a 4.5 MB source costs a fraction of a whole-file jsdiff",
		async name => {
			const generate = GENERATORS[name];
			const units: string[] = [];
			let size = 0;
			for (let n = 0; size < 4.5 * 1024 * 1024; n++) {
				const unit = `export function unit${n}(value: number): number {\n\tconst a = value + ${n};\n\treturn a;\n}\n`;
				units.push(unit);
				size += unit.length;
			}
			const oldContent = units.join("");
			const middle = Math.floor(units.length / 2);
			const newContent = oldContent.replace(`const a = value + ${middle};`, `const a = value - ${middle};`);
			const editedLine = middle * 4 + 2;

			let wholeFile = Number.POSITIVE_INFINITY;
			let generated = Number.POSITIVE_INFINITY;
			let result: diffModule.DiffResult | undefined;
			for (let run = 0; run < 3; run++) {
				let start = performance.now();
				Diff.diffLines(oldContent, newContent);
				wholeFile = Math.min(wholeFile, performance.now() - start);
				start = performance.now();
				result = await generate(oldContent, newContent);
				generated = Math.min(generated, performance.now() - start);
			}

			expect(result?.firstChangedLine).toBe(editedLine);
			expect(result?.diff).toContain(`-${editedLine}|\tconst a = value + ${middle};`);
			expect(result?.diff).toContain(`+${editedLine}|\tconst a = value - ${middle};`);
			expect(generated).toBeLessThan(wholeFile / 4);
		},
	);
});
