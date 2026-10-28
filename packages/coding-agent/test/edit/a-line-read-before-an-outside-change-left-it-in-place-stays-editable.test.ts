/**
 * WHY: the session snapshot store records displayed lines per version of a
 * file. After the model read part of a file, a formatter or a shell command
 * changed it, and a ranged read of the changed file minted a new tag with only
 * that range displayed. An edit under the new tag on a line the model had read
 * before the change, which the change left at the same line, was rejected as
 * "never displayed".
 *
 * This drives the production read, search and edit tools through that
 * sequence. The store-level class (head, middle and tail of the change,
 * rewritten and moved lines, clipped lines, versions with no record, other
 * paths) is covered in
 * `plugins/hashline/test/a-line-a-change-left-in-place-stays-displayed-under-the-new-tag.test.ts`.
 *
 * Not caught: a version the snapshot store no longer holds.
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

const LINES = Array.from({ length: 40 }, (_, i) => (i === 19 ? "NEEDLE line 20" : `line ${i + 1}`));
const CONTENT = `${LINES.join("\n")}\n`;
/** `CONTENT` with line 30 rewritten: lines 1-29 stay in place. */
const FORMATTED = CONTENT.replace("line 30\n", "line 30 formatted\n");
/** `CONTENT` with a line inserted at the top: every line moves down by one. */
const SHIFTED = `header\n${CONTENT}`;

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

function tagFromOutput(text: string, file: string): string {
	const match = new RegExp(`${path.basename(file).replace(".", "\\.")}#([0-9A-F]{4})\\]`).exec(text);
	if (!match) throw new Error(`no hashline header for ${file} in:\n${text}`);
	return match[1];
}

describe("a line read before an outside change left it in place stays editable", () => {
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
		session = createSession(tmpDir);
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

	it("applies an edit under the new tag on a line a read displayed before the change", async () => {
		await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = await changeAndReadTail(FORMATTED);

		await executeHashlineSingle(hashlineExecOptions(`[probe.py#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await fs.readFile(file, "utf8")).toBe(FORMATTED.replace("line 2\n", "EDITED\n"));
	});

	it("applies an edit under the new tag on a line a search displayed before the change", async () => {
		await new SearchTool(session).execute("s1", { type: "text", input: "NEEDLE", path: file });
		const tag = await changeAndReadTail(FORMATTED);

		await executeHashlineSingle(hashlineExecOptions(`[probe.py#${tag}]\nSWAP 20.=20:\n+EDITED`, session));
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
