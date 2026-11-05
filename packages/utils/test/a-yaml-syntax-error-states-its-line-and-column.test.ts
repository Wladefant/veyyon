import { describe, expect, it } from "bun:test";
import { parseJsonOrYamlByExtension } from "../src/config-parse";
import { parseYaml } from "../src/yaml-sync";

/**
 * WHY. Bun's YAML parser states a syntax error as `YAML Parse error: Unexpected token`, and the
 * `line` and `column` it attaches are those of the JavaScript call site, not of the text. Every
 * config loader embedded that message, so a hand-edited file with one typo was reported with no
 * position. `parseYaml` parses failing text again with the `yaml` package and states its first
 * error with the line and column.
 *
 * Each shape below is a different error in the `yaml` package, so a change that handles one error
 * code and not another fails here. The fallback case is an error the `yaml` package does not report
 * while parsing, where Bun's message is the only one there is.
 *
 * Not caught: a loader that calls `Bun.YAML.parse` itself. The coding-agent suite
 * `a-config-file-that-does-not-parse-states-its-line` drives the loaders whose errors reach the
 * operator.
 */

const BROKEN: ReadonlyArray<{ readonly shape: string; readonly text: string; readonly message: string }> = [
	{
		shape: "a value holding a second colon",
		text: "theme: dark\nstatusLine: time: %H:%M\n",
		message: "Nested mappings are not allowed in compact mappings at line 2, column 13",
	},
	{
		shape: "an unclosed flow sequence",
		text: "theme: dark\nfoo: [\n",
		message: "Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1",
	},
	{
		shape: "a tab used as indentation",
		text: "a: 1\n\tb: 2\n",
		message: "Tabs are not allowed as indentation at line 2, column 1",
	},
	{
		shape: "an unclosed quote",
		text: 'k: "unterminated\n',
		message: 'Missing closing "quote at line 2, column 1',
	},
];

function thrownBy(parse: () => unknown): Error {
	try {
		parse();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`expected an Error, got ${String(error)}`);
	}
	throw new Error("expected the parse to throw");
}

describe("parseYaml", () => {
	for (const { shape, text, message } of BROKEN) {
		it(`states ${shape} with its line and column, keeping Bun's error as the cause`, () => {
			const error = thrownBy(() => parseYaml(text));
			expect(error).toBeInstanceOf(SyntaxError);
			expect(error.message).toBe(message);
			const cause = error.cause;
			if (!(cause instanceof Error)) throw new Error("expected Bun's error as the cause");
			expect(cause.message).toStartWith("YAML Parse error");
		});
	}

	it("states the error with its line through the by-extension reader for a .yml path", () => {
		const { text, message } = BROKEN[0];
		expect(thrownBy(() => parseJsonOrYamlByExtension(text, "/etc/lsp.yml")).message).toBe(message);
	});

	it("keeps Bun's message for an error the yaml package does not report while parsing", () => {
		expect(thrownBy(() => parseYaml("a: *undefined_alias\n")).message).toBe("YAML Parse error: Unresolved alias");
	});

	it("returns the value of text that parses", () => {
		expect(parseYaml("theme: dark\nstatusLine: 'time: %H:%M'\n")).toEqual({
			theme: "dark",
			statusLine: "time: %H:%M",
		});
	});
});
