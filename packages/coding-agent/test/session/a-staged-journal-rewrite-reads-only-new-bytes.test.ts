import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionFileBody,
	type WriteTextAtomicOptions,
} from "@veyyon/kernel/session/session-storage";
import { useTempDirs } from "../helpers/temp-dirs";

/**
 * WHY: `#replayTailAppends` in `FileSessionStorage.renameSync` used to call
 * `fs.readFileSync(target, "utf-8")` and `fs.readFileSync(source, "utf-8")` on every staged
 * `.tmp` -> `.jsonl` commit. On large journals that synchronously read both the entire historical
 * journal and the entire staged file on every publish, even when no foreign bytes arrived.
 *
 * These tests pin:
 * - Unchanged `.jsonl` commits (`writeTextAtomic` and `rewriteTailAtomic`) perform zero whole-file
 *   `fs.readFileSync` calls against the journal or staged temp file.
 * - Late foreign appends landing during `renameSync` before `super.renameSync` are preserved once
 *   in order without whole-journal or whole-staged `fs.readFileSync` calls.
 * - Replay skips malformed lines and `session_lifecycle` `session_switched` rows.
 * - Off-target paths (non-`.jsonl` targets and non-`.tmp` sources) bypass staged replay.
 *
 * WHAT THIS DOES NOT COVER: Windows `EPERM` move-aside/rollback (covered in
 * `rewrite-rename-eperm.test.ts`) and multi-megabyte wall-clock latency.
 */

const temp = useTempDirs();

afterEach(() => {
	vi.restoreAllMocks();
});

interface SyncReadCounter {
	journalReads: number;
	stagedReads: number;
	paths: string[];
}

function normalizeFsTarget(target: fs.PathOrFileDescriptor): string | undefined {
	if (typeof target === "string") return path.resolve(target);
	if (Buffer.isBuffer(target)) return path.resolve(target.toString("utf8"));
	if (target instanceof URL) return path.resolve(fileURLToPath(target));
	return undefined;
}

function countSyncWholeFileReads(journalPath: string): SyncReadCounter {
	const resolvedJournal = path.resolve(journalPath);
	const resolvedDir = path.dirname(resolvedJournal);
	const counter: SyncReadCounter = { journalReads: 0, stagedReads: 0, paths: [] };
	const realReadFileSync = fs.readFileSync;
	spyOn(fs, "readFileSync").mockImplementation(((
		target: Parameters<typeof fs.readFileSync>[0],
		...rest: unknown[]
	) => {
		const resolved = normalizeFsTarget(target);
		if (resolved !== undefined) {
			if (resolved === resolvedJournal) {
				counter.journalReads += 1;
				counter.paths.push(resolved);
			} else if (path.dirname(resolved) === resolvedDir && path.basename(resolved).includes(".tmp")) {
				counter.stagedReads += 1;
				counter.paths.push(resolved);
			}
		}
		return (realReadFileSync as (...args: unknown[]) => unknown)(target, ...rest);
	}) as typeof fs.readFileSync);
	return counter;
}

class LateAppendStorage extends FileSessionStorage {
	readonly renameCalls: Array<{ source: string; target: string }> = [];
	readonly #targetJournal: string;
	#pendingLateBytes: string | undefined;

	constructor(targetJournal: string, pendingLateBytes?: string) {
		super();
		this.#targetJournal = path.resolve(targetJournal);
		this.#pendingLateBytes = pendingLateBytes;
	}

	override renameSync(source: string, target: string): void {
		this.renameCalls.push({ source, target });
		if (
			this.#pendingLateBytes !== undefined &&
			path.resolve(target) === this.#targetJournal &&
			path.basename(source).includes(".tmp")
		) {
			const bytes = this.#pendingLateBytes;
			this.#pendingLateBytes = undefined;
			fs.appendFileSync(target, bytes, "utf8");
		}
		super.renameSync(source, target);
	}
}

function sessionRow(id: string, text: string): string {
	return `${JSON.stringify({ type: "message", id, text })}\n`;
}

function foreignMessageRow(id: string, content: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		timestamp: new Date().toISOString(),
		parentId: null,
		message: { role: "user", content, timestamp: 0 },
	})}\n`;
}

async function appendLargeHistory(manager: SessionManager): Promise<void> {
	const payload = "retained session history ".repeat(45);
	for (let i = 0; i < 9_000; i++) {
		manager.appendMessage({ role: "user", content: `${i} ${payload}`, timestamp: i });
	}
	await manager.flush();
}

class LateAppendOnWriteTextAtomicStorage extends FileSessionStorage {
	lateBytes?: string;

	override async writeTextAtomic(
		fpath: string,
		body: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		const bytes = this.lateBytes;
		if (bytes !== undefined) {
			this.lateBytes = undefined;
			await fsp.appendFile(fpath, bytes, "utf8");
		}
		return super.writeTextAtomic(fpath, body, options);
	}
}

describe("staged journal rewrite reads only new bytes", () => {
	it("writeTextAtomic on an unchanged .jsonl journal publishes without reading the journal or staged temp file", async () => {
		const dir = temp("staged-write-clean-");
		const journal = path.join(dir, "session.jsonl");
		const initial =
			`${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n` +
			sessionRow("m1", "historical-one") +
			sessionRow("m2", "historical-two");
		await fsp.writeFile(journal, initial, "utf8");

		const storage = new LateAppendStorage(journal);
		const reads = countSyncWholeFileReads(journal);
		const nextBody =
			`${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n` +
			sessionRow("m1", "historical-one") +
			sessionRow("m2", "rewritten-two");

		await storage.writeTextAtomic(journal, nextBody);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		expect(storage.renameCalls).toHaveLength(1);
		expect(path.basename(storage.renameCalls[0]!.source)).toContain(".tmp");
		expect(await fsp.readFile(journal, "utf8")).toBe(nextBody);
	});

	it("rewriteTailAtomic on an unchanged .jsonl journal preserves historical bytes without reading the journal or staged temp file", async () => {
		const dir = temp("staged-tail-clean-");
		const journal = path.join(dir, "session.jsonl");
		const head1 = `${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n`;
		const keep1 = sessionRow("m1", "kept-historical-one");
		const keep2 = sessionRow("m2", "kept-historical-two");
		const oldTail = sessionRow("m3", "old-tail");
		await fsp.writeFile(journal, head1 + keep1 + keep2 + oldTail, "utf8");

		const storage = new FileSessionStorage();
		const reads = countSyncWholeFileReads(journal);

		// In-place head replacement (same UTF-8 byte length as head1).
		const inPlaceHead = `${JSON.stringify({ type: "session", id: "s2", version: 3 })}\n`;
		expect(Buffer.byteLength(inPlaceHead, "utf8")).toBe(Buffer.byteLength(head1, "utf8"));
		const inPlaceTail = sessionRow("m3", "in-place-tail");
		await storage.rewriteTailAtomic(
			journal,
			Buffer.byteLength(head1, "utf8"),
			Buffer.byteLength(head1 + keep1 + keep2, "utf8"),
			inPlaceHead,
			inPlaceTail,
		);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		expect(await fsp.readFile(journal, "utf8")).toBe(inPlaceHead + keep1 + keep2 + inPlaceTail);

		// Shifted head replacement (longer UTF-8 head moves the kept historical slice).
		const shiftedHead = `${JSON.stringify({ type: "session", id: "s2-shifted", version: 3 })}\n`;
		const shiftedTail = sessionRow("m3", "shifted-tail");
		await storage.rewriteTailAtomic(
			journal,
			Buffer.byteLength(inPlaceHead, "utf8"),
			Buffer.byteLength(inPlaceHead + keep1 + keep2, "utf8"),
			shiftedHead,
			shiftedTail,
		);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		expect(await fsp.readFile(journal, "utf8")).toBe(shiftedHead + keep1 + keep2 + shiftedTail);
	});

	it("writeTextAtomic preserves one ordered valid foreign row appended during renameSync without whole-file reads", async () => {
		const dir = temp("staged-write-late-append-");
		const journal = path.join(dir, "session.jsonl");
		const header = `${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n`;
		const kept = sessionRow("m1", "historical-row");
		await fsp.writeFile(journal, header + kept + sessionRow("m2", "before-rewrite"), "utf8");

		const lateRow = sessionRow("foreign-1", "late-foreign-append");
		const storage = new LateAppendStorage(journal, lateRow);
		const reads = countSyncWholeFileReads(journal);
		const rewritten = header + kept + sessionRow("m2", "after-rewrite");

		await storage.writeTextAtomic(journal, rewritten);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		const finalBody = await fsp.readFile(journal, "utf8");
		expect(finalBody).toBe(rewritten + lateRow);
		expect(finalBody.split("late-foreign-append").length - 1).toBe(1);
	});

	it("rewriteTailAtomic preserves one ordered valid foreign row appended during renameSync without whole-file reads", async () => {
		const dir = temp("staged-tail-late-append-");
		const journal = path.join(dir, "session.jsonl");
		const head = `${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n`;
		const keep = sessionRow("m1", "kept-historical-row");
		const oldTail = sessionRow("m2", "old-tail-row");
		await fsp.writeFile(journal, head + keep + oldTail, "utf8");

		const lateRow = sessionRow("foreign-2", "late-tail-foreign");
		const storage = new LateAppendStorage(journal, lateRow);
		const reads = countSyncWholeFileReads(journal);
		const newTail = sessionRow("m2", "new-tail-row");

		await storage.rewriteTailAtomic(
			journal,
			Buffer.byteLength(head, "utf8"),
			Buffer.byteLength(head + keep, "utf8"),
			head,
			newTail,
		);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		const finalBody = await fsp.readFile(journal, "utf8");
		expect(finalBody).toBe(head + keep + newTail + lateRow);
		expect(finalBody.split("late-tail-foreign").length - 1).toBe(1);
	});

	it("late append replay skips malformed lines and session_switched lifecycle rows while keeping valid rows in order", async () => {
		const dir = temp("staged-filter-late-append-");
		const journal = path.join(dir, "session.jsonl");
		const header = `${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n`;
		await fsp.writeFile(journal, header + sessionRow("m1", "initial"), "utf8");

		const validBefore = sessionRow("foreign-before", "keep-before");
		const switched = `${JSON.stringify({ type: "session_lifecycle", state: "ended", reason: "session_switched" })}\n`;
		const malformed = '{"type":"message","id":"torn"\n';
		const validAfter = sessionRow("foreign-after", "keep-after");
		const storage = new LateAppendStorage(journal, validBefore + switched + malformed + validAfter);
		const reads = countSyncWholeFileReads(journal);

		const staged = header + sessionRow("m1", "rewritten");
		await storage.writeTextAtomic(journal, staged);

		expect(reads.journalReads).toBe(0);
		expect(reads.stagedReads).toBe(0);
		const finalBody = await fsp.readFile(journal, "utf8");
		expect(finalBody).toBe(staged + validBefore + validAfter);
		expect(finalBody).not.toContain("session_switched");
		expect(finalBody).not.toContain('"id":"torn"');
	});

	it("off-target paths (non-.jsonl target and non-.tmp source) bypass staged replay without reading target or source", async () => {
		const dir = temp("staged-off-target-");
		const textTarget = path.join(dir, "notes.txt");
		await fsp.writeFile(textTarget, "old-text\n", "utf8");

		const storage = new FileSessionStorage();
		const textReads = countSyncWholeFileReads(textTarget);
		await storage.writeTextAtomic(textTarget, "new-text\n");
		expect(textReads.journalReads).toBe(0);
		expect(textReads.stagedReads).toBe(0);
		expect(await fsp.readFile(textTarget, "utf8")).toBe("new-text\n");

		vi.restoreAllMocks();

		const journal = path.join(dir, "session.jsonl");
		const nonTmpSource = path.join(dir, "replacement.jsonl");
		await fsp.writeFile(journal, sessionRow("old", "must-not-replay"), "utf8");
		await fsp.writeFile(nonTmpSource, sessionRow("new", "direct-replace"), "utf8");

		const journalReads = countSyncWholeFileReads(journal);
		storage.renameSync(nonTmpSource, journal);
		expect(journalReads.journalReads).toBe(0);
		expect(journalReads.stagedReads).toBe(0);
		expect(await fsp.readFile(journal, "utf8")).toBe(sessionRow("new", "direct-replace"));
	});

	it.skipIf(process.platform === "win32")("replays a peer append after the 1 GiB boundary", async () => {
		const journal = path.join(temp("staged-gibibyte-offset-"), "session.jsonl");
		const end = (1 << 30) + 1;
		const file = await fsp.open(journal, "w");
		try {
			// A hole exercises the real file-offset boundary without writing 1 GiB.
			await file.write(Buffer.from("\n"), 0, 1, end - 1);
		} finally {
			await file.close();
		}
		expect((await fsp.stat(journal)).size).toBe(end);
		const staged = sessionRow("replacement", "replacement body");
		const peer = sessionRow("peer", "peer append past 1 GiB");
		const storage = new LateAppendStorage(journal, peer);
		await storage.writeTextAtomic(journal, staged);
		expect(await fsp.readFile(journal, "utf8")).toBe(staged + peer);
	});

	it("keeps the original journal when an out-of-lock append exceeds the commit budget", async () => {
		const dir = temp("staged-write-foreign-burst-");
		const journal = path.join(dir, "session.jsonl");
		const original = sessionRow("old", "original");
		const peer = sessionRow("peer", "x".repeat(2 << 20));
		await fsp.writeFile(journal, original);
		const storage = new LateAppendStorage(journal, peer);

		await expect(storage.writeTextAtomic(journal, sessionRow("new", "new"))).rejects.toThrow(
			"Too many bytes appended during session journal publication",
		);
		expect(await fsp.readFile(journal, "utf8")).toBe(original + peer);
		expect((await fsp.readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("preserves foreign rows when rebuilding a large journal", async () => {
		const dir = temp("rewrite-stream-foreign-");
		const journal = path.join(dir, "session.jsonl");
		class NoWholeJournalRead extends FileSessionStorage {
			blockWholeRead = false;
			attemptedWholeRead = false;

			override readText(file: string): Promise<string> {
				if (this.blockWholeRead && file === journal) {
					this.attemptedWholeRead = true;
					throw new Error("Whole journal read refused");
				}
				return super.readText(file);
			}
		}
		const storage = new NoWholeJournalRead();
		const manager = await SessionManager.open(journal, dir, storage);
		try {
			await appendLargeHistory(manager);
			const peer = foreignMessageRow("foreign-streamed", "independent append");
			await fsp.appendFile(journal, peer);
			const before = await fsp.readFile(journal);
			expect(before.byteLength).toBeGreaterThan(8 << 20);
			storage.blockWholeRead = true;

			await manager.rewriteEntries();

			expect(storage.attemptedWholeRead).toBe(false);
			expect((await fsp.readFile(journal)).equals(before)).toBe(true);
		} finally {
			await manager.close();
		}
	});

	it("bounds large foreign-line scans to pre-append stat size and preserves concurrent peer rows", async () => {
		const dir = temp("rewrite-bounded-large-scan-");
		const journal = path.join(dir, "session.jsonl");
		const manager = await SessionManager.open(journal, dir);
		let openSpy: { mockRestore(): void } | undefined;
		try {
			await appendLargeHistory(manager);

			const peer1 = foreignMessageRow("foreign-before-scan", "pre-existing foreign row");
			const peer2 = foreignMessageRow("foreign-during-scan", "concurrent foreign row");
			await fsp.appendFile(journal, peer1, "utf8");

			const preAppendSize = (await fsp.stat(journal)).size;
			expect(preAppendSize).toBeGreaterThan(8 << 20);
			expect(preAppendSize % (1 << 20)).not.toBe(0);
			const before = await fsp.readFile(journal);

			const resolvedJournal = path.resolve(journal);
			const realOpen = fs.promises.open.bind(fs.promises);
			const readRequests: Array<{ offset: number; length: number }> = [];
			let injected = false;

			openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
				const handle = await realOpen(file, flags, mode);
				if (normalizeFsTarget(file) === resolvedJournal) {
					const realRead = handle.read.bind(handle);
					Object.defineProperty(handle, "read", {
						configurable: true,
						value: async (buffer: Buffer, offset: number, length: number, position: number) => {
							readRequests.push({ offset: position, length });
							const result = await realRead(buffer, offset, length, position);
							if (!injected) {
								injected = true;
								await fsp.appendFile(journal, peer2, "utf8");
							}
							return result;
						},
					});
				}
				return handle;
			});

			await manager.rewriteEntries();

			expect(injected).toBe(true);
			expect(readRequests.length).toBeGreaterThan(0);
			const outOfBoundsReads = readRequests.filter(
				req => req.offset >= preAppendSize || req.offset + req.length > preAppendSize,
			);
			expect(outOfBoundsReads).toEqual([]);

			const after = await fsp.readFile(journal);
			expect(after.subarray(0, preAppendSize).equals(before)).toBe(true);
			expect(after.subarray(preAppendSize).toString("utf8")).toBe(peer2);
		} finally {
			openSpy?.mockRestore();
			await manager.close();
		}
	});

	it("publishes waiting sibling grants once without accepting a duplicate or losing a sibling", async () => {
		const dir = temp("rewrite-grant-burst-");
		const storage = new FileSessionStorage();
		const root = SessionManager.create(dir, path.join(dir, "sessions", "project"), storage);
		try {
			root.appendMessage({ role: "user", content: "retained history", timestamp: 1 });
			await root.ensureOnDisk();
			const journal = root.getSessionFile()!;
			const artifactDir = path.join(await fsp.realpath(path.dirname(journal)), path.basename(journal, ".jsonl"));
			const grants = ["First", "Second", "Third"].map(agentId => ({
				type: "subagent_launch_grant" as const,
				version: 1 as const,
				rootSessionId: root.getSessionId(),
				agentId,
				childSessionId: crypto.randomUUID(),
				sessionFile: path.join(artifactDir, `${agentId}.jsonl`),
				grants: { mergeRepos: ["Example/project"], dismissRepos: [] },
			}));
			const publish = spyOn(storage, "renameSync");
			const results = await Promise.allSettled(
				[grants[0]!, grants[1]!, grants[0]!, grants[2]!].map(grant => root.appendSubagentLaunchGrant(grant)),
			);
			expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
			const rows = (await fsp.readFile(journal, "utf8"))
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(rows.filter(row => row.type === "subagent_launch_grant")).toEqual(grants);
			expect(rows.some(row => row.message?.content === "retained history")).toBe(true);
			expect(publish.mock.calls.filter(([, target]) => target === journal)).toHaveLength(1);
		} finally {
			await root.close();
		}
	});

	it("rejects every waiting grant on publish failure and lets the next batch retry", async () => {
		const dir = temp("rewrite-grant-retry-");
		const storage = new FileSessionStorage();
		const root = SessionManager.create(dir, path.join(dir, "sessions", "project"), storage);
		try {
			await root.ensureOnDisk();
			const journal = root.getSessionFile()!;
			const artifactDir = path.join(await fsp.realpath(path.dirname(journal)), path.basename(journal, ".jsonl"));
			const grants = ["One", "Two"].map(agentId => ({
				type: "subagent_launch_grant" as const,
				version: 1 as const,
				rootSessionId: root.getSessionId(),
				agentId,
				childSessionId: crypto.randomUUID(),
				sessionFile: path.join(artifactDir, `${agentId}.jsonl`),
				grants: { mergeRepos: ["Example/project"], dismissRepos: [] },
			}));
			const failure = spyOn(storage, "renameSync").mockImplementation(() => {
				throw new Error("injected journal failure");
			});
			const failed = await Promise.allSettled(grants.map(grant => root.appendSubagentLaunchGrant(grant)));
			expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
			expect(root.getSubagentLaunchGrants()).toEqual([]);
			expect(await fsp.readFile(journal, "utf8")).not.toContain('"subagent_launch_grant"');
			failure.mockRestore();
			await Promise.all(grants.map(grant => root.appendSubagentLaunchGrant(grant)));
			expect(root.getSubagentLaunchGrants()).toEqual(grants);
		} finally {
			await root.close();
		}
	});

	for (const late of [false, true]) {
		for (const tail of [false, true]) {
			it(`preserves a peer launch grant ${late ? "after" : "before"} the snapshot during ${tail ? "tail" : "full"} rewrite`, async () => {
				const dir = temp("rewrite-peer-grant-");
				const storage = new LateAppendOnWriteTextAtomicStorage();
				const manager = SessionManager.create(dir, path.join(dir, "sessions", "project"), storage);
				let peer: SessionManager | undefined;
				let reopened: SessionManager | undefined;
				try {
					manager.appendMessage({ role: "user", content: "retained history", timestamp: 1 });
					await manager.flush();
					await manager.ensureOnDisk();
					const journal = manager.getSessionFile()!;
					peer = await SessionManager.open(journal);
					const grant = {
						type: "subagent_launch_grant" as const,
						version: 1 as const,
						rootSessionId: peer.getSessionId(),
						agentId: "PeerGrant",
						childSessionId: "11111111-2222-4333-8444-555555555555",
						sessionFile: path.join(
							await fsp.realpath(path.dirname(journal)),
							path.basename(journal, ".jsonl"),
							"child.jsonl",
						),
						grants: { mergeRepos: ["Example/project"], dismissRepos: [] },
					};
					let raw = JSON.stringify(grant);
					if (!late) {
						// A second manager acknowledges the receipt before the stale manager scans.
						await peer.appendSubagentLaunchGrant(grant);
						raw = (await fsp.readFile(journal, "utf8"))
							.split("\n")
							.find(line => line.includes('"subagent_launch_grant"'))!;
					}
					if (late) {
						const realRename = storage.renameSync.bind(storage);
						spyOn(storage, "renameSync").mockImplementation((source, target) => {
							if (target === journal && source.includes(".tmp")) {
								fs.appendFileSync(journal, `${raw}\n`);
								vi.restoreAllMocks();
							}
							realRename(source, target);
						});
					}
					if (tail) await manager.setCwd(path.join(dir, "moved"), { validate: false });
					else await manager.rewriteEntries();
					const rows = (await fsp.readFile(journal, "utf8")).split("\n");
					expect(rows.filter(line => line === raw)).toHaveLength(1);
					reopened = await SessionManager.open(journal);
					expect(reopened.getSubagentLaunchGrants()).toEqual([grant]);
					await fsp.appendFile(journal, foreignMessageRow("force-receipt-refresh", "peer row"));
					await reopened.rewriteEntries();
					expect((await fsp.readFile(journal, "utf8")).split("\n").filter(line => line === raw)).toHaveLength(1);
				} finally {
					vi.restoreAllMocks();
					await reopened?.close();
					await peer?.close();
					await manager.close();
				}
			});
		}
	}

	for (const malformed of [false, true]) {
		it(`retains ${malformed ? "malformed" : "duplicate"} foreign receipt bytes and refuses ambiguous authorization`, async () => {
			const dir = temp("rewrite-ambiguous-peer-grant-");
			const manager = await SessionManager.open(path.join(dir, "session.jsonl"), dir);
			let reopened: SessionManager | undefined;
			try {
				manager.appendMessage({ role: "user", content: "retained history", timestamp: 1 });
				await manager.flush();
				const journal = manager.getSessionFile()!;
				const raw = JSON.stringify({
					type: "subagent_launch_grant",
					version: malformed ? 2 : 1,
					rootSessionId: manager.getSessionId(),
					agentId: "PeerGrant",
					childSessionId: "11111111-2222-4333-8444-555555555555",
					sessionFile: path.join(dir, "child.jsonl"),
					grants: { mergeRepos: ["Example/project"], dismissRepos: [] },
				});
				const copies = malformed ? 1 : 2;
				await fsp.appendFile(journal, `${raw}\n`.repeat(copies));
				await manager.rewriteEntries();
				expect((await fsp.readFile(journal, "utf8")).split("\n").filter(line => line === raw)).toHaveLength(copies);
				reopened = await SessionManager.open(journal);
				expect(() => reopened!.getSubagentLaunchGrants()).toThrow("unverified");
			} finally {
				await reopened?.close();
				await manager.close();
			}
		});
	}

	it("preserves a peer append that lands before writeTextAtomic during a full rewrite", async () => {
		const dir = temp("rewrite-entries-late-peer-before-write-");
		const journal = path.join(dir, "session.jsonl");
		const storage = new LateAppendOnWriteTextAtomicStorage();
		const manager = await SessionManager.open(journal, dir, storage);
		try {
			manager.appendMessage({ role: "user", content: "first owned message", timestamp: 1 });
			await manager.flush();

			const before = await fsp.readFile(journal, "utf8");
			const peer = foreignMessageRow("foreign-before-write-text-atomic", "late peer append");
			storage.lateBytes = peer;

			await manager.rewriteEntries();

			expect(await fsp.readFile(journal, "utf8")).toBe(before + peer);
		} finally {
			await manager.close();
		}
	});
});
