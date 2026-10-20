/**
 * WHY: an edit recorded the edited text as a snapshot version with no displayed
 * lines. The first ranged read under the new tag then recorded only its own
 * range, and an edit on a line read before the edit, a line the edit wrote or a
 * line the edit result showed was refused as "never displayed".
 *
 * This drives the production read and edit tools: a ranged read, an edit with
 * one hunk keyword of the patch language, a ranged read of other lines under the
 * edited tag, then one edit that rewrites every line shown so far. The keywords
 * are read from `@veyyon/hashline/format` at run time, so a new keyword fails
 * the sweep until it has a hunk here. A last case changes the file outside the
 * session between the first read and the edit, which recovery applies onto the
 * changed file: the read's lines stay editable, the changed line does not. The
 * patcher-level cases (clipped lines, versions without a record, preview rows
 * that do not match) are in
 * `plugins/hashline/test/a-line-displayed-before-an-edit-stays-displayed-under-its-tag.test.ts`.
 *
 * Not caught: an edit result cut by the tool-result byte cap, whose preview
 * rows would be marked displayed although they never reached the model.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@veyyon/coding-agent/edit";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import * as format from "@veyyon/hashline/format";
import { removeWithRetries } from "@veyyon/utils";

const SOURCE = [
	"// header one",
	"// header two",
	"const a = 1;",
	"",
	"function beta() {",
	"\treturn 2;",
	"}",
	"",
	"function gamma() {",
	"\treturn 3;",
	"}",
	"const b = 2;",
	...Array.from({ length: 28 }, (_, i) => `const v${i + 13} = ${i + 13};`),
];
const CONTENT = `${SOURCE.join("\n")}\n`;
/** The read before the edit: the head of the file and the opening of `beta`. */
const FIRST_READ = { start: 1, end: 6 };
/** The read after the edit, of lines nothing showed before. */
const LATER_READ = { start: 30, end: 32 };

/** One hunk per keyword, each changing `beta` (lines 5-7) or an end of the file. */
const HUNKS: Record<string, { body: string; dest?: string }> = {
	SWAP: { body: "SWAP 6.=6:\n+\treturn 20;\n+\t// second" },
	DEL: { body: "DEL 6" },
	"INS.PRE": { body: "INS.PRE 6:\n+\t// before" },
	"INS.POST": { body: "INS.POST 6:\n+\t// after" },
	"INS.HEAD": { body: "INS.HEAD:\n+// top" },
	"INS.TAIL": { body: "INS.TAIL:\n+// bottom" },
	"SWAP.BLK": { body: "SWAP.BLK 5:\n+function beta() {\n+\treturn 22;\n+}" },
	"DEL.BLK": { body: "DEL.BLK 5" },
	"INS.BLK.POST": { body: "INS.BLK.POST 5:\n+\n+function delta() {\n+\treturn 4;\n+}" },
	MV: { body: "SWAP 6.=6:\n+\treturn 20;\nMV moved.ts", dest: "moved.ts" },
};
/** `REM` deletes the file, and every tag of it with the file. */
const NOT_SWEPT = ["REM"];

/** Every hunk keyword of the patch language, `INS` spelled with each of its positions. */
function keywords(): string[] {
	const exported = format as unknown as Record<string, unknown>;
	const positions = Object.keys(exported)
		.filter(name => /^HL_INSERT_[A-Z]+$/.test(name) && name !== "HL_INSERT_KEYWORD")
		.map(name => `${format.HL_INSERT_KEYWORD}.${exported[name]}`);
	const others = Object.keys(exported)
		.filter(name => /^HL_\w+_KEYWORD$/.test(name) && name !== "HL_INSERT_KEYWORD")
		.map(name => String(exported[name]));
	return [...positions, ...others].sort();
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: true,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({}),
		enableLsp: false,
	} as ToolSession;
}

function execOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await fs.writeFile(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function tagFromOutput(text: string, name: string): string {
	const match = new RegExp(`\\[${name.replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${name} in:\n${text}`);
	return match[1];
}

/** The lines `text` shows as `N:content` rows, each checked against the file. */
function shownRows(text: string, lines: readonly string[]): number[] {
	const shown: number[] = [];
	for (const row of text.split("\n")) {
		const match = /^(\d+):(.*)$/.exec(row);
		if (!match) continue;
		const line = Number(match[1]);
		expect(lines[line - 1]).toBe(match[2]);
		shown.push(line);
	}
	return shown;
}

/** Post-edit positions of the first read's lines whose text occurs once in both versions. */
function firstReadLines(lines: readonly string[]): number[] {
	const positions: number[] = [];
	for (let line = FIRST_READ.start; line <= FIRST_READ.end; line++) {
		const text = SOURCE[line - 1];
		if (SOURCE.filter(other => other === text).length !== 1) continue;
		const at = lines.indexOf(text);
		if (at !== -1 && lines.lastIndexOf(text) === at) positions.push(at + 1);
	}
	return positions;
}

function swaps(lines: readonly number[], fileLines: readonly string[]): string {
	return [...lines]
		.sort((x, y) => x - y)
		.map(line => `SWAP ${line}.=${line}:\n+${fileLines[line - 1]} // kept`)
		.join("\n");
}

describe("a line shown by an edit stays editable after a later read", () => {
	let tmpDir: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-after-edit-"));
		await fs.writeFile(path.join(tmpDir, "source.ts"), CONTENT);
		session = createSession(tmpDir);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("has a hunk for every keyword of the patch language", () => {
		expect([...Object.keys(HUNKS), ...NOT_SWEPT].sort()).toEqual(keywords());
	});

	for (const [keyword, hunk] of Object.entries(HUNKS)) {
		it(`keeps every line shown so far editable after ${keyword}`, async () => {
			const source = path.join(tmpDir, "source.ts");
			const first = await new ReadTool(session).execute("r1", {
				path: `${source}:${FIRST_READ.start}-${FIRST_READ.end}`,
			});
			const tag = tagFromOutput(resultText(first), "source.ts");

			const edited = resultText(
				await executeHashlineSingle(execOptions(`[source.ts#${tag}]\n${hunk.body}`, session)),
			);
			const name = hunk.dest ?? "source.ts";
			const target = path.join(tmpDir, name);
			const editedTag = tagFromOutput(edited, name);
			const lines = (await fs.readFile(target, "utf8")).split("\n");

			const later = await new ReadTool(session).execute("r2", {
				path: `${target}:${LATER_READ.start}-${LATER_READ.end}`,
			});
			expect(tagFromOutput(resultText(later), name)).toBe(editedTag);

			const shown = new Set([...shownRows(edited, lines), ...firstReadLines(lines)]);
			for (let line = LATER_READ.start; line <= LATER_READ.end; line++) shown.add(line);
			expect(shown.size).toBeGreaterThan(LATER_READ.end - LATER_READ.start + 1);

			// A line nothing showed is still refused under the same tag.
			const unshown = Array.from({ length: 10 }, (_, i) => 15 + i).find(line => !shown.has(line));
			expect(unshown).toBeDefined();
			await expect(
				executeHashlineSingle(execOptions(`[${name}#${editedTag}]\n${swaps([unshown!], lines)}`, session)),
			).rejects.toThrow(/never displayed \(it showed/);

			await executeHashlineSingle(execOptions(`[${name}#${editedTag}]\n${swaps([...shown], lines)}`, session));
			const after = (await fs.readFile(target, "utf8")).split("\n");
			for (const line of shown) expect(after[line - 1]).toBe(`${lines[line - 1]} // kept`);
		});
	}

	it("keeps the read's lines editable, and not a line changed outside the session, after a recovered edit", async () => {
		const source = path.join(tmpDir, "source.ts");
		const first = await new ReadTool(session).execute("r1", {
			path: `${source}:${FIRST_READ.start}-${FIRST_READ.end}`,
		});
		const tag = tagFromOutput(resultText(first), "source.ts");
		await fs.writeFile(source, CONTENT.replace("const v20 = 20;", "const v20 = 200;"));

		const edited = resultText(
			await executeHashlineSingle(execOptions(`[source.ts#${tag}]\n${HUNKS.SWAP.body}`, session)),
		);
		expect(edited).toContain("Recovered");
		const editedTag = tagFromOutput(edited, "source.ts");
		const lines = (await fs.readFile(source, "utf8")).split("\n");
		const later = await new ReadTool(session).execute("r2", {
			path: `${source}:${LATER_READ.start}-${LATER_READ.end}`,
		});
		expect(tagFromOutput(resultText(later), "source.ts")).toBe(editedTag);

		const shown = new Set([...shownRows(edited, lines), ...firstReadLines(lines)]);
		for (let line = LATER_READ.start; line <= LATER_READ.end; line++) shown.add(line);
		const changed = lines.indexOf("const v20 = 200;") + 1;
		expect(shown.has(changed)).toBe(false);
		await expect(
			executeHashlineSingle(execOptions(`[source.ts#${editedTag}]\n${swaps([changed], lines)}`, session)),
		).rejects.toThrow(/never displayed \(it showed/);

		await executeHashlineSingle(execOptions(`[source.ts#${editedTag}]\n${swaps([...shown], lines)}`, session));
		const after = (await fs.readFile(source, "utf8")).split("\n");
		for (const line of shown) expect(after[line - 1]).toBe(`${lines[line - 1]} // kept`);
	});
});
