/**
 * A session holds the payloads of entries its live context cannot reach on disk, and reads each
 * back from the session file on first use (`ColdEntryPayloads`). That is the history before the
 * newest compaction boundary, other branches, and the record-only kinds (`RECORD_ONLY_ENTRY_TYPES`)
 * wherever they sit: a spawned agent's `session_init` holds its whole joined system prompt for as
 * long as the agent stays live.
 *
 * WHY: a resumed 402 MiB session held 501 MiB of heap, 438 MiB of it in entries before the newest
 * compaction boundary. Moving those payloads out of memory opens a class of defects: a cold entry
 * that reads back different from what a load produces (an externalized payload or a codec-dropped
 * field left unrestored), an in-place update lost across a republish, a byte offset read against a
 * file object that no longer holds the line, a read handle that outlives every entry needing it,
 * and a live-context build that reads the disk.
 *
 * The suite closes that class by sweeping every member of the `SessionEntry` union (the fixture
 * table is typed against the union, so a new entry kind fails the type check until it has a row),
 * every externalization site persistence writes (image block, image data URL, oversized text, tool
 * result codec), and every event that changes the file under a cold entry (this manager's tail
 * republish, another writer's republish, the manager being dropped).
 *
 * The record-only sweep places every entry kind on the live branch and pins, by exact equality,
 * which kinds read the disk there, so a new kind fails until it is classified.
 *
 * NOT CAUGHT: the heap bound is measured in this process with a 4x margin, so a regression that
 * keeps a quarter of the cold payloads resident passes. Windows holds no pinned reader, so there
 * every entry stays in memory and the fd assertions are skipped.
 */

import { heapStats } from "bun:jsc";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { BlobStore, blobsDirForSessionDir } from "@veyyon/kernel/session/blob-store";
import type { SessionEntry, SessionEntryBase } from "@veyyon/kernel/session/session-entries";
import { loadSessionFile, resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage, type PinnedSessionReader } from "@veyyon/kernel/session/session-storage";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";

const PROBE_TOOL = "cold_readback_probe";

/** Drops `details.echo` when it repeats the result's first text block, and rebuilds it on load. */
registerToolResultCodecs([
	{
		toolName: PROBE_TOOL,
		slim(details: unknown, content: ToolResultMessage["content"]): unknown {
			const first = content[0];
			if (typeof details !== "object" || details === null || first?.type !== "text") return details;
			const { echo, ...rest } = details as Record<string, unknown>;
			return echo === first.text ? rest : details;
		},
		restore(details: unknown, content: ToolResultMessage["content"]): void {
			const first = content[0];
			if (typeof details !== "object" || details === null || first?.type !== "text") return;
			const record = details as Record<string, unknown>;
			if (!("echo" in record)) record.echo = first.text;
		},
	},
]);

/** Pinned readers a manager opened on the session file, and every read through them. */
class ObservedStorage extends FileSessionStorage {
	readonly open = new Set<PinnedSessionReader>();
	reads = 0;

	openPinnedReaderSync(filePath: string): PinnedSessionReader | undefined {
		const inner = super.openPinnedReaderSync(filePath);
		if (inner === undefined) return undefined;
		const open = this.open;
		const reader: PinnedSessionReader = {
			identity: inner.identity,
			read: (offset, length) => {
				this.reads += 1;
				return inner.read(offset, length);
			},
			close: () => {
				open.delete(reader);
				inner.close();
			},
		};
		open.add(reader);
		return reader;
	}

	openIdentities(): string[] {
		return [...this.open].map(reader => reader.identity);
	}
}

const pins = process.platform !== "win32";

function big(tag: string, length = 1500): string {
	let text = `${tag}:`;
	for (let i = 0; text.length < length; i++) text += ` ${tag}-${i}`;
	return text;
}

/** A PNG-shaped base64 payload above the externalization threshold, distinct per `seed`. */
function base64(seed: string, bytes = 3072): string {
	const buffer = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i++) buffer[i] = (i * 31 + seed.charCodeAt(i % seed.length)) & 0xff;
	return buffer.toString("base64");
}

function assistantTurn(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

type EntryOf<K extends SessionEntry["type"]> = Extract<SessionEntry, { type: K }>;
type Fixture = { [K in SessionEntry["type"]]: (base: SessionEntryBase) => EntryOf<K> };

/**
 * One entry of every kind the union declares, each with payloads large enough to be moved out of
 * memory where its shape allows one. Typed against the union: a new entry kind is a missing key.
 */
const EVERY_ENTRY_KIND = {
	message: base => ({
		...base,
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-probe",
			toolName: PROBE_TOOL,
			content: [
				{ type: "text", text: big("probe-result") },
				{ type: "image", data: base64("result-image"), mimeType: "image/png" },
			],
			details: { echo: big("probe-result"), summary: big("probe-summary") },
			isError: false,
			timestamp: 3,
		},
	}),
	thinking_level_change: base => ({
		...base,
		type: "thinking_level_change",
		thinkingLevel: "high",
		configured: "auto",
	}),
	model_change: base => ({ ...base, type: "model_change", model: "anthropic/claude-sonnet-4-5", role: "default" }),
	service_tier_change: base => ({ ...base, type: "service_tier_change", serviceTier: null }),
	compaction: base => ({
		...base,
		type: "compaction",
		summary: big("older-compaction"),
		firstKeptEntryId: base.parentId ?? base.id,
		tokensBefore: 10,
		details: { files: [big("older-compaction-file")] },
	}),
	branch_summary: base => ({
		...base,
		type: "branch_summary",
		fromId: base.parentId ?? base.id,
		summary: big("branch-summary"),
		details: { note: big("branch-details") },
	}),
	custom: base => ({
		...base,
		type: "custom",
		customType: "probe",
		data: { note: big("custom-note"), image_url: `data:image/png;base64,${base64("custom-url")}` },
	}),
	custom_message: base => ({
		...base,
		type: "custom_message",
		customType: "probe",
		content: big("custom-message"),
		details: { note: big("custom-message-details") },
		display: true,
	}),
	label: base => ({ ...base, type: "label", targetId: base.parentId ?? base.id, label: "pinned" }),
	title_change: base => ({ ...base, type: "title_change", title: "cold read-back", source: "user" }),
	ttsr_injection: base => ({
		...base,
		type: "ttsr_injection",
		injectedRules: [big("rule-a", 600), big("rule-b", 600)],
	}),
	mcp_tool_selection: base => ({
		...base,
		type: "mcp_tool_selection",
		selectedToolNames: [big("tool-a", 600), big("tool-b", 600)],
	}),
	session_init: base => ({
		...base,
		type: "session_init",
		systemPrompt: big("system-prompt"),
		task: big("task"),
		tools: ["read"],
	}),
	mode_change: base => ({ ...base, type: "mode_change", mode: "plan", data: { planFile: big("plan-file") } }),
	subagent_spawn: base => ({
		...base,
		type: "subagent_spawn",
		agentId: "agent-1",
		agentName: "task",
		task: big("spawn-task"),
		sessionFile: "/repo/.sessions/agent-1.jsonl",
		isolation: "none",
		status: "completed",
		exitCode: 0,
		durationMs: 10,
	}),
	settings_snapshot: base => ({
		...base,
		type: "settings_snapshot",
		kind: "full",
		values: { "probe.value": big("setting") },
	}),
	session_lifecycle: base => ({ ...base, type: "session_lifecycle", state: "running", reason: "created" }),
	session_checkpoint: base => ({ ...base, type: "session_checkpoint", prefixSequence: 0 }),
} satisfies Fixture;

/** The text persistence externalizes: one line past its 500,000-character cap. */
const OVERSIZED_TEXT = big("oversized", 520_000);

interface SessionFixture {
	dir: string;
	file: string;
	/** The earliest entry the live context reads. */
	keptId: string;
	/** Summary of the newest compaction, which every context build sends. */
	summary: string;
	/** Ids of entries before the keep boundary, in file order. */
	compacted: string[];
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write `history` then a kept tail and a compaction over it, and publish the file through a
 * manager, so persistence writes it the way a live session does: title slot, externalized blobs,
 * codec-slimmed details.
 */
async function writeSession(history: SessionEntry[]): Promise<SessionFixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-readback-"));
	tempDirs.push(root);
	const dir = path.join(root, "sessions");
	fs.mkdirSync(dir);
	fs.mkdirSync(path.join(root, "blobs"));
	const file = path.join(dir, "session.jsonl");

	let counter = 0;
	const base = (parentId: string | null): SessionEntryBase => ({
		type: "",
		id: `e${String(++counter).padStart(5, "0")}`,
		parentId,
		timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, counter)).toISOString(),
	});
	const lines: SessionEntry[] = [];
	const push = (entry: SessionEntry): string => {
		lines.push(entry);
		return entry.id;
	};

	let parent: string | null = null;
	for (const entry of history) {
		// History entries name their own parents; the chain continues from the last one.
		lines.push(entry);
		parent = entry.id;
	}
	const compacted = lines.map(entry => entry.id);
	const keptId = push({
		...base(parent),
		type: "message",
		message: { role: "user", content: "kept prompt", timestamp: 10 },
	});
	parent = push({ ...base(keptId), type: "message", message: assistantTurn("kept answer", 11) });
	const summary = big("newest-compaction");
	parent = push({ ...base(parent), type: "compaction", summary, firstKeptEntryId: keptId, tokensBefore: 100 });
	parent = push({
		...base(parent),
		type: "message",
		message: { role: "user", content: "after compaction", timestamp: 12 },
	});
	push({ ...base(parent), type: "message", message: assistantTurn("tail answer", 13) });

	const header = {
		type: "session",
		version: 3,
		id: "cold-readback",
		timestamp: "2025-01-01T00:00:00.000Z",
		cwd: root,
	};
	fs.writeFileSync(file, `${[header, ...lines].map(line => JSON.stringify(line)).join("\n")}\n`);

	const seed = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
	await seed.rewriteEntries();
	await seed.close();
	return { dir, file, keptId, summary, compacted };
}

/** Every entry of the file as a fresh load restores it, keyed by id. */
async function freshLoad(fixture: Pick<SessionFixture, "dir" | "file">): Promise<Map<string, string>> {
	const loaded = await loadSessionFile(fixture.file);
	await resolveBlobRefsInEntries(loaded.entries, new BlobStore(blobsDirForSessionDir(fixture.dir)));
	const byId = new Map<string, string>();
	for (const entry of loaded.entries) {
		if (entry.type !== "session") byId.set(entry.id, JSON.stringify(entry));
	}
	return byId;
}

function serialized(manager: SessionManager): Map<string, string> {
	return new Map(manager.getEntries().map(entry => [entry.id, JSON.stringify(entry)]));
}

/** One chain holding every entry kind, a side branch off its first entry, and the oversized text. */
function everyKindHistory(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	let n = 0;
	const next = (parentId: string | null): SessionEntryBase => ({
		type: "",
		id: `h${String(++n).padStart(5, "0")}`,
		parentId,
		timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, n)).toISOString(),
	});
	const first = next(null);
	entries.push({ ...first, type: "message", message: { role: "user", content: big("first-prompt"), timestamp: 1 } });
	parent = first.id;
	for (const make of Object.values(EVERY_ENTRY_KIND) as ((base: SessionEntryBase) => SessionEntry)[]) {
		const entry = make(next(parent));
		entries.push(entry);
		parent = entry.id;
	}
	// A branch the active path does not walk.
	entries.push({
		...next(first.id),
		type: "message",
		message: { role: "user", content: big("side-branch"), timestamp: 2 },
	});
	const oversized = next(parent);
	entries.push({ ...oversized, type: "message", message: { role: "user", content: OVERSIZED_TEXT, timestamp: 4 } });
	return entries;
}

describe.skipIf(!pins)("compacted history reads back from the session file", () => {
	it("reads back every entry kind as a fresh load of the file, and never reads the disk for the live context", async () => {
		const fixture = await writeSession(everyKindHistory());

		// Persistence moved every payload kind out of the line, so each restore path is exercised.
		const text = fs.readFileSync(fixture.file, "utf8");
		expect(text).not.toContain(OVERSIZED_TEXT.slice(0, 4096));
		expect(text).not.toContain(base64("result-image").slice(0, 512));
		expect(text).not.toContain(base64("custom-url").slice(0, 512));
		expect(text).not.toContain('"echo"');

		const expected = await freshLoad(fixture);
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });

		expect(storage.openIdentities()).toEqual([storage.statSync(fixture.file).identity!]);
		const context = manager.buildSessionContext();
		const contextText = JSON.stringify(context.messages);
		expect(contextText).toContain(fixture.summary);
		expect(contextText).toContain("kept prompt");
		expect(contextText).toContain("tail answer");
		expect(contextText).not.toContain("first-prompt");
		// Every settings-bearing entry sits in the compacted history and still reaches the context.
		expect(context.thinkingLevel).toBe("high");
		expect(context.configuredThinkingLevel).toBe("auto");
		expect(context.models).toEqual({ default: "anthropic/claude-sonnet-4-5" });
		expect(context.injectedTtsrRules).toEqual([big("rule-a", 600), big("rule-b", 600)]);
		expect(context.selectedMCPToolNames).toEqual([big("tool-a", 600), big("tool-b", 600)]);
		expect(context.hasPersistedMCPToolSelection).toBe(true);
		expect(context.mode).toBe("plan");
		expect(context.modeData).toEqual({ planFile: big("plan-file") });
		expect(storage.reads).toBe(0);

		expect(serialized(manager)).toEqual(expected);
		expect(storage.reads).toBeGreaterThan(0);
		// The last cold entry read back releases the handle.
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("keeps an in-place update of a cold entry across a tail republish, and moves the rest onto the new file", async () => {
		const fixture = await writeSession(everyKindHistory());
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
		const original = storage.statSync(fixture.file).identity!;

		const entries = manager.getEntries();
		const custom = entries.find(entry => entry.type === "custom");
		const summary = entries.find(entry => entry.type === "branch_summary");
		if (custom?.type !== "custom" || summary?.type !== "branch_summary") {
			throw new Error("fixture lost its custom entry or branch summary");
		}
		expect(storage.reads).toBe(0);

		// Two write paths: a nested mutation through the getter, and an assignment through the setter
		// to an entry nothing has read.
		(custom.data as Record<string, unknown>).note = "edited in place";
		summary.summary = "replaced summary";
		await manager.rewriteEntries([custom, summary]);

		const republished = storage.statSync(fixture.file).identity!;
		expect(republished).not.toBe(original);
		// The replaced object is released: every cold entry now reads from the new one.
		expect(storage.openIdentities()).toEqual([republished]);

		const expected = await freshLoad(fixture);
		expect(JSON.parse(expected.get(custom.id)!).data.note).toBe("edited in place");
		expect(JSON.parse(expected.get(summary.id)!).summary).toBe("replaced summary");
		expect(serialized(manager)).toEqual(expected);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves the history a live compaction summarized out of memory once the compaction is recorded", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-live-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const storage = new ObservedStorage();
		const manager = SessionManager.create(root, dir, storage);

		let keptId = "";
		for (let turn = 0; turn < 40; turn++) {
			const id = manager.appendMessage({ role: "user", content: big(`live-prompt-${turn}`, 4096), timestamp: turn });
			if (turn === 35) keptId = id;
			manager.appendMessage(assistantTurn(`live-answer-${turn}`, turn));
		}
		const summary = big("live-summary");
		manager.appendCompaction(summary, undefined, keptId, 1000);
		expect(storage.open.size).toBe(0);

		manager.coolCompactedHistory();
		expect(storage.open.size).toBe(1);
		const context = JSON.stringify(manager.buildSessionContext().messages);
		expect(context).toContain(summary);
		expect(context).toContain("live-prompt-35:");
		expect(context).not.toContain("live-prompt-34:");
		expect(storage.reads).toBe(0);

		await manager.flush();
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("the session wrote no file");
		expect(serialized(manager)).toEqual(await freshLoad({ dir, file }));
		expect(storage.reads).toBe(35);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("reads the bytes it resumed from after another writer republishes the path", async () => {
		const fixture = await writeSession(everyKindHistory());
		const expected = await freshLoad(fixture);
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });

		// Another process replaces the file with one whose bytes sit at different offsets.
		const replacement = `${fixture.file}.other`;
		fs.writeFileSync(replacement, `${"\n".repeat(4096)}${fs.readFileSync(fixture.file, "utf8")}`);
		fs.renameSync(replacement, fixture.file);

		for (const id of fixture.compacted) {
			const entry = manager.getEntry(id);
			expect(entry && JSON.stringify(entry)).toBe(expected.get(id));
		}
		expect(storage.open.size).toBe(0);
	});

	it("releases the pinned descriptor when a manager holding cold entries is dropped", async () => {
		if (process.platform !== "linux") return;
		const fixture = await writeSession(everyKindHistory());
		const target = fs.realpathSync(fixture.file);
		const pinnedDescriptors = (): number =>
			fs.readdirSync("/proc/self/fd").filter(fd => {
				try {
					const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
					return link === target || link === `${target} (deleted)`;
				} catch {
					return false;
				}
			}).length;

		const opened = async (): Promise<number> => {
			const manager = await SessionManager.open(fixture.file, fixture.dir, new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			return manager.getEntries().length;
		};
		expect(await opened()).toBeGreaterThan(fixture.compacted.length);

		let rounds = 0;
		while (pinnedDescriptors() > 0 && rounds < 50) {
			Bun.gc(true);
			await new Promise<void>(resolve => setImmediate(resolve));
			rounds += 1;
		}
		expect(pinnedDescriptors()).toBe(0);
	});

	it("holds a compacted history's payloads out of the heap until they are read", async () => {
		const RESULTS = 160;
		const RESULT_CHARS = 128 * 1024;
		const payloadBytes = RESULTS * RESULT_CHARS;
		const history: SessionEntry[] = [];
		for (let i = 0; i < RESULTS; i++) {
			history.push({
				type: "message",
				id: `r${String(i).padStart(5, "0")}`,
				parentId: i === 0 ? null : `r${String(i - 1).padStart(5, "0")}`,
				timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: `call-${i}`,
					toolName: "bash",
					content: [{ type: "text", text: big(`result-${i}`, RESULT_CHARS) }],
					isError: false,
					timestamp: i,
				},
			});
		}
		const fixture = await writeSession(history);
		history.length = 0;

		const retained = (): number => {
			Bun.gc(true);
			const stats = heapStats();
			return stats.heapSize + stats.extraMemorySize;
		};
		const before = retained();
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(fixture.file, fixture.dir, storage, { suppressBreadcrumb: true });
		const cold = retained() - before;
		// No `model_change` on this branch: the settings walk names the default model from the newest
		// assistant turn, which the live tail holds.
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(fixture.summary);
		expect(storage.reads).toBe(0);

		// Reading the payloads back brings them into the heap, which proves the measurement sees them.
		let results = 0;
		for (const entry of manager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "toolResult") results += 1;
		}
		const warm = retained() - before;
		expect(results).toBe(RESULTS);

		expect(cold).toBeLessThan(payloadBytes / 4);
		expect(warm).toBeGreaterThan(payloadBytes);
		await manager.close();
	});

	it("holds record-only entries on disk on the live branch, and only them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-record-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const file = path.join(dir, "session.jsonl");

		// The compaction keeps itself, so every entry after it is on the live branch.
		let n = 0;
		const next = (parentId: string | null): SessionEntryBase => ({
			type: "",
			id: `l${String(++n).padStart(5, "0")}`,
			parentId,
			timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, n)).toISOString(),
		});
		const kinds = Object.entries(EVERY_ENTRY_KIND) as [string, (base: SessionEntryBase) => SessionEntry][];
		const lines: SessionEntry[] = [EVERY_ENTRY_KIND.compaction(next(null))];
		for (const [kind, make] of kinds) {
			if (kind !== "compaction") lines.push(make(next(lines.at(-1)!.id)));
		}
		lines.push({ ...next(lines.at(-1)!.id), type: "message", message: assistantTurn("live answer", 20) });
		const header = {
			type: "session",
			version: 3,
			id: "cold-record",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: root,
		};
		fs.writeFileSync(file, `${[header, ...lines].map(line => JSON.stringify(line)).join("\n")}\n`);
		const seed = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
		await seed.rewriteEntries();
		await seed.close();

		const expected = await freshLoad({ dir, file });
		const storage = new ObservedStorage();
		const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("live answer");
		expect(storage.reads).toBe(0);

		const readBack: string[] = [];
		for (const entry of manager.getEntries()) {
			const before = storage.reads;
			expect(JSON.stringify(entry)).toBe(expected.get(entry.id)!);
			if (storage.reads > before) readBack.push(entry.type);
		}
		expect(readBack.sort()).toEqual(["session_init", "settings_snapshot", "subagent_spawn"]);
		expect(storage.open.size).toBe(0);
		await manager.close();
	});

	it("moves a new session's session_init out of memory once the session file is written", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cold-init-"));
		tempDirs.push(root);
		const dir = path.join(root, "sessions");
		fs.mkdirSync(dir);
		fs.mkdirSync(path.join(root, "blobs"));
		const storage = new ObservedStorage();
		const manager = SessionManager.create(root, dir, storage);
		const systemPrompt = big("spawned-system-prompt", 64 * 1024);
		manager.appendSessionInit({ systemPrompt, task: big("spawned-task"), tools: ["read", "yield"] });
		manager.appendSettingsSnapshot({ "probe.value": big("setting") });
		manager.appendMessage({ role: "user", content: "spawned prompt", timestamp: 1 });
		manager.appendMessage(assistantTurn("spawned answer", 2));
		await manager.flush();

		expect(storage.open.size).toBe(1);
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("spawned answer");
		expect(storage.reads).toBe(0);
		const init = manager.getEntries().find(entry => entry.type === "session_init");
		if (init?.type !== "session_init") throw new Error("the session recorded no session_init");
		expect(init.systemPrompt).toBe(systemPrompt);
		expect(storage.reads).toBe(1);

		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("the session wrote no file");
		expect(serialized(manager)).toEqual(await freshLoad({ dir, file }));
		expect(storage.open.size).toBe(0);
		await manager.close();
	});
});
