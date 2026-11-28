/**
 * The edit tool requires a displayed coordinate under the current tag. An
 * earlier read or search cannot bind an anchor to a new tag, even if the line
 * stayed in place. A targeted read of the current version can bind the anchor.
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
/** `CONTENT` with line 30 rewritten: lines 1-29 stay in place. */
const FORMATTED = CONTENT.replace("line 30\n", "line 30 formatted\n");
/** `CONTENT` with a line inserted at the top: every line moves down by one. */
const SHIFTED = `header\n${CONTENT}`;

function tagFromOutput(text: string, file: string): string {
	const match = new RegExp(`${path.basename(file).replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${file} in:\n${text}`);
	return match[1];
}

describe("displayed coordinates after an outside change", () => {
	let tmpDir: string;
	let file: string;
	let session: ToolSession;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-change-"));
		file = path.join(tmpDir, "probe.py");
		await fs.writeFile(file, CONTENT);
		session = makeWorkspaceToolSession(tmpDir);
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	/** Change the file outside the session, then read a range that excludes the lines edited below. */
	async function changeAndReadTail(changed: string): Promise<string> {
		await fs.writeFile(file, changed);
		const read = await new ReadTool(session).execute("r2", { path: `${file}:34-36` });
		return tagFromOutput(toolResultText(read), file);
	}

	it("requires a current read of an unchanged line shown by an earlier read", async () => {
		await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = await changeAndReadTail(FORMATTED);

		const patch = hashlineExecOptions(`[probe.py#${tag}]\nSWAP 2.=2:\n+EDITED`, session);
		await expect(executeHashlineSingle(patch)).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(file, "utf8")).toBe(FORMATTED);
		const read = await new ReadTool(session).execute("r3", { path: `${file}:2-2` });
		expect(tagFromOutput(toolResultText(read), file)).toBe(tag);
		await executeHashlineSingle(patch);
		expect(await fs.readFile(file, "utf8")).toBe(FORMATTED.replace("line 2\n", "EDITED\n"));
	});

	it("requires a current read of an unchanged line shown by an earlier search", async () => {
		await new SearchTool(session).execute("s1", { type: "text", input: "NEEDLE", path: file });
		const tag = await changeAndReadTail(FORMATTED);

		const patch = hashlineExecOptions(`[probe.py#${tag}]\nSWAP 20.=20:\n+EDITED`, session);
		await expect(executeHashlineSingle(patch)).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(file, "utf8")).toBe(FORMATTED);
		const read = await new ReadTool(session).execute("r3", { path: `${file}:20-20` });
		expect(tagFromOutput(toolResultText(read), file)).toBe(tag);
		await executeHashlineSingle(patch);
		expect(await fs.readFile(file, "utf8")).toBe(FORMATTED.replace("NEEDLE line 20\n", "EDITED\n"));
	});

	it("still rejects an edit on a line the change moved", async () => {
		await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = await changeAndReadTail(SHIFTED);

		await expect(
			executeHashlineSingle(hashlineExecOptions(`[probe.py#${tag}]\nSWAP 2.=2:\n+EDITED`, session)),
		).rejects.toThrow(/never displayed \(it showed/);
		expect(await fs.readFile(file, "utf8")).toBe(SHIFTED);
	});
});
