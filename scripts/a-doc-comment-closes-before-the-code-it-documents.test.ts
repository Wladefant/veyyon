/**
 * WHY: a doc comment that loses its `*\/` runs on to the next one, and everything between the two is
 * a comment. Nothing fails: the code still parses, a type checker does not miss a method nobody
 * calls, and a test file that loses a `describe` block reports fewer tests rather than a failure. A
 * merge left `RpcClient.login` inside the doc comment above it, so the class shipped without the
 * method, and left four `describe` blocks of the first-frame replay suite commented out, so the
 * replay's launch-shape and environment checks ran nowhere.
 *
 * The class this closes is a doc comment, opened by `/**` at the start of a line, whose body holds a
 * line that does not start with `*`, in any tracked `.ts` or `.tsx` file outside vendored code,
 * shipped source and tests alike. A doc comment written with a `*` on every line holds no code, so
 * such a line is code that the missing terminator swallowed.
 *
 * What it does not catch: a plain `/*` comment that loses its terminator, since a plain block is how
 * code is commented out on purpose, and a doc comment that opens after code on the same line.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedFiles } from "./git-baseline";
import { isVendored } from "./workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function typeScriptFiles(): string[] {
	return listTrackedFiles(REPO_ROOT)
		.filter(file => (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.endsWith(".d.ts") && !isVendored(file))
		.sort();
}

/** The 1-based first line of every doc comment whose body holds a line that does not start with `*`. */
function docCommentsHoldingCode(source: string): number[] {
	const lines = source.split("\n");
	const found: number[] = [];
	let open: number | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (open !== undefined) {
			if (line !== "" && !line.startsWith("*") && found.at(-1) !== open) found.push(open);
			if (line.includes("*/")) open = undefined;
			continue;
		}
		if (line.startsWith("/**") && !line.includes("*/", 3)) open = i + 1;
	}
	return found;
}

describe("a doc comment closes before the code it documents", () => {
	it("flags a doc comment that runs into code, and no closed, one-line or blank-lined doc", () => {
		const source = [
			"/** One line. */",
			"function one() {}",
			"/**",
			" * Closed.",
			" *",
			"",
			" * A blank line inside is still a comment.",
			" */",
			"function closed() {}",
			"/**",
			" * Lost its terminator.",
			"function swallowed() {",
			"\treturn 1;",
			"}",
			"/** The next doc closes the comment. */",
			"function next() {}",
			"/* a plain block",
			"commented out on purpose */",
			"/**",
			" * Closed on a line of code. */ const x = 1;",
		].join("\n");
		expect(docCommentsHoldingCode(source)).toEqual([10]);
	});

	it("finds no doc comment holding code in any tracked TypeScript file", () => {
		const files = typeScriptFiles();
		expect(files).toContain("packages/coding-agent/src/modes/rpc/rpc-client.ts");
		expect(files).toContain("packages/coding-agent/test/a-replayed-card-describes-the-screen-it-replays.test.ts");
		expect(files.length).toBeGreaterThan(5000);
		const offenders = files.flatMap(file =>
			docCommentsHoldingCode(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")).map(line => `${file}:${line}`),
		);
		expect(offenders).toEqual([]);
	});
});
