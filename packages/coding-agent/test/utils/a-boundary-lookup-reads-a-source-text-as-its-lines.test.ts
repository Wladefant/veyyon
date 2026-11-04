import { describe, expect, it } from "bun:test";
import { type BlockContextSource, findBlockContextLines } from "@veyyon/coding-agent/utils/block-context";

/**
 * WHY: a diff holds both sides of an edit as text and used to split each into a whole-file line array
 * before asking for the block an off-window line belongs to, though the tree-sitter lookup reads only the
 * few boundary lines it returns. The lookup now takes the text in place of its lines: it hands the text to
 * the parser, reads the returned lines off it, counts line breaks only as far as the visible set, and
 * splits only for the lexical scan.
 *
 * The class closed: a lookup on a text that answers differently from the same lookup on its lines — a
 * boundary line read off by one, a line past the end that is not "", a CRLF line that loses its "\r", a
 * window that covers every line counted wrong, or a backend reached on one form and not the other. The
 * sweep runs both forms over every backend the lookup has: a grammar tree-sitter parses (TypeScript,
 * Python), a source it rejects, and a path with no grammar or none at all.
 *
 * Gaps: the sources are small, so the scan ceiling is not reached here; the ceiling's own suite covers it.
 */

const SOURCES: Record<string, BlockContextSource> = {
	typescript: { path: "sample.ts" },
	python: { path: "sample.py" },
	unknownGrammar: { path: "sample.unknownext" },
	noPath: {},
};

const SNIPPETS = [
	"function f(a) {",
	"}",
	"if (a) {",
	"\treturn [",
	"\t];",
	"call(",
	");",
	"const s = '(';",
	"/* { */",
	"// }",
	"",
	"x = 1\r",
	"def g():",
	"    return (1,",
	"        2)",
	"class C:",
];

function sampleCases(count: number): { text: string; visible: number[] }[] {
	let seed = 20261018;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const cases: { text: string; visible: number[] }[] = [
		{ text: "", visible: [1] },
		{ text: "a", visible: [1] },
		{ text: "a\n", visible: [1] },
		{ text: "a\n", visible: [1, 2] },
		// A window one line short of the source, whose hidden line is a boundary.
		{ text: "f(\n)", visible: [1] },
		{ text: "f(\n)\n", visible: [1] },
		{ text: "f(\n)", visible: [2, 3] },
		{ text: "f() {\r\n}\r\n", visible: [1] },
	];
	while (cases.length < count) {
		const lines: string[] = [];
		const lineCount = Math.floor(next() * 24);
		for (let line = 0; line < lineCount; line++) lines.push(SNIPPETS[Math.floor(next() * SNIPPETS.length)]);
		const text = lines.join("\n") + (next() < 0.5 ? "\n" : "");
		const visible: number[] = [];
		const total = text.split("\n").length;
		for (let line = 1; line <= total + 2; line++) if (next() < 0.3) visible.push(line);
		cases.push({ text, visible });
	}
	return cases;
}

describe("a boundary lookup reads a source text as its lines", () => {
	it.each(Object.keys(SOURCES))("answers the same from the text and from its lines with %s", async name => {
		const source = SOURCES[name];
		const failures: string[] = [];
		for (const { text, visible } of sampleCases(400)) {
			const fromText = [...(await findBlockContextLines(text, visible, source))];
			const fromLines = [...(await findBlockContextLines(text.split("\n"), visible, source))];
			if (failures.length < 5 && JSON.stringify(fromText) !== JSON.stringify(fromLines)) {
				failures.push(`${JSON.stringify(text)} ${JSON.stringify(visible)}: ${JSON.stringify(fromText)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("reads each boundary line off the text, including a CRLF line and a last line with no break", async () => {
		const text = "function f() {\r\n\tif (a) {\r\n\t\tg();\r\n\t}\r\n}";
		// The function's opener and the `if` closer are visible; their other ends are the boundaries.
		expect([...(await findBlockContextLines(text, [1, 4], { path: "sample.ts" }))]).toEqual([
			[2, "\tif (a) {\r"],
			[5, "}"],
		]);
	});
});
