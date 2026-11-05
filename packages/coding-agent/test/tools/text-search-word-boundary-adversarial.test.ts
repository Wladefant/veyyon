import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Bodies of the match rows only. A search result also carries context rows,
 * whose count follows `search.contextBefore` / `search.contextAfter`, so an
 * assertion over the whole text measures the context window rather than the
 * pattern.
 */
function matchRows(text: string): string[] {
	return text
		.split("\n")
		.filter(line => line.startsWith("*"))
		.map(line => line.replace(/^\*\d+:/, ""));
}

describe("SearchTool (text) word-boundary style adversarial", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-wb-"));
		await Bun.write(path.join(tmpDir, "w.ts"), "foo\nfoobar\nbarfoo\nfood\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			settings: Settings.isolated(),
		});
	}

	it("pattern foo matches every line that contains it as a substring", async () => {
		const tool = new SearchTool(session());
		const text = toolResultText(
			await tool.execute("g1", { type: "text", input: "foo", path: path.join(tmpDir, "w.ts") }),
		);
		expect(matchRows(text)).toEqual(["foo", "foobar", "barfoo", "food"]);
	});

	it("anchored ^foo$ matches the exact line and nothing else", async () => {
		const tool = new SearchTool(session());
		const text = toolResultText(
			await tool.execute("g2", { type: "text", input: "^foo$", path: path.join(tmpDir, "w.ts") }),
		);
		expect(matchRows(text)).toEqual(["foo"]);
	});
});
