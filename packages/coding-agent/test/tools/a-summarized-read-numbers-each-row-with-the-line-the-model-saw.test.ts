/**
 * WHY THIS SUITE EXISTS:
 *
 * A structural summary shows the model `1-5:export function alpha(…) { … }`, `7:export const answer`,
 * rows whose numbers jump wherever a body was elided. The card drew the same rows numbered from its
 * first line up, one per row, so every row after the first elision carried the wrong number: the
 * summary recorded `startLine: 1` and no per-row list.
 *
 * CLASS: every row the card draws for a summarized read carries the number the model saw on that
 * row, whether the row is a kept line, a merged brace pair (its opening line) or a line after an
 * elision; a row that stands for no line (the elision marker, the budget notice and the blank row
 * before it) carries no number.
 *
 * DOES NOT CATCH: a summary layout added later whose rows the fixture below never produces, or a
 * host that draws a row's number from somewhere other than the recorded display.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { ReadTool, type ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { escapeRegExp, removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const TS_FIXTURE = `${[
	"export function alpha(value: string): string {",
	"\tconst clean = value.trim();",
	"\tconst label = clean || 'alpha';",
	"\treturn label.toUpperCase();",
	"}",
	"",
	"export const answer = 42;",
	"",
	"export function beta(): number {",
	"\tconst one = 1;",
	"\tconst two = 2;",
	"\treturn one + two;",
	"}",
	"",
	"export const gamma = 'gamma';",
].join("\n")}\n`;

/** A body with no closing brace: the summary keeps its first and last lines around a bare `…` row. */
const PY_FIXTURE = `${[
	"def greet(name: str) -> str:",
	"    clean = name.strip()",
	"    label = clean or 'world'",
	"    upper = label.upper()",
	"    return f'hello {upper}'",
	"",
	"ANSWER = 42",
].join("\n")}\n`;

/** Pins the outermost-only collector so each fixture elides its function bodies and nothing else. */
const SUMMARY_SETTINGS = {
	"read.summarize.enabled": true,
	"read.summarize.minTotalLines": 0,
	"read.summarize.unfoldUntil": 0,
	"read.summarize.unfoldLimit": 0,
};

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(entry => (entry.type === "text" ? (entry.text ?? "") : "")).join("\n");
}

/** Each non-empty row the model read and the number it opens with: `N:`, `N|`, `N-M:` or `N-M|`. */
function modelRows(text: string): Array<[number, string]> {
	const rows: Array<[number, string]> = [];
	for (const line of text.split("\n")) {
		const match = /^(\d+)(?:-\d+)?[:|](.+)$/.exec(line);
		if (match) rows.push([Number(match[1]), match[2]]);
	}
	return rows;
}

describe("a summarized read numbers each row with the line the model saw", () => {
	let tmpDir: string;
	let theme: Theme;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme missing");
		theme = dark;
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-summary-numbers-"));
		await fs.writeFile(path.join(tmpDir, "fixture.ts"), TS_FIXTURE);
		await fs.writeFile(path.join(tmpDir, "fixture.py"), PY_FIXTURE);
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function readAndDraw(file: string, overrides: Record<string, unknown> = {}) {
		const session = makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "session"),
			settings: Settings.isolated({ ...SUMMARY_SETTINGS, ...overrides }),
		});
		const result = await new ReadTool(session).execute("r", { path: path.join(tmpDir, file) });
		// Round-trip as the session file does, so the card draws what is persisted.
		const details = JSON.parse(JSON.stringify(result.details)) as ReadToolDetails;
		expect(details.summary?.elidedSpans).toBeGreaterThan(0);
		const card = drawToolView(
			readToolView.renderResult(
				{ content: result.content, details },
				{ expanded: true, partial: false },
				{ path: file },
			),
			theme,
		);
		return { model: modelText(result), drawn: Bun.stripANSI(card.render(160).join("\n")).split("\n") };
	}

	/** The number drawn in the gutter before `text`, or undefined when the row carries none. */
	function drawnNumber(drawn: string[], text: string): number | undefined {
		const pattern = new RegExp(`(?:^|\\s)(\\d+) ${escapeRegExp(text)}`);
		for (const row of drawn) {
			const match = pattern.exec(row);
			if (match) return Number(match[1]);
		}
		return undefined;
	}

	it("draws every kept row, merged brace pair and row after an elision under the model's number", async () => {
		const { model, drawn } = await readAndDraw("fixture.ts");
		const rows = modelRows(model);
		// Both bodies merged into their brace lines, and the kept lines after them jumped past the bodies.
		expect(rows.map(([number]) => number)).toEqual([1, 7, 9, 15]);

		for (const [number, text] of rows) expect(drawnNumber(drawn, text)).toBe(number);
	});

	it("draws a bare elision row without a number and the rows after it under the model's number", async () => {
		const { model, drawn } = await readAndDraw("fixture.py");
		expect(model.split("\n")).toContain("…");
		const rows = modelRows(model);
		expect(rows.map(([number]) => number)).toContain(7);
		for (const [number, text] of rows) expect(drawnNumber(drawn, text)).toBe(number);

		const elisionRows = drawn.filter(row => /(?:^|\s)…\s*$/.test(row));
		expect(elisionRows).toHaveLength(1);
		expect(elisionRows[0]).not.toMatch(/\d+ …\s*$/);
	});

	it("draws the budget notice that stops a summary without a line number", async () => {
		const { model, drawn } = await readAndDraw("fixture.ts", { "read.defaultLimit": 3 });
		const notice = model.split("\n").find(line => line.startsWith("[Summary reached"));
		expect(notice).toBeDefined();
		if (!notice) return;

		const noticeRow = drawn.find(row => row.includes(notice));
		expect(noticeRow).toBeDefined();
		expect(noticeRow).not.toMatch(new RegExp(`\\d+ ${escapeRegExp(notice)}`));
		for (const [number, text] of modelRows(model)) expect(drawnNumber(drawn, text)).toBe(number);
	});
});
