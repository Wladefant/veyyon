// WHY: a files search whose input held several globs under one root walked
// that root once per glob, in walks that ran in parallel. On a large tree the
// walks contended for the same directories inside one 5 s budget, so
// `*alpha*;*beta*` timed out where `*alpha*` alone finished in half of it.
//
// The class this closes: the number of walks a multi-entry input costs. Entries
// that share a root and a file-type filter read the root once, through one
// `{a,b}` alternation, and list exactly what the entries list when searched one
// at a time: leading globs, directory-prefixed globs, a bounded glob beside a
// recursive one, a nested brace set, a scope given in `path`, directory globs,
// and a limit below the size of the union. Entries that cannot join an
// alternation without changing meaning, a literal comma, a bracket class and a
// `}` before its `{`, keep their own walk: they list the same files, and a glob
// the walker rejects is named in the error as it is when searched alone.
//
// What it does not catch: the time a walk takes, which depends on the tree and
// the disk. The bound asserted here is the walk count. An unclosed `{` reaches
// the walk only in the last entry, where joining it changes nothing, so the
// check that keeps it out of an alternation has no reachable failure here. A
// custom `FileSearchOperations` backend receives each entry as written and is
// not covered.
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SearchTool, type SearchToolInput } from "@veyyon/coding-agent/tools/search/search";
import * as natives from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";

const realGlob = natives.glob;

const FILES = [
	"src/a.ts",
	"src/b.md",
	"src/nested/c.ts",
	"src/nested/d.md",
	"docs/RUNLOG.md",
	"docs/guide.md",
	"plugin-b/inner.ts",
	"notes/k,v.txt",
	"braces/{x,y}.txt",
	"deep/x/y/z.ts",
];
const DIRS = ["plugin-a"];

/** Every entry gets its own mtime, so a ranking by mtime has no ties. */
async function withWorkspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-search-one-walk-"));
	try {
		for (const file of FILES) {
			await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
			await fs.writeFile(path.join(dir, file), file);
		}
		for (const sub of DIRS) await fs.mkdir(path.join(dir, sub), { recursive: true });
		const entries = [...FILES, ...new Set(FILES.map(file => path.dirname(file))), ...DIRS];
		let second = 1_700_000_000;
		for (const entry of entries) {
			second += 60;
			await fs.utimes(path.join(dir, entry), second, second);
		}
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

async function listed(cwd: string, args: Omit<SearchToolInput, "type">): Promise<string[]> {
	const tool = new SearchTool({
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	});
	const result = await tool.execute(`one-walk-${args.input}`, { type: "files", ...args });
	if (result.details?.type !== "files") throw new Error("not a file search result");
	return [...(result.details.result.files ?? [])];
}

/** The roots the native walks of one search read, relative to `cwd`, sorted. */
async function walkedRoots(cwd: string, args: Omit<SearchToolInput, "type">): Promise<string[]> {
	const roots: string[] = [];
	vi.spyOn(natives, "glob").mockImplementation((options, onMatch) => {
		roots.push(path.relative(cwd, options.path) || ".");
		return realGlob(options, onMatch);
	});
	try {
		await listed(cwd, args);
	} finally {
		vi.restoreAllMocks();
	}
	return roots.sort();
}

/**
 * What the entries list searched one at a time: their union, ranked as one
 * search ranks it. Every entry has to list something alone, or the comparison
 * cannot tell a dropped entry from an empty one. An entry is searched as
 * `entry;`, which splits on the semicolon only, as the multi-entry input does;
 * a bare `*k,v*` would split again on its comma.
 */
async function listedOneAtATime(cwd: string, args: Omit<SearchToolInput, "type">): Promise<string[]> {
	const union = new Set<string>();
	const listedNothing: string[] = [];
	for (const entry of args.input.split(";")) {
		const files = await listed(cwd, { ...args, input: `${entry};`, limit: undefined });
		if (files.length === 0) listedNothing.push(entry);
		for (const file of files) union.add(file);
	}
	expect(listedNothing).toEqual([]);
	const ranked = await Promise.all(
		[...union].map(async file => ({ file, mtime: (await fs.stat(path.join(cwd, file))).mtimeMs })),
	);
	ranked.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
	return ranked.slice(0, args.limit ?? 200).map(entry => entry.file);
}

const CASES: Array<{ shape: string; args: Omit<SearchToolInput, "type">; roots: string[] }> = [
	{ shape: "leading globs", args: { input: "*.ts;*.md" }, roots: ["."] },
	{ shape: "globs under one directory", args: { input: "src/*.ts;src/*.md" }, roots: ["src"] },
	{ shape: "a bounded glob beside a recursive one", args: { input: "src/*.ts;src/**/*.md" }, roots: ["src"] },
	{ shape: "a nested brace set", args: { input: "*.{ts,md};**/RUNLOG.md" }, roots: ["."] },
	{ shape: "globs scoped by path", args: { input: "*.ts;*.md", path: "src" }, roots: ["src"] },
	{ shape: "two directory globs", args: { input: "plugin-*/;nest*/" }, roots: ["."] },
	{ shape: "a limit below the union", args: { input: "*.ts;*.md", limit: 3 }, roots: ["."] },
	{ shape: "globs under two directories", args: { input: "src/*.ts;docs/*.md" }, roots: ["docs", "src"] },
	{ shape: "a directory glob beside a file glob", args: { input: "plugin-*/;*.ts" }, roots: [".", "."] },
	{ shape: "a literal comma", args: { input: "*k,v*;*.md" }, roots: [".", "."] },
	{ shape: "a bracket class holding a brace and a comma", args: { input: "*[{]x,y[}]*;*.md" }, roots: [".", "."] },
];

describe("a multi-entry files search reads each root once", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const { shape, args, roots } of CASES) {
		it(`walks ${roots.length === 1 ? "one root once" : "each root it needs"} for ${shape}`, async () => {
			await withWorkspace(async dir => {
				expect(await walkedRoots(dir, args)).toEqual(roots);
			});
		});

		it(`lists what the entries list one at a time for ${shape}`, async () => {
			await withWorkspace(async dir => {
				expect(await listed(dir, args)).toEqual(await listedOneAtATime(dir, args));
			});
		});
	}

	it("names the glob a walk rejects, as a search of that entry alone does", async () => {
		await withWorkspace(async dir => {
			const failure = (input: string) =>
				listed(dir, { input }).then(
					() => "listed",
					(error: Error) => error.message,
				);
			// `;` first: a `{` hides every later `;` from the split.
			const alone = await failure(";*}x{*");
			expect(alone).toContain("unopened alternate group");
			expect(await failure("*.md;*}x{*")).toBe(alone);
		});
	});
});
