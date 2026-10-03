/**
 * A streamed Markdown holds a few copies of its text while it streams, and once sealed holds what one
 * render of the same text holds.
 *
 * THE DEFECT. The streaming lexer re-lexes only the tail past the frozen prefix, and the tail was a
 * slice of the frame's text. A slice shares the buffer it was cut from, and so does every token marked
 * cuts from it. A provider builds its text by appending, so every frame reads a new buffer, and the
 * tokens frozen on each frame held that frame's whole text: one 206,000-character answer held 76 MiB.
 * Sealing changed nothing: the frozen tokens, the frozen rows and the text of the last settled
 * exposure stayed for the life of the block.
 *
 * THE CLASS. A string a Markdown keeps from a stream frame beyond what its current text and rows
 * need: a token, a row, a prefix, an exposure. Every block shape the streaming lexer freezes on is
 * streamed one chunk per frame into a buffer of its own, and the string bytes one instance holds
 * afterwards are bounded against the same text rendered once: while streaming, by a few copies of the
 * text; once sealed, by half a copy. The closing paragraph keeps arriving for several frames after the
 * last block freezes, so the frame that froze last is never the frame that sealed.
 *
 * WHAT IT DOES NOT CATCH. JSC counts only out-of-line string storage as extra memory, so a retained
 * string short enough to live inline passes. A sealed block that keeps less than half a copy of its
 * text passes; the bound sits above the variation of a full collection.
 */
import { heapStats } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const TEXT_CHARS = 32_000;
const CHUNK = 64;
const WIDTH = 80;
const COPIES = 6;

/** One unit of every block shape the streaming lexer freezes on. Units are joined by a blank line. */
const SHAPES: ReadonlyArray<readonly [string, (i: number) => string]> = [
	[
		"a paragraph",
		i => `Paragraph ${i} of plain prose that wraps across the terminal width more than once, so it lays out as rows.`,
	],
	["a heading", i => `## Heading number ${i} with a few words`],
	["a fenced code block", i => `\`\`\`ts\nconst value${i} = compute(${i});\nconst other${i} = value${i} * 2;\n\`\`\``],
	["a table", i => `| Column | Value ${i} |\n| --- | --- |\n| row | ${i} |`],
	["a blockquote", i => `> Quoted line ${i} that carries a sentence of prose inside the quote.`],
	["a thematic break", i => `Rule ${i} follows.\n\n---`],
	["a display math block", i => `$$\nx_${i} = \\frac{a}{b}\n$$`],
	["a list closed by a paragraph", i => `- item ${i} one\n- item ${i} two\n\nParagraph after list ${i}.`],
];

const CLOSING = "A closing paragraph that is still arriving when the stream seals. ".repeat(8);

function textOf(unit: (i: number) => string): string {
	let text = "";
	for (let i = 0; text.length < TEXT_CHARS; i++) text += `${unit(i)}\n\n`;
	return text + CLOSING;
}

type Arm = "streaming" | "sealed" | "rendered once";

function build(full: string, arm: Arm): Markdown {
	clearRenderCache();
	const md = new Markdown("", 0, 0, defaultMarkdownTheme);
	md.transientRenderCache = arm !== "rendered once";
	let text = "";
	for (let pos = 0; pos < full.length; pos += CHUNK) {
		// An append and a read: a new flat buffer per frame, as a provider's accumulated text is.
		text += full.slice(pos, pos + CHUNK);
		if (arm === "rendered once") {
			text.charCodeAt(text.length - 1);
		} else {
			md.setText(text);
			md.render(WIDTH);
		}
	}
	if (arm === "rendered once") {
		md.setText(text);
		md.render(WIDTH);
	} else if (arm === "sealed") {
		md.transientRenderCache = false;
		md.render(WIDTH);
	}
	return md;
}

function stringBytes(): number {
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().extraMemorySize;
}

/** String bytes one instance built by `arm` holds after a full collection, per character of its text. */
function heldPerChar(full: string, arm: Arm): number {
	// Compiles the paths this arm takes before the baseline is read.
	build(full, arm);
	const before = stringBytes();
	const held = Array.from({ length: COPIES }, () => build(full, arm));
	const after = stringBytes();
	expect(held).toHaveLength(COPIES);
	return (after - before) / COPIES / full.length;
}

describe("a streamed Markdown holds what its text needs", () => {
	it.each(SHAPES)("%s: while it streams, a few copies of the text", (_name, unit) => {
		const full = textOf(unit);
		const once = heldPerChar(full, "rendered once");
		expect(heldPerChar(full, "streaming") - once).toBeLessThan(6);
	});

	it.each(SHAPES)("%s: once sealed, what one render of the text holds", (_name, unit) => {
		const full = textOf(unit);
		const once = heldPerChar(full, "rendered once");
		expect(heldPerChar(full, "sealed") - once).toBeLessThan(0.5);
	});
});
