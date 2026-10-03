import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { formatOutputNotice, stripGeneratedOutputNotice } from "@veyyon/coding-agent/tools/core/output-notice";
import { executeFileSearch, type FileSearchDetails } from "@veyyon/coding-agent/tools/search/file-search";

/**
 * WHY: file search caps `limit` at 200. A request for more was silently reduced, and the results-limit
 * notice then advised `Use limit=<reached * 2>`, a value the tool clamps straight back to 200, so the
 * documented retry could never reach the tail (oh-my-pi #13263, 230-file repro).
 *
 * Contracts pinned, through the real tool on a real 230-file directory:
 * - a clamped request says it was clamped;
 * - at the cap the notice reports the count and names no `limit=` value;
 * - below the cap the doubled suggestion never exceeds the cap;
 * - the bare notice is still recognised as a generated notice, so resume strips it.
 *
 * Not caught: a different tool that also clamps (grep, read) and doubles past its own cap.
 */

let dir: string;

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function noticeOf(result: AgentToolResult<FileSearchDetails>): string {
	return formatOutputNotice(result.details?.meta);
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-limit-cap-"));
	await Promise.all(
		Array.from({ length: 230 }, (_, i) => fs.writeFile(path.join(dir, `file-${String(i).padStart(3, "0")}.txt`), "")),
	);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("file search above its 200 hard cap", () => {
	it("discloses a clamped request and advises no value that clamps back", async () => {
		const result = await executeFileSearch(session(dir), { path: ".", limit: 1000, gitignore: false });

		expect(result.details?.fileCount).toBe(200);
		expect(JSON.stringify(result.content)).toContain("Requested limit 1000 clamped to the max of 200");
		expect(noticeOf(result)).toBe("\n\n[200 results limit reached]");
	});

	it("keeps the reached notice without advice when the default limit sits on the cap", async () => {
		const result = await executeFileSearch(session(dir), { path: ".", gitignore: false });

		expect(JSON.stringify(result.content)).not.toContain("clamped");
		expect(noticeOf(result)).toBe("\n\n[200 results limit reached]");
	});

	it("caps the doubled suggestion at the hard limit below the cap", async () => {
		const at50 = await executeFileSearch(session(dir), { path: ".", limit: 50, gitignore: false });
		const at150 = await executeFileSearch(session(dir), { path: ".", limit: 150, gitignore: false });

		expect(noticeOf(at50)).toBe("\n\n[50 results limit reached. Use limit=100 for more]");
		expect(noticeOf(at150)).toBe("\n\n[150 results limit reached. Use limit=200 for more]");
	});

	it("strips the bare notice from a resumed body like the advising one", () => {
		expect(stripGeneratedOutputNotice("a.txt\n\n[200 results limit reached]")).toBe("a.txt");
		expect(
			stripGeneratedOutputNotice("a.txt\n\n[200 results limit reached. Some lines truncated to 400 chars]"),
		).toBe("a.txt");
	});
});
