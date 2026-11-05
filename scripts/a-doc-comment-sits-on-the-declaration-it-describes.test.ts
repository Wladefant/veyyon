/**
 * WHY: a doc comment documents the declaration that follows it. When a helper is inserted between a
 * function and its doc comment, the doc block ends up directly on top of the helper's own doc block:
 * an editor shows only the helper's text, and the stranded block describes a declaration it no longer
 * touches. When a doc is rewritten without deleting the old one, the two stack the same way and the
 * older one goes stale beside the newer.
 *
 * The class this closes is a doc block in shipped source that ends on the line directly above
 * another doc block, in any first-party member the workspace resolves. The sweep reads every
 * tracked `.ts` and `.tsx` file under those members, so a new member or file is covered with no edit
 * here. A file's own header is exempt: a block preceded by nothing but comments documents the
 * module, not the declaration after it.
 *
 * What it does not catch: a doc block separated from the next one by a blank line, which is also how
 * a module header written after the imports looks, and a doc block on the wrong declaration with no
 * second doc block beside it. Tests, benches, scripts and vendored code are out of scope: test files
 * keep dated re-measurement entries as stacked blocks, and vendored code is not edited here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedFiles } from "./git-baseline";
import { existingOnly, typeScriptMemberTopLevels } from "./workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Path segments whose files are not shipped source. */
const NOT_SHIPPED = ["/test/", "/tests/", "/scripts/", "/vendor/", "/fixtures/", "/benches/"];

function shippedSourceFiles(): string[] {
	const raw = listTrackedFiles(REPO_ROOT, typeScriptMemberTopLevels());
	return existingOnly(
		REPO_ROOT,
		raw.filter(
			file =>
				(file.endsWith(".ts") || file.endsWith(".tsx")) &&
				!file.endsWith(".d.ts") &&
				!/\.test\.tsx?$/.test(file) &&
				!file.startsWith("tests/") &&
				!NOT_SHIPPED.some(segment => `/${file}`.includes(segment)),
		),
	).sort();
}

/** A block comment that has opened and not yet closed. */
interface OpenBlock {
	readonly line: number;
	readonly doc: boolean;
	readonly codeBefore: boolean;
}

function opensDocNext(lines: readonly string[], index: number): boolean {
	return lines[index + 1]?.trim().startsWith("/**") === true;
}

/**
 * The 1-based first line of every doc block that ends directly above another doc block, skipping a
 * block that only comments precede.
 */
function strandedDocComments(source: string): number[] {
	const lines = source.split("\n");
	const stranded: number[] = [];
	let codeSeen = false;
	let open: OpenBlock | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (open) {
			if (!line.includes("*/")) continue;
			if (open.doc && open.codeBefore && opensDocNext(lines, i)) stranded.push(open.line);
			open = undefined;
			continue;
		}
		if (line.startsWith("/*")) {
			const doc = line.startsWith("/**");
			if (line.includes("*/", 2)) {
				if (doc && codeSeen && opensDocNext(lines, i)) stranded.push(i + 1);
				continue;
			}
			open = { line: i + 1, doc, codeBefore: codeSeen };
			continue;
		}
		if (line.length > 0 && !line.startsWith("//")) codeSeen = true;
	}
	return stranded;
}

describe("a doc comment sits on the declaration it describes", () => {
	it("flags a doc block stacked on another one, and no header, plain block or separated pair", () => {
		const source = [
			"/** The module. */",
			"/** More about the module, still before any code. */",
			'import { x } from "y";',
			"",
			"/**",
			" * Stranded: its function moved below the helper.",
			" */",
			"/** The helper. */",
			"function helper() {}",
			"/** Rewritten without deleting the old one. */",
			"/**",
			" * The newer doc.",
			" */",
			"function rewritten() {}",
			"/* a plain block comment */",
			"/** A doc after a plain block comment. */",
			"function plain() {}",
			"/** Separated by a blank line. */",
			"",
			"/** Next. */",
			"function separated() {}",
		].join("\n");
		expect(strandedDocComments(source)).toEqual([5, 10]);
	});

	it("finds no stranded doc block in shipped source", () => {
		const files = shippedSourceFiles();
		expect(files.length).toBeGreaterThan(2000);
		expect(files).toContain("kernel/src/session/session-context.ts");
		expect(files).toContain("plugins/web/src/scrapers/types.ts");
		const offenders = files.flatMap(file =>
			strandedDocComments(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")).map(line => `${file}:${line}`),
		);
		expect(offenders).toEqual([]);
	});
});
