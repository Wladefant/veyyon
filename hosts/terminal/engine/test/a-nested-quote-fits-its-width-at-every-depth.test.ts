/**
 * WHY: a blockquote reserves two cells for its `│ ` border and lays its content out in the rest. Once nesting used up
 * the width, the content width clamped to one cell while every deeper quote still prefixed its two-cell border, so
 * each enclosing quote re-wrapped those three-cell rows at one cell and split every row in two. The row count doubled
 * per nesting level: `>`×20 around fifteen characters rendered 425,984 rows at width 12 and took half a second per
 * frame, on model output the TUI renders on every streamed chunk.
 *
 * The class is any quote nesting, of any container content, whose rows outgrow the width they are given and so
 * multiply under the enclosing quotes. The sweep covers every width from 1 to 40 and every depth up to past both
 * nesting caps (the input marker cap and Markdown.MAX_RENDER_DEPTH), for unspaced and spaced `>` runs around a
 * paragraph, a list, a heading and an HTML `<blockquote>`. Each frame must fit its width, and hold no more rows than
 * the source has characters, since every row carries at least one source character.
 *
 * The theme is production-shaped (`theme-class.ts`: one raw SGR pair per style); chalk re-opens cost O(d²) per row.
 *
 * Not caught: a single quote level whose content row overflows by one wide grapheme at a one-cell width, which wraps
 * once and does not compound; content that is not ASCII is outside the width assertion for that reason.
 */
import { describe, expect, it } from "bun:test";
import type { MarkdownTheme } from "@veyyon/tui";
import { Markdown } from "@veyyon/tui/components/markdown";
import { visibleWidth } from "@veyyon/utils/width";
import { defaultMarkdownTheme } from "./test-themes.js";

const sgr = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
const fg = (color: number) => sgr(`38;5;${color}`, "39");
const THEME: MarkdownTheme = {
	heading: fg(75),
	link: fg(39),
	linkUrl: fg(244),
	code: fg(180),
	codeBlock: fg(150),
	codeBlockBorder: fg(240),
	quote: fg(246),
	quoteBorder: fg(240),
	hr: fg(240),
	listBullet: fg(75),
	bold: sgr("1", "22"),
	italic: sgr("3", "23"),
	strikethrough: sgr("9", "29"),
	underline: sgr("4", "24"),
	symbols: defaultMarkdownTheme.symbols,
};

const MAX_WIDTH = 40;
const MAX_DEPTH = Markdown.MAX_RENDER_DEPTH + 8;
const MARKERS = { unspaced: (depth: number) => ">".repeat(depth), spaced: (depth: number) => "> ".repeat(depth) };
const CONTENT = {
	paragraph: "deep words here",
	list: "- deep words here",
	heading: "## deep words here",
	html: "<blockquote>deep words here</blockquote>",
};

describe("a nested quote", () => {
	for (const [markerName, marker] of Object.entries(MARKERS)) {
		for (const [contentName, content] of Object.entries(CONTENT)) {
			it(`fits its width at every depth (${markerName} markers around a ${contentName})`, () => {
				for (let depth = 1; depth <= MAX_DEPTH; depth++) {
					const source = `${marker(depth)} ${content}`;
					for (let width = 1; width <= MAX_WIDTH; width++) {
						const rows = new Markdown(source, 0, 0, THEME).render(width);
						const label = `depth ${depth} width ${width}`;
						expect({ label, rows: rows.length <= source.length }).toEqual({ label, rows: true });
						const wide = rows.filter(row => visibleWidth(row) > width);
						expect({ label, wide }).toEqual({ label, wide: [] });
					}
				}
			});
		}
	}
});
