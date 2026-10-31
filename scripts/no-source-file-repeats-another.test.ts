/**
 * No first-party source file repeats another.
 *
 * THE DEFECT. The suite for the composer's draft markers existed three times:
 * `packages/coding-agent/test/modes/a-composer-marker-is-read-whole-or-read-as-text.test.ts`, the same
 * file again under `test/modes/terminal/` after the tests moved beside their sources, and a third copy
 * there named `a-draft-marker-is-recognized-by-shape-and-only-images-renumber.test.ts`, added by a
 * merge of that move. The submitted-draft suite stayed behind in `test/modes/` the same way, with its
 * header naming the module's old path. In `plugins/hashline/test/`, two expansion suites each had a
 * twin with the same body under another file name and describe title. CI ran every copy, and a change
 * to the contract had to find and edit each one or leave the rest asserting the old behavior.
 *
 * THE CLASS. A file copied whole where it was meant to move or to vary: a rename that kept the old
 * path, a merge that brought both sides of a move, a suite duplicated under a new title, a module
 * duplicated into a second package. Every first-party TypeScript and Rust file git lists is swept. A
 * test suite is compared with its comments, its whitespace and the titles of its `describe`, `it`
 * and `test` calls removed, so a copy whose header or title was reworded still matches. Any other
 * source file is compared byte for byte, because two modules with the same code in different
 * directories are different modules when their imports are relative: sibling barrels that each
 * re-export `./harness` are the ordinary case. Two that match fail unless the group is listed in
 * `SANCTIONED_COPIES`, which is pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH. A suite copy with one changed token outside a comment or a title: an import
 * path, a constant, a renamed local. A comment that trails code on its line is compared as code. A
 * module copy that differs only in a comment. Vendored trees under `natives/vendor/` are outside the
 * sweep.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedFiles, REPO_ROOT } from "./git-baseline";

const SOURCE = /\.(?:[cm]?tsx?|rs)$/;
const SUITE = /\.test\.[cm]?tsx?$/;
const FOREIGN_ROOTS = ["natives/vendor/"];

/** Matching groups kept on purpose, each sorted, each with its reason. */
const SANCTIONED_COPIES: readonly (readonly string[])[] = [
	// Each package's bundler resolves stylesheet imports through an ambient declaration of its own.
	["apps/stats/src/client/css.d.ts", "clients/web/src/env.d.ts"],
];

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm;
const TEST_TITLE = /\b(describe|it|test)((?:\.\w+)*)\(\s*(["'`])(?:\\[\s\S]|(?!\3)[\s\S])*?\3/g;
const WHITESPACE = /\s+/g;

/** The text two suite copies share: no comment lines, no test titles, no whitespace. */
function comparableText(source: string): string {
	return source
		.replace(BLOCK_COMMENT, "")
		.replace(LINE_COMMENT, "")
		.replace(TEST_TITLE, "$1$2(")
		.replace(WHITESPACE, "");
}

/** A file the sweep reads: its repository path and its bytes. */
interface SourceFile {
	path: string;
	bytes: Buffer;
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Every group of two or more source files that repeat one another, each sorted: suites by their
 * comparable text, every other file by its bytes.
 */
function repeatedGroups(files: Iterable<SourceFile>): string[][] {
	const byDigest = new Map<string, string[]>();
	for (const file of files) {
		const digest = SUITE.test(file.path)
			? `suite:${sha256(comparableText(file.bytes.toString("utf8")))}`
			: `bytes:${sha256(file.bytes)}`;
		const group = byDigest.get(digest);
		if (group) group.push(file.path);
		else byDigest.set(digest, [file.path]);
	}
	return [...byDigest.values()]
		.filter(group => group.length > 1)
		.map(group => group.sort())
		.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

/** Every first-party TypeScript and Rust file git lists, with its bytes. */
function* firstPartySources(): Generator<SourceFile> {
	for (const file of listTrackedFiles(REPO_ROOT)) {
		if (!SOURCE.test(file) || FOREIGN_ROOTS.some(root => file.startsWith(root))) continue;
		yield { path: file, bytes: fs.readFileSync(path.join(REPO_ROOT, file)) };
	}
}

function source(filePath: string, text: string): SourceFile {
	return { path: filePath, bytes: Buffer.from(text) };
}

describe("no source file repeats another", () => {
	const suite = `/** One. */\nimport { x } from "./x";\n// note\ndescribe("first title", () => {\n\tit('adds', () => expect(x(1)).toBe(2));\n});\n`;
	const retitled = `/**\n * Two, reworded.\n */\nimport { x } from "./x";\ndescribe(\`second \${"title"}\`, () => {\n  it("sums", () => expect(x(1)).toBe(2));\n});\n`;

	it("groups a suite copy whose header or titles were reworded, and keeps a changed suite apart", () => {
		expect(
			repeatedGroups([
				source("b/x.test.ts", retitled),
				source("a/x.test.ts", suite),
				source("c/x.test.ts", suite.replace("toBe(2)", "toBe(3)")),
			]),
		).toEqual([["a/x.test.ts", "b/x.test.ts"]]);
	});

	it("groups modules only when their bytes match, so sibling barrels with their own headers stay apart", () => {
		const barrel = (family: string) => `/** The ${family} family. */\nexport * from "./harness";\n`;
		expect(
			repeatedGroups([
				source("sims/turn/index.ts", barrel("turn")),
				source("sims/paint/index.ts", barrel("paint")),
				source("pkg-b/css.d.ts", 'declare module "*.css";\n'),
				source("pkg-a/css.d.ts", 'declare module "*.css";\n'),
			]),
		).toEqual([["pkg-a/css.d.ts", "pkg-b/css.d.ts"]]);
	});

	it("holds no copy beyond the sanctioned groups", () => {
		expect(repeatedGroups(firstPartySources())).toEqual(SANCTIONED_COPIES.map(group => [...group]));
	});
});
