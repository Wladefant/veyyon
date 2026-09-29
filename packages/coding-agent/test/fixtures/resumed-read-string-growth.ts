/**
 * A session of read results, and the string bytes that opening it leaves live, measured in the process
 * that runs this file. The test imports the builders. Run as a script, it records 24 reads of 2000
 * rows under argv[2], opens the session, rebuilds its transcript with read previews off, runs the step
 * argv[3] names, and prints, as JSON: the bytes of the read bodies, the string bytes the open and the
 * step left live, the entries loaded, and how many card tags the file holds before and after.
 *
 * Steps: `open` runs nothing after the rebuild; `rewrite` rewrites every entry after the first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { BUILTIN_RESULT_CODECS } from "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import type { TUI } from "@veyyon/tui";
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

/** What a card tag looks like in a written line. */
export const ROWS_TAG = /"from":"rows"/g;

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

/** Settings, theme and result codecs as a host sets them up before it opens a session. */
export async function setUpReadSessions(): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	registerToolResultCodecs(BUILTIN_RESULT_CODECS);
}

/** The rows a read returned: distinct per read, so the loader's string pool shares none of them. */
export function fileRows(read: number, rows: number): string[] {
	return Array.from(
		{ length: rows },
		(_, row) => `\tconst value${read}_${row} = compute(${row}, "${"x".repeat(32)}");`,
	);
}

/** A read result as the read tool returns it: numbered rows under a snapshot header, and its card text. */
export function readResult(read: number, rows: number): { result: ToolResultMessage<ReadToolDetails>; body: string } {
	const lines = fileRows(read, rows);
	const body = `[src/file-${read}.ts#1A2B]\n${lines.map((line, i) => `${i + 1}:${line}`).join("\n")}`;
	return {
		body,
		result: {
			role: "toolResult",
			toolCallId: `read-${read}`,
			toolName: "read",
			content: [{ type: "text", text: body }],
			details: { displayContent: { text: lines.join("\n"), startLine: 1 } },
			isError: false,
			timestamp: 2,
		},
	};
}

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id, read) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: `src/file-${read}.ts` },
		})),
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** A session file under `dir` of one assistant turn calling every read and the results after it. */
export async function recordReads(
	dir: string,
	results: readonly ToolResultMessage<ReadToolDetails>[],
): Promise<string> {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
	for (const result of results) manager.appendMessage(result);
	await manager.flush();
	return manager.getSessionFile() as string;
}

export function rebuiltBuilder(manager: SessionManager, preview: boolean): ChatTranscriptBuilder {
	const builder = new ChatTranscriptBuilder({
		ui,
		cwd: manager.getCwd(),
		requestRender: () => {},
		getSettings: () => Settings.isolated({ "read.toolResultPreview": preview }),
	});
	builder.rebuild(manager.buildSessionContext({ transcript: true }));
	return builder;
}

export type Step = "open" | "rewrite";

/** What a resumed session does after its transcript rebuilds. */
export const STEPS: Readonly<Record<Step, (manager: SessionManager) => Promise<void>>> = {
	open: async () => {},
	rewrite: manager => manager.rewriteEntries([manager.getEntries()[0]!]),
};

export interface Growth {
	reads: number;
	bodyBytes: number;
	grown: number;
	entries: number;
	tagsWritten: number;
	tagsAfter: number;
}

function tags(file: string): number {
	return fs.readFileSync(file, "utf8").match(ROWS_TAG)?.length ?? 0;
}

async function measure(dir: string, step: Step): Promise<Growth> {
	await setUpReadSessions();
	const run = STEPS[step];
	const reads = Array.from({ length: 24 }, (_, read) => readResult(read, 2000));
	const bodyBytes = reads.reduce((sum, read) => sum + read.body.length, 0);
	const file = await recordReads(
		dir,
		reads.map(read => read.result),
	);
	const tagsWritten = tags(file);
	// A throwaway pass over a one-read session loads every module and cache the measured pass reaches,
	// without leaving the measured session's own text behind.
	const warmed = await SessionManager.open(await recordReads(dir, [readResult(99, 3).result]));
	rebuiltBuilder(warmed, false).reset();
	await run(warmed);

	const before = await liveStringBytes();
	const manager = await SessionManager.open(file);
	const builder = rebuiltBuilder(manager, false);
	await run(manager);
	const grown = (await liveStringBytes()) - before;
	const entries = manager.getEntries().length;
	builder.reset();
	return { reads: reads.length, bodyBytes, grown, entries, tagsWritten, tagsAfter: tags(file) };
}

if (import.meta.main) {
	try {
		const [dir, step] = process.argv.slice(2);
		if (!dir || !(step !== undefined && step in STEPS)) {
			throw new Error(`usage: resumed-read-string-growth.ts <dir> <${Object.keys(STEPS).join("|")}>`);
		}
		process.stdout.write(`${JSON.stringify(await measure(dir, step as Step))}\n`);
	} finally {
		await postmortem.cleanup();
	}
}
