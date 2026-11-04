// WHY: a file search over a tree too large to walk in its 5 s budget returned
// nothing. The tool aborted the native walk at the deadline and the walk
// discarded every match it had found, so a search that had already listed the
// file it was asked for answered "timed out before finding any matches".
//
// The class this closes: a deadline that drops matches a walk found, a
// deadline the tool keeps to itself instead of handing to the walk, a partial
// result reported as complete, and an empty partial result reported as proof
// of absence. Every target of a delimited input is merged the same way whether
// or not one of them reached the deadline.
//
// The native walk is replaced here, because no test tree is large enough to
// outlast the budget; the walk's own stop at the deadline is proved in
// `natives/search/walker/tests/a_walk_past_its_deadline_returns_what_it_found.rs`.
//
// What it does not catch: the backstop that ends a walk blocked inside a
// directory read, which needs a filesystem that stops answering.
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import * as natives from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";

/** What the replaced walk returns for one target directory, by its base name. */
type Walks = Record<string, { names: string[]; timedOut: boolean }>;

async function search(walks: Walks): Promise<{ text: string; files: string[]; truncated: boolean; budgets: number[] }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-file-search-deadline-"));
	try {
		for (const name of Object.keys(walks)) await fs.mkdir(path.join(dir, name));
		const budgets: number[] = [];
		vi.spyOn(natives, "glob").mockImplementation(async options => {
			budgets.push(options.timeoutMs ?? Number.NaN);
			const walk = walks[path.basename(options.path)];
			if (!walk) throw new Error(`unexpected walk of ${options.path}`);
			const matches = walk.names.map((name, index) => ({
				path: name,
				fileType: natives.FileType.File,
				mtime: 1_000 - index,
			}));
			return { matches, totalMatches: matches.length, timedOut: walk.timedOut };
		});
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const result = await new SearchTool(session).execute("deadline", {
			type: "files",
			input: Object.keys(walks).join(";"),
		});
		if (result.details?.type !== "files") throw new Error("not a file search result");
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		const { files = [], truncated = false } = result.details.result;
		return { text, files: [...files].sort(), truncated, budgets };
	} finally {
		await removeWithRetries(dir);
	}
}

describe("a file search past its deadline returns what it found", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hands the walk the time left and merges the partial target with the finished one", async () => {
		const result = await search({
			slow: { names: ["found.ts", "also.ts"], timedOut: true },
			fast: { names: ["done.ts"], timedOut: false },
		});
		expect(result.files).toEqual(["fast/done.ts", "slow/also.ts", "slow/found.ts"]);
		expect(result.text).toContain("File search timed out after 5s; returning 3 partial matches");
		expect(result.truncated).toBe(true);
		expect(result.budgets).toHaveLength(2);
		for (const budget of result.budgets) {
			expect(budget).toBeGreaterThan(0);
			expect(budget).toBeLessThanOrEqual(5_000);
		}
	});

	it("reports a search no target timed out as complete", async () => {
		const result = await search({
			one: { names: ["a.ts"], timedOut: false },
			two: { names: ["b.ts"], timedOut: false },
		});
		expect(result.files).toEqual(["one/a.ts", "two/b.ts"]);
		expect(result.text).not.toContain("timed out");
		expect(result.truncated).toBe(false);
	});

	it("never calls an empty partial result proof of absence", async () => {
		const result = await search({
			slow: { names: [], timedOut: true },
			empty: { names: [], timedOut: false },
		});
		expect(result.files).toEqual([]);
		expect(result.text).toContain("File search timed out after 5s before finding any matches");
		expect(result.text).not.toContain("No files found matching pattern");
	});
});
