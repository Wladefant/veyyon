/**
 * Default themes for TUI tests: one raw SGR open/close pair per style, the shape the production
 * theme writes. Chalk re-opens a style after every inner close, so a row nested `d` styles deep
 * would carry O(d²) escape codes that no production render carries.
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@veyyon/tui";
import type { SymbolTheme } from "@veyyon/utils/symbols";

const sgr =
	(open: number, close: number) =>
	(text: string): string =>
		`\x1b[${open}m${text}\x1b[${close}m`;
const bold = sgr(1, 22);
const dim = sgr(2, 22);
const italic = sgr(3, 23);
const underline = sgr(4, 24);
const strikethrough = sgr(9, 29);
const green = sgr(32, 39);
const yellow = sgr(33, 39);
const blue = sgr(34, 39);
const cyan = sgr(36, 39);

const defaultSymbols: SymbolTheme = {
	cursor: ">",
	inputCursor: "|",
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
	},
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: "│",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: blue,
	selectedText: bold,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
	symbols: defaultSymbols,
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => bold(cyan(text)),
	link: blue,
	linkUrl: dim,
	code: yellow,
	codeBlock: green,
	codeBlockBorder: dim,
	quote: italic,
	quoteBorder: dim,
	hr: dim,
	listBullet: cyan,
	bold,
	italic,
	strikethrough,
	underline,
	symbols: defaultSymbols,
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: dim,
	selectList: defaultSelectListTheme,
	symbols: defaultSymbols,
};
