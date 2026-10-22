// WHY: a files search for `source-cache/forminator*/` answered "No files found
// matching pattern" over a directory holding 35 `forminator*` directories. A
// trailing `/` names directories, as it does in a shell, but the glob reached
// the walker with the slash in it, no walked path ends in a separator, and the
// search stated an absence that was false.
//
// The class this closes: every way a pattern ending in `/` reaches the walk.
// A leading glob (made recursive), a directory-prefixed glob (kept at its
// depth), a brace set, a scope given in `path`, one entry of a multi-entry
// input beside an entry without the slash, and a doubled slash each list the
// directories the glob matches and no file whose name it also matches. The
// same globs without the slash are the negative control: they list both.
//
// What it does not catch: a custom `FileSearchOperations` backend, which
// receives the pattern as written, and a symlink to a directory, which the
// native filter resolves and its own suite owns.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SearchTool, type SearchToolInput } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";

/**
 * plugin-a/, plugin-b/ and plugin-b/inner/plugin-c/ are directories beside the
 * files plugin-a.zip and plugin-b.zip; deep/ holds the directory plugin-d/ and
 * the file plugin-e.zip.
 */
async function withWorkspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-search-dirs-"));
	try {
		for (const sub of ["plugin-a", "plugin-b/inner/plugin-c", "deep/plugin-d", "other"]) {
			await fs.mkdir(path.join(dir, sub), { recursive: true });
		}
		for (const file of ["plugin-a.zip", "plugin-b.zip", "plugin-a/main.php", "deep/plugin-e.zip", "other/x.txt"]) {
			await fs.writeFile(path.join(dir, file), "x\n");
		}
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

async function listed(cwd: string, args: Omit<SearchToolInput, "type">): Promise<{ files: string[]; text: string }> {
	const tool = new SearchTool({
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	});
	const result = await tool.execute(`dirs-${args.input}`, { type: "files", ...args });
	if (result.details?.type !== "files") throw new Error("not a file search result");
	const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	return { files: [...(result.details.result.files ?? [])].sort(), text };
}

const CASES: Array<{ shape: string; args: Omit<SearchToolInput, "type">; dirs: string[]; withoutSlash: string[] }> = [
	{
		shape: "a leading glob, recursive",
		args: { input: "plugin-*/" },
		dirs: ["deep/plugin-d/", "plugin-a/", "plugin-b/", "plugin-b/inner/plugin-c/"],
		withoutSlash: [
			"deep/plugin-d/",
			"deep/plugin-e.zip",
			"plugin-a.zip",
			"plugin-a/",
			"plugin-b.zip",
			"plugin-b/",
			"plugin-b/inner/plugin-c/",
		],
	},
	{
		shape: "a directory-prefixed glob at its depth",
		args: { input: "deep/plugin-*/" },
		dirs: ["deep/plugin-d/"],
		withoutSlash: ["deep/plugin-d/", "deep/plugin-e.zip"],
	},
	{
		shape: "a brace set",
		args: { input: "{plugin-a*,plugin-b*}/" },
		dirs: ["plugin-a/", "plugin-b/"],
		withoutSlash: ["plugin-a.zip", "plugin-a/", "plugin-b.zip", "plugin-b/"],
	},
	{
		shape: "a glob scoped by path",
		args: { input: "plugin-*/", path: "deep" },
		dirs: ["deep/plugin-d/"],
		withoutSlash: ["deep/plugin-d/", "deep/plugin-e.zip"],
	},
	{
		shape: "one entry of a multi-entry input",
		args: { input: "deep/plugin-*/; plugin-a*" },
		dirs: ["deep/plugin-d/", "plugin-a.zip", "plugin-a/"],
		withoutSlash: ["deep/plugin-d/", "deep/plugin-e.zip", "plugin-a.zip", "plugin-a/"],
	},
	{
		shape: "a doubled slash",
		args: { input: "deep/plugin-*//" },
		dirs: ["deep/plugin-d/"],
		withoutSlash: ["deep/plugin-d/", "deep/plugin-e.zip"],
	},
];

describe("a files glob ending in a slash lists the directories it matches", () => {
	it.each(CASES)("lists only directories for $shape", async ({ args, dirs, withoutSlash }) => {
		await withWorkspace(async dir => {
			expect((await listed(dir, args)).files).toEqual(dirs);
			const bare = args.input.replace(/\/+(?=\s*(;|$))/g, "");
			expect(bare).not.toEqual(args.input);
			expect((await listed(dir, { ...args, input: bare })).files).toEqual(withoutSlash);
		});
	});

	it("still states no match when no directory matches", async () => {
		await withWorkspace(async dir => {
			const { files, text } = await listed(dir, { input: "deep/plugin-e*/" });
			expect(files).toEqual([]);
			expect(text).toContain("No files found matching pattern");
		});
	});
});
