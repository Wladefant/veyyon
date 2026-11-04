// WHY: a text search over a tree too large to finish in its 30 s limit
// returned nothing. Native grep failed the whole search with
// "Aborted: Timeout" when the limit passed, discarding the matches of every
// file it had searched, so the tool answered "timed out" with no results.
//
// The class this closes: a time limit that drops matches a search found, a
// limit each target of a delimited `path` gets in full instead of sharing, a
// partial result reported as complete (in the match listing and in the
// `paths` listing), and an empty partial result reported as "No matches
// found".
//
// Native grep is wrapped here: each call runs the real search and the wrapper
// marks the result as stopped by the limit, because no test tree is large
// enough to outlast 30 s. Native grep's own stop at the limit, on every path
// it takes, is proved in `natives/bridge/addon/src/grep.rs`
// (`a_search_past_its_timeout_returns_what_it_found`).
//
// What it does not catch: a read that stalls inside one file, which no
// heartbeat interrupts.
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import * as natives from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";

const realGrep = natives.grep;
/** How long each wrapped native grep call takes before it runs, so the targets' limits visibly shrink. */
const CALL_MS = 25;

/** Files to create, by path relative to the search root. */
type Tree = Record<string, string>;

interface Searched {
	text: string;
	truncated: boolean;
	timeoutNotice: string | undefined;
	/** The `timeoutMs` each native grep call received, in call order. */
	budgets: number[];
}

/**
 * Run a text search for `input` over `tree`, with native grep reporting that
 * the limit stopped every call whose path ends in one of `stoppedTargets`.
 */
async function search(
	tree: Tree,
	params: { input: string; path?: string; paths?: boolean },
	stoppedTargets: readonly string[],
): Promise<Searched> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-text-search-limit-"));
	try {
		for (const [relative, content] of Object.entries(tree)) {
			await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
			await fs.writeFile(path.join(dir, relative), content);
		}
		const budgets: number[] = [];
		vi.spyOn(natives, "grep").mockImplementation(async (options, onMatch) => {
			budgets.push(options.timeoutMs ?? Number.NaN);
			await sleep(CALL_MS);
			const result = await realGrep(options, onMatch);
			const stopped = stoppedTargets.some(target => path.basename(options.path) === target);
			return stopped ? { ...result, timedOut: true } : result;
		});
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const result = await new SearchTool(session).execute("limit", { type: "text", ...params });
		if (result.details?.type !== "text") throw new Error("not a text search result");
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		const { truncated = false, timeoutNotice } = result.details.result;
		return { text, truncated, timeoutNotice, budgets };
	} finally {
		await removeWithRetries(dir);
	}
}

const TREE: Tree = {
	"slow/found.ts": "const needle = 1;\n",
	"fast/done.ts": "const needle = 2;\n",
};

describe("a text search past its time limit returns what it found", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the matches found by the limit and says the result is incomplete", async () => {
		const result = await search(TREE, { input: "needle", path: "slow" }, ["slow"]);
		expect(result.text).toContain("const needle = 1;");
		expect(result.text).toContain("Text search timed out after 30s with 1 file searched; results are incomplete");
		expect(result.timeoutNotice).toStartWith("Text search timed out after 30s");
		expect(result.truncated).toBe(true);
		expect(result.budgets).toEqual([30_000]);
	});

	it("shares one limit across the targets of a delimited path and merges the partial target", async () => {
		const result = await search(TREE, { input: "needle", path: "slow;fast" }, ["slow"]);
		expect(result.text).toContain("const needle = 1;");
		expect(result.text).toContain("const needle = 2;");
		expect(result.text).toContain("Text search timed out after 30s with 2 files searched");
		expect(result.truncated).toBe(true);
		expect(result.budgets).toHaveLength(2);
		const [first, second] = result.budgets as [number, number];
		expect(first).toBeLessThanOrEqual(30_000);
		expect(first).toBeGreaterThan(0);
		// The second target gets what the first left, not a fresh limit.
		expect(second).toBeLessThanOrEqual(first - (CALL_MS - 5));
		expect(second).toBeGreaterThan(0);
	});

	it("prints the notice in the paths listing too", async () => {
		const result = await search(TREE, { input: "needle", path: "slow", paths: true }, ["slow"]);
		expect(result.text).toContain("found.ts: 1");
		expect(result.text).toContain("Text search timed out after 30s with 1 file searched; results are incomplete");
	});

	it("never calls an empty partial result proof of absence", async () => {
		const result = await search(TREE, { input: "absent-token", path: "slow" }, ["slow"]);
		expect(result.text).toContain("Text search timed out after 30s before finding any matches");
		expect(result.text).not.toContain("No matches found");
		expect(result.truncated).toBe(true);
	});

	it("reports a search that beat its limit as complete", async () => {
		const found = await search(TREE, { input: "needle", path: "slow;fast" }, []);
		expect(found.text).toContain("const needle = 1;");
		expect(found.text).toContain("const needle = 2;");
		expect(found.text).not.toContain("timed out");
		expect(found.timeoutNotice).toBeUndefined();
		expect(found.truncated).toBe(false);

		const absent = await search(TREE, { input: "absent-token", path: "slow" }, []);
		expect(absent.text).toContain("No matches found");
		expect(absent.text).not.toContain("timed out");
	});
});
