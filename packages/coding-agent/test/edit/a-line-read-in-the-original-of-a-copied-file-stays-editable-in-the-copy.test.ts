/**
 * A byte-identical copy has the same content tag, but the edit tool requires
 * coordinates displayed for the destination path. An earlier read or search
 * of the source does not bind an anchor to the copy.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeHashlineSingle } from "@veyyon/coding-agent/edit";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";
import { hashlineExecOptions } from "../helpers/hashline-exec";
import { toolResultText } from "../helpers/tool-result-text";
import { makeWorkspaceToolSession } from "../helpers/tool-session";

const LINES = Array.from({ length: 40 }, (_, i) => (i === 19 ? "NEEDLE line 20" : `line ${i + 1}`));
const CONTENT = `${LINES.join("\n")}\n`;

function tagFromOutput(text: string, file: string): string {
	const match = new RegExp(`${path.basename(file).replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${file} in:\n${text}`);
	return match[1];
}

describe("displayed coordinates after copying a file", () => {
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
		session = makeWorkspaceToolSession(tmpDir);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	/** Copy the original, then read a range of the copy that excludes the lines edited below. */
	async function copyAndReadTail(tag: string): Promise<void> {
		await fs.copyFile(original, copy);
		const read = await new ReadTool(session).execute("r2", { path: `${copy}:34-36` });
		expect(tagFromOutput(toolResultText(read), copy)).toBe(tag);
	}

	it("requires a read of the copy when an earlier read showed only the original", async () => {
		const read = await new ReadTool(session).execute("r1", { path: `${original}:1-3` });
		const tag = tagFromOutput(toolResultText(read), original);
		await copyAndReadTail(tag);

		const patch = hashlineExecOptions(`[v2/probe.py#${tag}]\nSWAP 2.=2:\n+EDITED`, session);
		await expect(executeHashlineSingle(patch)).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT);
		const reread = await new ReadTool(session).execute("r3", { path: `${copy}:2-2` });
		expect(tagFromOutput(toolResultText(reread), copy)).toBe(tag);
		await executeHashlineSingle(patch);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT.replace("line 2\n", "EDITED\n"));
		expect(await fs.readFile(original, "utf8")).toBe(CONTENT);
	});

	it("requires a read of the copy when an earlier search showed only the original", async () => {
		const hit = await new SearchTool(session).execute("s1", { type: "text", input: "NEEDLE", path: original });
		const tag = tagFromOutput(toolResultText(hit), original);
		await copyAndReadTail(tag);

		const patch = hashlineExecOptions(`[v2/probe.py#${tag}]\nSWAP 20.=20:\n+EDITED`, session);
		await expect(executeHashlineSingle(patch)).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT);
		const reread = await new ReadTool(session).execute("r3", { path: `${copy}:20-20` });
		expect(tagFromOutput(toolResultText(reread), copy)).toBe(tag);
		await executeHashlineSingle(patch);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT.replace("NEEDLE line 20\n", "EDITED\n"));
	});

	it("still rejects an edit of the copy on a line neither file displayed", async () => {
		const read = await new ReadTool(session).execute("r1", { path: `${original}:1-3` });
		const tag = tagFromOutput(toolResultText(read), original);
		await copyAndReadTail(tag);

		await expect(
			executeHashlineSingle(hashlineExecOptions(`[v2/probe.py#${tag}]\nSWAP 12.=12:\n+EDITED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(copy, "utf8")).toBe(CONTENT);
	});
});
