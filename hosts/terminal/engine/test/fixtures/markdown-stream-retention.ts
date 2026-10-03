/**
 * Streams every block shape the streaming lexer freezes on into a `Markdown`, one chunk per frame
 * into a buffer of its own, and prints, as JSON, the string bytes per character of its text one
 * instance holds after a full collection beyond what the same text rendered once holds: while
 * streaming, and once sealed. Each arm is read right after a rendered-once baseline of its own.
 *
 * It runs in a process of its own because the figure is the process's extra memory: in a test
 * process shared with other files, their leftover allocations land in the same figure.
 */
import { heapStats } from "bun:jsc";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "../test-themes.js";

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

export const SHAPE_NAMES: readonly string[] = SHAPES.map(([name]) => name);

type Arm = "streaming" | "sealed" | "rendered once";

/** Per shape, the string bytes per character one streamed instance holds beyond one rendered once. */
export type RetentionReport = Record<string, Record<"streaming" | "sealed", number>>;

const CLOSING = "A closing paragraph that is still arriving when the stream seals. ".repeat(8);

function textOf(unit: (i: number) => string): string {
	let text = "";
	for (let i = 0; text.length < TEXT_CHARS; i++) text += `${unit(i)}\n\n`;
	return text + CLOSING;
}

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
	if (held.length !== COPIES) throw new Error(`built ${held.length} instances, expected ${COPIES}`);
	return (after - before) / COPIES / full.length;
}

if (import.meta.main) {
	const report: RetentionReport = {};
	for (const [name, unit] of SHAPES) {
		const full = textOf(unit);
		const excess = (arm: "streaming" | "sealed"): number => {
			const once = heldPerChar(full, "rendered once");
			return heldPerChar(full, arm) - once;
		};
		report[name] = { streaming: excess("streaming"), sealed: excess("sealed") };
	}
	process.stdout.write(JSON.stringify(report));
}
