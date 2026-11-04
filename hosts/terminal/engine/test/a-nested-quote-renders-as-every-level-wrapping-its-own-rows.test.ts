/**
 * WHY: a blockquote borders the rows a nested quote already laid out without wrapping them again, so a quote nested
 * `d` deep does not rescan every row `d` times. That skip is correct only while those rows are what a re-wrap would
 * return. Two conditions decide it: the border fits the two cells a quote reserves for it, and every row the nested
 * quote produced measures within the content width. A theme whose border symbol is two cells wide, or a grapheme
 * wider than the content width, breaks one of them; skipping the wrap then leaves rows wider than the quote's content
 * width under its border.
 *
 * The class is any nesting whose skipped wrap would have changed a row. The suite compares every render with a
 * reference that wraps each level's rows at that level's content width and borders them, the layout before the skip
 * existed. It sweeps one- and two-cell border symbols, symbols that lead with a blank, a styled border, and content
 * with words, a nested list and two-cell graphemes, at every depth and width in range.
 *
 * Not caught: a difference that the final per-row wrap of the whole render erases, such as the hanging-indent reorder
 * of a styled border that leads with a blank. Those renders are byte-identical by construction, so no render output
 * can tell the two layouts apart. Quote and italic styling are identity here, so the reference does not need to model
 * how a quote restyles the rows inside it.
 */

import { describe, expect, it } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import type { MarkdownTheme } from "@veyyon/tui";
import { Markdown } from "@veyyon/tui/components/markdown";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import { defaultMarkdownTheme } from "./test-themes.js";

const MAX_DEPTH = 6;
const MAX_WIDTH = 24;
const SYMBOLS = ["│", ">", "||", "世", " ", "\t", " |"];
const CONTENT = {
	paragraph: "deep words wrap around here",
	"nested list": "- one two three\n  - four five six",
	"wide graphemes": "世界 wide 世界",
};

const plain = (text: string) => text;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

function themeFor(quoteBorder: string, borderStyle: (text: string) => string): MarkdownTheme {
	return {
		heading: plain,
		link: plain,
		linkUrl: plain,
		code: plain,
		codeBlock: plain,
		codeBlockBorder: plain,
		quote: plain,
		quoteBorder: borderStyle,
		hr: plain,
		listBullet: plain,
		bold: plain,
		italic: plain,
		strikethrough: plain,
		underline: plain,
		symbols: { ...defaultMarkdownTheme.symbols, quoteBorder },
	};
}

/** `content` quoted `depth` deep, each level re-wrapping the rows of the level inside it. */
function wrappedAtEveryLevel(theme: MarkdownTheme, depth: number, content: string, width: number): readonly string[] {
	if (depth === 0) return new Markdown(content, 0, 0, theme).render(width);
	const contentWidth = width > 2 ? width - 2 : Math.max(1, width);
	const border = width > 2 ? theme.quoteBorder(`${theme.symbols.quoteBorder} `) : "";
	return wrappedAtEveryLevel(theme, depth - 1, content, contentWidth).flatMap(line =>
		wrapTextWithAnsi(line, contentWidth).map(row => border + row),
	);
}

describe("a nested quote", () => {
	for (const [borderName, borderStyle] of [
		["plain", plain],
		["styled", dim],
	] as const) {
		for (const symbol of SYMBOLS) {
			for (const [contentName, content] of Object.entries(CONTENT)) {
				it(`renders as every level wrapping its own rows (${borderName} ${JSON.stringify(symbol)} border, ${contentName})`, () => {
					const theme = themeFor(symbol, borderStyle);
					const mismatched: string[] = [];
					for (let depth = 1; depth <= MAX_DEPTH; depth++) {
						const marker = ">".repeat(depth);
						const source = content
							.split("\n")
							.map(line => `${marker} ${line}`)
							.join("\n");
						for (let width = 1; width <= MAX_WIDTH; width++) {
							const actual = new Markdown(source, 0, 0, theme).render(width);
							const expected = wrappedAtEveryLevel(theme, depth, content, width).flatMap(row =>
								wrapTextWithAnsi(row, width),
							);
							if (!isDeepStrictEqual(actual, expected)) mismatched.push(`depth ${depth} width ${width}`);
						}
					}
					expect(mismatched).toEqual([]);
				});
			}
		}
	}
});
