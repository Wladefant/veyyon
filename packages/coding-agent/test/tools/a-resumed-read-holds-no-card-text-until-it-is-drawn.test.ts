/**
 * WHY THIS SUITE EXISTS:
 *
 * A session file stores a read card's text only as a tag naming how the result's numbered rows
 * rebuild it (`a-session-file-stores-a-read-card-once`). Loading the session rebuilt every tagged card
 * text at once, as a rope over one sliced string per row, and the transcript copied each into its read
 * row. With read previews off, which is the default, no card ever draws that text, so a resumed
 * session held a second copy of every file it had read, in several string cells per row, for as long
 * as it stayed open: 50 MiB and 1.67 million cells on a 2627-read session.
 *
 * CLASS: a loaded `rows` card text is built on first read and never before it. Opening the session and
 * rebuilding its transcript with previews off keeps no copy of the rows, whatever form the copy takes
 * (a rope, a flat join, a copy the read row takes), and neither does a rewrite that writes every read
 * again, which writes an unchanged result's card as the tag it was loaded from; rebuilding with
 * previews on draws the rows; and a result whose content is replaced after the load (a prune, a shake,
 * a compaction elision) still writes the card text it was loaded with, since the rebuild reads the
 * rows the line was written with. Every step `STEPS` names is measured, so a new one is measured too.
 *
 * The string bytes are measured in a fresh process (`fixtures/resumed-read-string-growth.ts`): in the
 * process a suite shares, strings other files left behind die or stay alive in the window and moved
 * the delta by more than the body both ways.
 *
 * DOES NOT CATCH: a consumer outside the transcript rebuild and the session writer that reads
 * `displayContent.text` of every loaded result, which builds every card text again; the bound here
 * covers only the open, the rebuild and a rewrite. A `prefix` card text is a slice of the result's text
 * and is built eagerly, as it costs one string cell.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import {
	fileRows,
	type Growth,
	ROWS_TAG,
	readResult,
	rebuiltBuilder,
	recordReads,
	STEPS,
	type Step,
	setUpReadSessions,
} from "../fixtures/resumed-read-string-growth";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "resumed-read-string-growth.ts");

/** A fresh process loads the modules and takes two heap snapshots of its own heap. */
const MEASURED_ROW_TIMEOUT_MS = 60_000;

const STEP_NAMES: Record<Step, string> = {
	open: "the session opens and its transcript rebuilds with previews off",
	rewrite: "the session rewrites every entry after its first",
};

describe("a resumed read holds no card text until it is drawn", () => {
	let root: TempDir;

	beforeAll(async () => {
		await setUpReadSessions();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		root = TempDir.createSync("@pi-resumed-read-card-");
	});

	afterEach(async () => {
		await root.remove();
	});

	async function measureInFreshProcess(step: Step): Promise<Growth> {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const { stdout, stderr } = await run(process.execPath, [FIXTURE, root.path(), step], {
				env,
				timeout: MEASURED_ROW_TIMEOUT_MS - 5_000,
				killSignal: "SIGKILL",
			});
			expect(stderr).toBe("");
			return JSON.parse(stdout) as Growth;
		} finally {
			cleanup();
		}
	}

	function tags(file: string): number {
		return fs.readFileSync(file, "utf8").match(ROWS_TAG)?.length ?? 0;
	}

	for (const step of Object.keys(STEPS) as Step[]) {
		it(
			`keeps no copy of the rows after ${STEP_NAMES[step]}`,
			async () => {
				const growth = await measureInFreshProcess(step);
				// The written lines hold the tag and no text, so the load is the path under test.
				expect(growth.tagsWritten).toBe(growth.reads);
				expect(growth.entries).toBe(growth.reads + 1);
				// The measurement sees the loaded results, so a bound it passes is not a count that missed them.
				expect(growth.grown).toBeGreaterThan(growth.bodyBytes / 2);
				// The session holds each result's text once. A second copy of the rows, in any form, is
				// another body's worth of bytes on top.
				expect(growth.grown).toBeLessThan(growth.bodyBytes * 1.5);
				// Every card is still written as its tag.
				expect(growth.tagsAfter).toBe(growth.reads);
			},
			MEASURED_ROW_TIMEOUT_MS,
		);
	}

	it("draws the loaded rows when read previews are on", async () => {
		const file = await recordReads(root.path(), [readResult(0, 3).result]);
		expect(tags(file)).toBe(1);
		const builder = rebuiltBuilder(await SessionManager.open(file), true);
		const drawn = builder.container.render(160).map(line => stripVTControlCharacters(line));
		builder.reset();
		for (const row of fileRows(0, 3)) {
			expect(drawn.some(line => line.includes(row.trim()))).toBe(true);
		}
		// The rows drawn are the card's, not the numbered rows the model read.
		expect(drawn.some(line => /\d:\s*const value0_/.test(line))).toBe(false);
	});

	it("writes the card text it was loaded with once the result's content is replaced", async () => {
		const { result } = readResult(0, 40);
		const loadedText = result.details?.displayContent?.text;
		const file = await recordReads(root.path(), [result]);
		expect(tags(file)).toBe(1);
		const manager = await SessionManager.open(file);
		const loaded = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (loaded?.type !== "message" || loaded.message.role !== "toolResult") throw new Error("read result missing");
		// What a prune leaves in place of the rows.
		loaded.message.content = [{ type: "text", text: "[Output truncated - 900 tokens]" }];
		await manager.rewriteEntries();

		const written = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(line => line.includes('"toolResult"'))
			.map(line => JSON.parse(line) as { message: ToolResultMessage<ReadToolDetails> });
		expect(written.map(entry => entry.message.details?.displayContent)).toEqual([{ text: loadedText, startLine: 1 }]);
	});
});
