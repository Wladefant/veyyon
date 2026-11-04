/**
 * WHY: a tag is a hash of a file's content, but the session snapshot store
 * records displayed lines per path. After the model read a file and copied it
 * (a versioned script copied to its next version, a draft worktree of the same
 * tree), a ranged read of the copy minted the same tag with only that range
 * displayed, and an edit of the copy on a line the model had read in the
 * original was rejected as "never displayed".
 *
 * This drives the production read, search and edit tools through that
 * sequence. The store-level class (held and dropped copies, clipped lines,
 * copies with no record, colliding tags) is covered in
 * `plugins/hashline/test/a-line-displayed-in-a-copy-of-a-file-is-displayed-for-the-copy.test.ts`.
 *
 * Not caught: a copy that differs from the original by any byte.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@veyyon/coding-agent/edit";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";

const LINES = Array.from({ length: 40 }, (_, i) => (i === 19 ? "NEEDLE line 20" : `line ${i + 1}`));
const CONTENT = `${LINES.join("\n")}\n`;

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
	const match = new RegExp(`${path.basename(file).replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${file} in:\n${text}`);
	return match[1];
}

describe("a line read in the original of a copied file stays editable in the copy", () => {
	let tmpDir: string;
	let original: string;
	let copy: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-copy-"));
		await fs.mkdir(path.join(tmpDir, "v1"));
		await fs.mkdir(path.join(tmpDir, "v2"));
		original = path.join(tmpDir, "v1", "probe.py");
		copy = path.join(tmpDir, "v2", "probe.py");
		await fs.writeFile(original, CONTENT);
		session = createSession(tmpDir);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	/** Copy the original, then read a range of the copy that excludes the lines edited below. */
	async function copyAndReadTail(tag: string): Promise<void> {
		await fs.copyFile(original, copy);
		const read = await new ReadTool(session).execute("r2", { path: `${copy}:34-36` });
		expect(tagFromOutput(resultText(read), copy)).toBe(tag);
	}

	it("applies an edit of the copy on a line a read of the original displayed", async () => {
		const read = await new ReadTool(session).execute("r1", { path: `${original}:1-3` });
		const tag = tagFromOutput(resultText(read), original);
		await copyAndReadTail(tag);

		await executeHashlineSingle(execOptions(`[v2/probe.py#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT.replace("line 2\n", "EDITED\n"));
		expect(await fs.readFile(original, "utf8")).toBe(CONTENT);
	});

	it("applies an edit of the copy on a line a search of the original displayed", async () => {
		const hit = await new SearchTool(session).execute("s1", { type: "text", input: "NEEDLE", path: original });
		const tag = tagFromOutput(resultText(hit), original);
		await copyAndReadTail(tag);

		await executeHashlineSingle(execOptions(`[v2/probe.py#${tag}]\nSWAP 20.=20:\n+EDITED`, session));
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT.replace("NEEDLE line 20\n", "EDITED\n"));
	});

	it("still rejects an edit of the copy on a line neither file displayed", async () => {
		const read = await new ReadTool(session).execute("r1", { path: `${original}:1-3` });
		const tag = tagFromOutput(resultText(read), original);
		await copyAndReadTail(tag);

		await expect(
			executeHashlineSingle(execOptions(`[v2/probe.py#${tag}]\nSWAP 12.=12:\n+EDITED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT);
	});
});
