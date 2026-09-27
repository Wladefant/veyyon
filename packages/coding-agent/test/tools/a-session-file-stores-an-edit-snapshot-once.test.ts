/**
 * WHY THIS SUITE EXISTS:
 *
 * An edit result held the post-edit file twice: whole in `details.newText`, and again as the
 * pre-edit file in `details.oldText` plus the numbered diff in `details.diff`, which lists every line
 * the edit removed and added. Every session file wrote both. The edit codec drops `newText` from the
 * written line when the diff applied to `oldText` rebuilds it, and restores it on load.
 *
 * CLASS: for every result shape the edit tool produces (a hashline swap, deletion and insertion, a
 * change at the first and last line, a file with no final newline, a two-file hashline edit, a
 * replace-mode edit, a patch-mode update across two hunks and a patch-mode create) the session writes
 * no `newText` the diff rebuilds, loads every result's details as the tool returned them, and an ACP
 * client replaying the loaded result receives the diff blocks the live result produced. A result
 * whose diff does not rebuild `newText` (a CRLF file, whose diff is drawn from the LF text, or a diff
 * missing a changed line) keeps `newText` on disk, and so does a `newText` shorter than the tag that
 * would replace it. A written line whose diff no longer rebuilds loads without `newText` rather than
 * with a wrong one.
 *
 * DOES NOT CATCH: an edit shape no row exercises whose diff stops rebuilding its `newText`. It still
 * round-trips exactly, since the codec writes whole what it cannot rebuild, but may stop saving space
 * unnoticed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { EditTool, type EditToolDetails } from "@veyyon/coding-agent/edit";
import { mapAgentSessionEventToAcpSessionUpdates } from "@veyyon/coding-agent/modes/acp/acp-event-mapper";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
// The composition root every host loads before it opens a session, which registers the result codecs.
import "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { makeToolSession } from "../helpers/tool-session";

const LINES = [
	"export function alpha(value: string): string {",
	"\tconst clean = value.trim();",
	"\treturn clean.toUpperCase();",
	"}",
	"",
	"export const answer = 42;",
	"",
	"export function beta(): number {",
	"\tconst one = 1;",
	"\tconst two = 2;",
	"\treturn one + two;",
	"}",
];
const FIXTURE = `${LINES.join("\n")}\n`;

type EditMode = "hashline" | "replace" | "patch";

/**
 * What the session file holds for one snapshot: `dropped` writes the tag in place of `newText`, `kept`
 * writes `newText` whole, `absent` is a snapshot the tool returned without a `newText` (a delete, or
 * a multi-file result's top level, which holds its snapshots per file).
 */
type Stored = "dropped" | "kept" | "absent";

interface Shape {
	name: string;
	mode: EditMode;
	/** Files seeded before the edit, by name. */
	files: Record<string, string>;
	/** The edit call's arguments, given each seeded file's hashline header. */
	params: (headers: Record<string, string>) => Record<string, unknown>;
	/** Each snapshot the result holds: the details, then each `perFileResults` entry. */
	stored: Stored[];
}

const SWAP_LINE_TWO = "\tconst clean = value.trim();";

const SHAPES: Shape[] = [
	{
		name: "hashline swap",
		mode: "hashline",
		files: { "a.ts": FIXTURE },
		params: h => ({ input: [h["a.ts"], "SWAP 2.=2:", "+\tconst clean = value.trim().normalize();"].join("\n") }),
		stored: ["dropped"],
	},
	{
		name: "hashline deletion of the first line",
		mode: "hashline",
		files: { "a.ts": FIXTURE },
		params: h => ({ input: [h["a.ts"], "DEL 1"].join("\n") }),
		stored: ["dropped"],
	},
	{
		name: "hashline insertion after the last line",
		mode: "hashline",
		files: { "a.ts": FIXTURE },
		params: h => ({ input: [h["a.ts"], "INS.POST 12:", "+", "+export const gamma = 'gamma';"].join("\n") }),
		stored: ["dropped"],
	},
	{
		name: "hashline swap of the last line of a file with no final newline",
		mode: "hashline",
		files: { "a.ts": LINES.join("\n") },
		params: h => ({ input: [h["a.ts"], "SWAP 12.=12:", "+} // beta"].join("\n") }),
		stored: ["dropped"],
	},
	{
		name: "hashline edit of two files",
		mode: "hashline",
		files: { "a.ts": FIXTURE, "b.ts": FIXTURE },
		params: h => ({
			input: [h["a.ts"], "SWAP 6.=6:", "+export const answer = 43;", h["b.ts"], "DEL 9.=10"].join("\n"),
		}),
		stored: ["absent", "dropped", "dropped"],
	},
	{
		name: "replace-mode edit",
		mode: "replace",
		files: { "a.ts": FIXTURE },
		params: () => ({ path: "a.ts", edits: [{ old_text: "const two = 2;", new_text: "const two = 2 as const;" }] }),
		stored: ["dropped"],
	},
	{
		name: "patch-mode update across two hunks",
		mode: "patch",
		files: { "a.ts": FIXTURE },
		params: () => ({
			path: "a.ts",
			edits: [
				{
					op: "update",
					diff: [
						"@@",
						" export function alpha(value: string): string {",
						`-${SWAP_LINE_TWO}`,
						"+\tconst clean = value.trimStart();",
						"@@",
						" export function beta(): number {",
						"-\tconst one = 1;",
						"+\tconst one = 1 as const;",
					].join("\n"),
				},
			],
		}),
		stored: ["dropped"],
	},
	{
		name: "patch-mode create",
		mode: "patch",
		files: {},
		params: () => ({ path: "fresh.ts", edits: [{ op: "create", diff: FIXTURE }] }),
		stored: ["dropped"],
	},
	{
		name: "patch-mode delete",
		mode: "patch",
		files: { "a.ts": FIXTURE },
		params: () => ({ path: "a.ts", edits: [{ op: "delete" }] }),
		stored: ["absent"],
	},
	{
		// The result holds the first entry's `oldText`, the last entry's `newText` and both entries'
		// diffs joined; the second diff is numbered against the file the first entry wrote.
		name: "patch-mode edit of one line in two entries",
		mode: "patch",
		files: { "a.ts": FIXTURE },
		params: () => ({
			path: "a.ts",
			edits: [
				{ op: "update", diff: ["@@", `-${SWAP_LINE_TWO}`, "+\tconst clean = value.trimEnd();"].join("\n") },
				{
					op: "update",
					diff: ["@@", "-\tconst clean = value.trimEnd();", "+\tconst clean = value.trimStart();"].join("\n"),
				},
			],
		}),
		stored: ["kept"],
	},
	{
		name: "replace-mode edit of a CRLF file",
		mode: "replace",
		files: { "a.ts": FIXTURE.replaceAll("\n", "\r\n") },
		params: () => ({ path: "a.ts", edits: [{ old_text: "const two = 2;", new_text: "const two = 2 as const;" }] }),
		stored: ["kept"],
	},
	{
		name: "hashline edit of a file shorter than the tag",
		mode: "hashline",
		files: { "a.ts": "x = 1\n" },
		params: h => ({ input: [h["a.ts"], "SWAP 1.=1:", "+x = 2"].join("\n") }),
		stored: ["kept"],
	},
];

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "edit", arguments: {} })),
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

/** The details and each per-file entry, in that order: every place an edit result holds a snapshot. */
function snapshots(details: EditToolDetails): Array<Record<string, unknown>> {
	return [details, ...(details.perFileResults ?? [])] as unknown as Array<Record<string, unknown>>;
}

/** The details of every edit result the session file holds, keyed by tool call id, as JSON parsed them. */
function writtenDetails(file: string): Map<string, EditToolDetails> {
	const out = new Map<string, EditToolDetails>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolResult"')) continue;
		const entry = JSON.parse(line) as { message: ToolResultMessage<EditToolDetails> };
		if (entry.message.details) out.set(entry.message.toolCallId, entry.message.details);
	}
	return out;
}

function loadedDetails(manager: SessionManager): Map<string, EditToolDetails> {
	const out = new Map<string, EditToolDetails>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.details) {
			out.set(entry.message.toolCallId, entry.message.details as EditToolDetails);
		}
	}
	return out;
}

/** The diff blocks an ACP client receives for an edit result with `details`. */
function acpDiffs(details: EditToolDetails): unknown[] {
	const [notification] = mapAgentSessionEventToAcpSessionUpdates(
		{
			type: "tool_execution_end",
			toolCallId: "acp",
			toolName: "edit",
			isError: false,
			result: { content: [{ type: "text", text: "edited" }], details },
		},
		"session",
	);
	const update = notification?.update as { content?: Array<{ type: string }> } | undefined;
	return (update?.content ?? []).filter(block => block.type === "diff");
}

describe("a session file stores an edit snapshot once", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-edit-snapshot-once-");
		setAgentDir(root.join("agent"));
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	function toolSession(cwd: string, mode: EditMode) {
		return makeToolSession({
			cwd,
			hasUI: false,
			hasEditTool: true,
			enableLsp: false,
			getSessionFile: () => null,
			getArtifactsDir: () => null,
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
				"edit.mode": mode,
			}),
		});
	}

	/** Run `shape`'s edit in its own directory through the real tools and return the result it recorded. */
	async function editShape(shape: Shape, id: string): Promise<ToolResultMessage<EditToolDetails>> {
		const cwd = root.join(id);
		fs.mkdirSync(cwd, { recursive: true });
		const headers: Record<string, string> = {};
		for (const [name, text] of Object.entries(shape.files)) {
			fs.writeFileSync(`${cwd}/${name}`, text);
			if (shape.mode !== "hashline") continue;
			const read = await new ReadTool(toolSession(cwd, "hashline")).execute(`${id}-read-${name}`, { path: name });
			const first = read.content.find(block => block.type === "text");
			const header = first?.type === "text" ? first.text.split("\n", 1)[0] : undefined;
			if (header === undefined || !/^\[.+#[0-9A-F]{4}\]$/.test(header)) {
				throw new Error(`${shape.name}: read returned no hashline header`);
			}
			headers[name] = header;
		}
		const result = await new EditTool(toolSession(cwd, shape.mode)).execute(id, shape.params(headers) as never);
		const details = result.details as EditToolDetails | undefined;
		if (details === undefined) throw new Error(`${shape.name}: the edit reported no details`);
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "edit",
			content: result.content,
			details,
			isError: false,
			timestamp: 2,
		};
	}

	async function record(results: readonly ToolResultMessage<EditToolDetails>[]): Promise<SessionManager> {
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		await manager.flush();
		return manager;
	}

	it("writes no newText a diff rebuilds, and loads every result as the tool returned it", async () => {
		const results: ToolResultMessage<EditToolDetails>[] = [];
		for (const [index, shape] of SHAPES.entries()) results.push(await editShape(shape, `call-${index}`));
		const manager = await record(results);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);
		const loaded = loadedDetails(await SessionManager.open(file));

		for (const [index, shape] of SHAPES.entries()) {
			const result = results[index];
			const tool = snapshots(result.details as EditToolDetails);
			const onDisk = snapshots(written.get(result.toolCallId) as EditToolDetails);
			const onDiskFor: Record<Stored, { newText: boolean; from: unknown }> = {
				dropped: { newText: false, from: "diff" },
				kept: { newText: true, from: undefined },
				absent: { newText: false, from: undefined },
			};
			// What the tool returned first: a `kept` or `absent` row is only a claim about the codec when
			// the tool did or did not hand it a newText.
			expect({ shape: shape.name, withNewText: tool.map(s => typeof s.newText === "string") }).toEqual({
				shape: shape.name,
				withNewText: shape.stored.map(stored => stored !== "absent"),
			});
			expect({
				shape: shape.name,
				onDisk: onDisk.map(s => ({ newText: typeof s.newText === "string", from: s.newTextFrom })),
			}).toEqual({ shape: shape.name, onDisk: shape.stored.map(stored => onDiskFor[stored]) });
			const expected = JSON.parse(JSON.stringify(result.details));
			expect({ shape: shape.name, details: loaded.get(result.toolCallId) }).toEqual({
				shape: shape.name,
				details: expected,
			});
			expect({ shape: shape.name, acp: acpDiffs(loaded.get(result.toolCallId) as EditToolDetails) }).toEqual({
				shape: shape.name,
				acp: acpDiffs(result.details as EditToolDetails),
			});
		}
	});

	it("keeps newText whole when the diff misses a changed line", async () => {
		const edited = await editShape(SHAPES[0], "call-tampered");
		const details = edited.details as EditToolDetails;
		const rows = details.diff.split("\n");
		const tampered: ToolResultMessage<EditToolDetails> = {
			...edited,
			details: { ...details, diff: rows.filter(row => !row.startsWith("+")).join("\n") },
		};
		const manager = await record([tampered]);
		const onDisk = writtenDetails(manager.getSessionFile() as string).get("call-tampered");
		expect({
			newText: onDisk?.newText,
			from: (onDisk as { newTextFrom?: unknown } | undefined)?.newTextFrom,
		}).toEqual({
			newText: details.newText,
			from: undefined,
		});
	});

	/** Written lines whose diff does not fit their `oldText`, which only a hand-edited file holds. */
	const UNFITTING = [
		{
			name: "a removed row whose text is not the old line",
			oldText: "first line of another file\nsecond line\n",
			diff: "-1|first line of this file\n+1|a replacement line long enough to drop",
		},
		{ name: "an added row past the end", oldText: "only line\n", diff: "+5|a line placed past the end of the file" },
		{
			name: "two added rows claiming one number",
			oldText: "kept line\n",
			diff: "+1|the first claimant of line one\n+1|the second claimant of line one",
		},
	];

	it("loads a line whose diff does not fit its oldText without a newText rather than a wrong one", async () => {
		const lines: ToolResultMessage<EditToolDetails>[] = UNFITTING.map((row, index) => ({
			role: "toolResult",
			toolCallId: `call-unfitting-${index}`,
			toolName: "edit",
			content: [{ type: "text", text: "edited" }],
			details: { path: "a.ts", diff: row.diff, oldText: row.oldText, newTextFrom: "diff" } as EditToolDetails,
			isError: false,
			timestamp: 2,
		}));
		const manager = await record(lines);
		const loaded = loadedDetails(await SessionManager.open(manager.getSessionFile() as string));
		expect(
			UNFITTING.map((row, index) => {
				const details = loaded.get(`call-unfitting-${index}`) as { newText?: unknown; newTextFrom?: unknown };
				return { row: row.name, newText: details.newText, from: details.newTextFrom };
			}),
		).toEqual(UNFITTING.map(row => ({ row: row.name, newText: undefined, from: "diff" })));
	});
});
