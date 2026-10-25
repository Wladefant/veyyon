/**
 * A session file whose last line was cut off by a write that never finished keeps every entry
 * written after it is resumed.
 *
 * WHY: a process that dies mid-append (killed, out of memory, out of disk, power lost) leaves the
 * file ending inside a line. A resume loaded around the cut, and the next append started on that
 * same physical line: the new record and the cut bytes became one line no parser reads, so the
 * next load dropped the prompt the resumed session was asked while the answer to it survived.
 *
 * The class is an append that does not start on a line boundary. The suite sweeps every shape a
 * cut tail takes (inside a record, a whole record that lost only its line feed, inside a
 * multi-byte character, a tail of blanks), on each storage the manager writes through that can
 * hold a cut (the filesystem and memory), and on both ways a resume reads a file (whole below
 * `STREAM_LOAD_THRESHOLD_BYTES`, streamed above it). It pins that the resumed file holds every
 * message before the cut, the record the cut left whole, and every message after the resume, on
 * lines that all parse. A control pins that an intact file is appended to rather than republished,
 * so the repair costs nothing when there is nothing to repair.
 *
 * NOT CAUGHT: a cut inside the session header leaves no session to resume and fails the load,
 * which this suite does not cover. The Redis and SQL storages append to a stored value rather than
 * a file and are not swept. The boundary is checked when a file is loaded, so a second process
 * whose own append is cut while this one holds the file open is not covered. The streamed arm
 * reads the file through the skim; the line-by-line fallback shares the load entry point the
 * check sits in but is not driven here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadSessionFile, STREAM_LOAD_THRESHOLD_BYTES } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage, MemorySessionStorage, type SessionStorage } from "@veyyon/kernel/session/session-storage";

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

/** The id of the record a cut reaches, which survives only when the cut left it whole. */
const TORN_ID = "torn0001";

/** A user message record the way the manager writes one, holding multi-byte text. */
function tornRecord(parentId: string): Buffer {
	return Buffer.from(
		JSON.stringify({
			type: "message",
			id: TORN_ID,
			parentId,
			timestamp: "2026-10-18T12:00:00.000Z",
			message: { role: "user", content: "the prompt the crash cut 日本語 off", timestamp: 5 },
		}),
		"utf-8",
	);
}

interface Tear {
	name: string;
	/** The bytes the cut left of `record`, which the file ends with and no line feed follows. */
	tail(record: Buffer): Buffer;
	/** Whether those bytes are the whole record. */
	keepsRecord: boolean;
}

const TEARS: Tear[] = [
	{ name: "a record cut in the middle", tail: record => record.subarray(0, record.length >> 1), keepsRecord: false },
	{ name: "a whole record that lost only its line feed", tail: record => record, keepsRecord: true },
	{
		name: "a record cut inside a multi-byte character",
		tail: record => record.subarray(0, record.indexOf(Buffer.from("日", "utf-8")) + 1),
		keepsRecord: false,
	},
	{ name: "a tail of blanks", tail: () => Buffer.from("   ", "utf-8"), keepsRecord: false },
];

interface StorageArm {
	name: string;
	storage: SessionStorage;
	read(file: string): Buffer;
	write(file: string, bytes: Buffer): void;
}

function onDisk(): StorageArm {
	return {
		name: "the filesystem",
		storage: new FileSessionStorage(),
		read: file => fs.readFileSync(file),
		write: (file, bytes) => fs.writeFileSync(file, bytes),
	};
}

function inMemory(): StorageArm {
	const storage = new MemorySessionStorage();
	return {
		name: "memory",
		storage,
		read: file => Buffer.from(storage.readTextSync(file) ?? "", "utf-8"),
		write: (file, bytes) => storage.writeTextSync(file, bytes.toString("utf-8")),
	};
}

interface Arm {
	name: string;
	makeStorage(): StorageArm;
	/** Bytes of history ahead of the messages under test, enough to stream the load. */
	padding: number;
}

const ARMS: Arm[] = [
	{ name: "the filesystem, read whole", makeStorage: onDisk, padding: 0 },
	{ name: "the filesystem, streamed", makeStorage: onDisk, padding: STREAM_LOAD_THRESHOLD_BYTES },
	{ name: "memory, read whole", makeStorage: inMemory, padding: 0 },
];

/** Under the size persistence moves to the blob store, so padding stays in the file. */
const PADDING_CHARS = 450_000;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Written {
	root: string;
	dir: string;
	file: string;
	/** Ids of the message entries written, in order. */
	messageIds: string[];
}

async function writeSession(arm: StorageArm, padding: number): Promise<Written> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "torn-session-"));
	tempDirs.push(root);
	const dir = path.join(root, "sessions");
	const manager = SessionManager.create(root, dir, arm.storage);
	const messageIds: string[] = [];
	for (let i = 0; i * PADDING_CHARS < padding; i++) {
		messageIds.push(manager.appendMessage({ role: "user", content: "p".repeat(PADDING_CHARS), timestamp: i }));
	}
	messageIds.push(manager.appendMessage({ role: "user", content: "the first prompt", timestamp: 1 }));
	messageIds.push(manager.appendMessage(assistantTurn("the first answer", 2)));
	await manager.flush();
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("the session wrote no file");
	await manager.close();
	return { root, dir, file, messageIds };
}

/** Resume `file`, run one more turn, and return the ids of the messages it wrote. */
async function resumeAndTalk(arm: StorageArm, written: Written): Promise<string[]> {
	const resumed = await SessionManager.open(written.file, written.dir, arm.storage, { suppressBreadcrumb: true });
	const ids = [
		resumed.appendMessage({ role: "user", content: "the prompt after the resume", timestamp: 10 }),
		resumed.appendMessage(assistantTurn("the answer after the resume", 11)),
	];
	await resumed.flush();
	await resumed.close();
	return ids;
}

function messageIdsOf(entries: readonly FileEntry[]): string[] {
	return entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
}

/** Each non-blank line of `bytes` that is not one JSON value. */
function unreadableLines(bytes: Buffer): string[] {
	return bytes
		.toString("utf-8")
		.split("\n")
		.filter(line => {
			if (line.trim() === "") return false;
			try {
				JSON.parse(line);
				return false;
			} catch {
				return true;
			}
		})
		.map(line => line.slice(0, 120));
}

function expectStreamedWhenPadded(arm: Arm, bytes: Buffer): void {
	expect([arm.name, bytes.length >= STREAM_LOAD_THRESHOLD_BYTES]).toEqual([arm.name, arm.padding > 0]);
}

describe("a session resumed after a write that was cut off", () => {
	it.each(ARMS.flatMap(arm => TEARS.map(tear => ({ arm, tear, label: `${tear.name}, on ${arm.name}` }))))(
		"keeps every later entry: $label",
		async ({ arm, tear }) => {
			const storage = arm.makeStorage();
			const written = await writeSession(storage, arm.padding);
			const intact = storage.read(written.file);
			expect(intact.at(-1)).toBe(0x0a);
			const torn = Buffer.concat([intact, tear.tail(tornRecord(written.messageIds.at(-1) ?? ""))]);
			storage.write(written.file, torn);
			expectStreamedWhenPadded(arm, torn);

			const after = await resumeAndTalk(storage, written);

			const bytes = storage.read(written.file);
			expect(unreadableLines(bytes)).toEqual([]);
			const reloaded = await loadSessionFile(written.file, storage.storage);
			expect(messageIdsOf(reloaded.entries)).toEqual([
				...written.messageIds,
				...(tear.keepsRecord ? [TORN_ID] : []),
				...after,
			]);
		},
	);

	it.each(ARMS.filter(arm => arm.makeStorage === onDisk))(
		"appends to an intact file instead of republishing it, on $name",
		async arm => {
			const storage = arm.makeStorage();
			const written = await writeSession(storage, arm.padding);
			const before = fs.statSync(written.file);
			expectStreamedWhenPadded(arm, storage.read(written.file));

			const after = await resumeAndTalk(storage, written);

			expect(fs.statSync(written.file).ino).toBe(before.ino);
			const reloaded = await loadSessionFile(written.file, storage.storage);
			expect(messageIdsOf(reloaded.entries)).toEqual([...written.messageIds, ...after]);
		},
	);
});
