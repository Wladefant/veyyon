/**
 * WHY THIS SUITE EXISTS:
 *
 * Every text read stored `details.displayContent.lineNumbers`, one number per displayed row, even for
 * a contiguous window where each number is `startLine + index`. The list is written into the session
 * file with every read result and costs one JSON number per line read, while both renderers already
 * count up from `startLine` when the list is absent.
 *
 * CLASS: whatever path builds a read's display (in-memory single range, in-memory multi range,
 * streamed file, streamed artifact, multi-range file), the stored list is present only when the count
 * from `startLine` breaks, and the number the card draws beside each row is the number the model saw
 * on that row. The second assertion is what keeps the first honest: a list dropped where it was not
 * derivable misnumbers the card, and the sweep reads the model's own `N:` / `N|` rows to catch it.
 *
 * DOES NOT CATCH: a read path added later that is not reached by one of the swept sources and
 * selectors, or a renderer that stops treating an absent list as counting up from `startLine` without
 * going through the read card drawn here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool, type ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const LINES = Array.from({ length: 12 }, (_, i) => `row ${i + 1} of the fixture`);
const TEXT = LINES.join("\n");

interface Case {
	source: string;
	selector: string;
	/** Whether the displayed rows break the count from their first number. */
	gapped: boolean;
}

const SOURCES = {
	file: (dir: string) => path.join(dir, "notes.txt"),
	"archive member": (dir: string) => `${path.join(dir, "arc.zip")}:notes.txt`,
	artifact: () => "artifact://0",
} as const;

const CASES: Case[] = Object.keys(SOURCES).flatMap(source => [
	{ source, selector: ":4-7", gapped: false },
	{ source, selector: ":raw:4-7", gapped: false },
	{ source, selector: ":1-2,9-10", gapped: true },
]);
CASES.push({ source: "file", selector: "", gapped: false });

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(entry => (entry.type === "text" ? (entry.text ?? "") : "")).join("\n");
}

/** The rows the model read, keyed by the number printed on each: `N:text` or `N|text`. */
function modelRows(text: string): Map<number, string> {
	const rows = new Map<number, string>();
	for (const line of text.split("\n")) {
		const match = /^(\d+)[:|](.*)$/.exec(line);
		if (match) rows.set(Number(match[1]), match[2]);
	}
	return rows;
}

describe("a read records line numbers only where the count breaks", () => {
	let tmpDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;

	function session(): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "session"),
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-line-numbers-"));
		const artifactDir = path.join(tmpDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.writeFile(path.join(tmpDir, "notes.txt"), TEXT);
		await fs.writeFile(path.join(artifactDir, "0.bash.log"), TEXT);
		await fs.writeFile(path.join(tmpDir, "arc.zip"), zip({ "notes.txt": new TextEncoder().encode(TEXT) }));
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await removeWithRetries(tmpDir);
	});

	for (const testCase of CASES) {
		const label = `${testCase.source}${testCase.selector || " (whole)"}`;

		it(`${label}: stores a number list only when the rows break the count`, async () => {
			const target = SOURCES[testCase.source as keyof typeof SOURCES](tmpDir) + testCase.selector;
			const result = await new ReadTool(session()).execute("r", { path: target });
			// Round-trip as the session file does, so the assertion reads what is persisted.
			const details = JSON.parse(JSON.stringify(result.details)) as ReadToolDetails;
			const display = details.displayContent;
			expect(display?.text).toBeDefined();
			if (display?.text === undefined) return;

			const rows = display.text.split("\n");
			const numbers = display.lineNumbers ?? rows.map((_, index) => display.startLine + index);
			expect(numbers).toHaveLength(rows.length);
			const derivable = numbers.every((number, index) => number === display.startLine + index);
			expect(display.lineNumbers === undefined).toBe(derivable);
			expect(derivable).toBe(!testCase.gapped);

			// Every numbered row is the row the model saw under that number.
			const seen = modelRows(modelText(result));
			const drawn = new Map<number, string>();
			numbers.forEach((number, index) => {
				if (number !== null) drawn.set(number, rows[index]);
			});
			if (seen.size > 0) expect(drawn).toEqual(seen);
			for (const [number, row] of drawn) expect(row).toBe(LINES[number - 1]);
		});
	}

	it("draws a contiguous window numbered from its first line, with no list stored", async () => {
		const result = await new ReadTool(session()).execute("r", { path: `${path.join(tmpDir, "notes.txt")}:4-7` });
		const details = JSON.parse(JSON.stringify(result.details)) as ReadToolDetails;
		expect(details.displayContent?.lineNumbers).toBeUndefined();
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const card = drawToolView(
			readToolView.renderResult(
				{ content: result.content, details },
				{ expanded: true, partial: false },
				{ path: "notes.txt:4-7" },
			),
			theme!,
		);
		const drawnRows = Bun.stripANSI(card.render(120).join("\n"))
			.split("\n")
			.map(row => /\b(\d+) (row \d+ of the fixture)\b/.exec(row))
			.filter(match => match !== null)
			.map(match => [Number(match[1]), match[2]]);

		const shown = details.displayContent?.text?.split("\n") ?? [];
		const start = details.displayContent?.startLine ?? 0;
		expect(drawnRows).toEqual(shown.map((row, index) => [start + index, row]));
		expect(drawnRows.map(([number]) => number)).toContain(4);
		expect(drawnRows.map(([number]) => number)).toContain(7);
	});
});
