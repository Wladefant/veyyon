/**
 * WHY: the session snapshot store holds a bounded set of paths. Reading or
 * searching enough other files evicted a file's snapshot together with the
 * lines its earlier read displayed. A later ranged read or search hit on the
 * unchanged file then minted the same tag with only the newest lines seen, and
 * an edit on a line the first read displayed was rejected as "never displayed"
 * while the read dedup refused to show that read again.
 *
 * This drives the production read, search and edit tools through that
 * sequence. The store-level class (path count, text budget, version ring,
 * relocate, invalidate) is covered in
 * `plugins/hashline/test/a-line-displayed-before-its-version-was-dropped-stays-displayed.test.ts`.
 *
 * Not caught: a read that never records seen lines at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@veyyon/coding-agent/edit";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";

const LINES = Array.from({ length: 40 }, (_, i) => (i === 29 ? "NEEDLE line 30" : `line ${i + 1}`));
const CONTENT = `${LINES.join("\n")}\n`;
/** More distinct paths than the session store holds (30), in two directories of one search page (20) each. */
const OTHER_FILES = 40;

function otherFile(i: number): string {
	return path.join("other", i < OTHER_FILES / 2 ? "a" : "b", `f${i}.txt`);
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
		settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
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

function tagFromOutput(text: string, file: string): string {
	const match = new RegExp(`\\[${path.basename(file).replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${file} in:\n${text}`);
	return match[1];
}

describe("a line read before its snapshot was evicted stays editable", () => {
	let tmpDir: string;
	let file: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-eviction-"));
		file = path.join(tmpDir, "notes.txt");
		await fs.writeFile(file, CONTENT);
		for (const dir of ["a", "b"]) await fs.mkdir(path.join(tmpDir, "other", dir), { recursive: true });
		for (let i = 0; i < OTHER_FILES; i++) {
			await fs.writeFile(path.join(tmpDir, otherFile(i)), `FILLER ${i}\nsecond line\n`);
		}
		session = createSession(tmpDir);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function readFirstLines(): Promise<string> {
		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		return tagFromOutput(resultText(read), file);
	}

	function expectEvicted(): void {
		expect(getFileSnapshotStore(session).head(canonicalSnapshotKey(file))).toBeNull();
	}

	it("applies an edit after other reads evicted it and a ranged read re-recorded it", async () => {
		const tag = await readFirstLines();
		for (let i = 0; i < OTHER_FILES; i++) {
			await new ReadTool(session).execute(`o${i}`, { path: path.join(tmpDir, otherFile(i)) });
		}
		expectEvicted();
		const reread = await new ReadTool(session).execute("r2", { path: `${file}:34-36` });
		expect(tagFromOutput(resultText(reread), file)).toBe(tag);

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await fs.readFile(file, "utf8")).toBe(CONTENT.replace("line 2\n", "EDITED\n"));
	});

	it("applies an edit after a search evicted it and a search hit re-recorded it", async () => {
		const tag = await readFirstLines();
		for (const dir of ["a", "b"]) {
			await new SearchTool(session).execute(`s-${dir}`, {
				type: "text",
				input: "FILLER",
				path: path.join(tmpDir, "other", dir),
			});
		}
		expectEvicted();
		const hit = await new SearchTool(session).execute("s2", { type: "text", input: "NEEDLE", path: file });
		expect(tagFromOutput(resultText(hit), file)).toBe(tag);

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await fs.readFile(file, "utf8")).toBe(CONTENT.replace("line 2\n", "EDITED\n"));
	});

	it("still rejects an edit on a line neither read displayed", async () => {
		const tag = await readFirstLines();
		for (let i = 0; i < OTHER_FILES; i++) {
			await new ReadTool(session).execute(`o${i}`, { path: path.join(tmpDir, otherFile(i)) });
		}
		expectEvicted();
		await new ReadTool(session).execute("r2", { path: `${file}:34-36` });

		await expect(
			executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 18.=18:\n+EDITED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(file, "utf8")).toBe(CONTENT);
	});
});
