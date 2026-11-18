/**
 * WHY: Session storage writers across backends (FileSessionStorage, MemorySessionStorage,
 * and IndexedSessionStorage / SqlSessionStorage) must conform to a uniform public lifecycle
 * and error contract: isOpen reflecting active vs closed state, append throwing "Writer closed"
 * once closed, idempotent close, and asynchronous/synchronous error notification via onError
 * and error latching across subsequent append/flush calls.
 *
 * This suite exercises actual public behavior across every storage dialect without mocking
 * internal base classes.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { loadSessionFile } from "@veyyon/kernel/session/session-loader";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
} from "@veyyon/kernel/session/session-storage";
import { SqlSessionStorage } from "@veyyon/kernel/session/sql-session-storage";
import { SQL } from "bun";

describe("session storage writers conform to lifecycle and error contracts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("MemorySessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle", async () => {
			const storage = new MemorySessionStorage();
			const filePath = "/test/session.jsonl";
			const writer = storage.openWriter(filePath);

			expect(writer.isOpen()).toBe(true);
			expect(writer.getError()).toBeUndefined();

			await writer.append('{"type":"session","id":"m1"}\n');
			await writer.flush();
			expect(storage.readTextSync(filePath)).toBe('{"type":"session","id":"m1"}\n');

			await writer.close();
			expect(writer.isOpen()).toBe(false);

			// Idempotent close
			await writer.close();
			expect(writer.isOpen()).toBe(false);

			await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
		});

		it("creates empty file on truncate flag w", async () => {
			const storage = new MemorySessionStorage();
			const filePath = "/test/trunc.jsonl";
			storage.writeTextSync(filePath, "existing\n");

			const writer = storage.openWriter(filePath, { flags: "w" });
			expect(storage.readTextSync(filePath)).toBe("");

			await writer.append("new\n");
			await writer.close();
			expect(storage.readTextSync(filePath)).toBe("new\n");
		});
	});

	describe("FileSessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle on real filesystem", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-test-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "session.jsonl");
				writer = storage.openWriter(filePath);

				expect(writer.isOpen()).toBe(true);
				expect(writer.getError()).toBeUndefined();

				await writer.append('{"type":"session","id":"f1"}\n');
				await writer.flush();
				expect(fs.readFileSync(filePath, "utf8")).toBe('{"type":"session","id":"f1"}\n');

				await writer.close();
				expect(writer.isOpen()).toBe(false);

				// Idempotent close
				await writer.close();
				expect(writer.isOpen()).toBe(false);

				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("reports write error via onError and latches error on subsequent operations", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-err-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "err.jsonl");
				const seenErrors: Error[] = [];
				writer = storage.openWriter(filePath, {
					onError: err => seenErrors.push(err),
				});

				// Spy on fs.writeSync to simulate I/O failure
				const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
					throw new Error("EIO: simulated disk write failure");
				});

				await expect(writer.append('{"type":"session"}\n')).rejects.toThrow("EIO: simulated disk write failure");

				expect(seenErrors).toHaveLength(1);
				expect(seenErrors[0]?.message).toBe("EIO: simulated disk write failure");
				expect(writer.getError()?.message).toBe("EIO: simulated disk write failure");

				// Subsequent append/flush must rethrow the latched error immediately
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("EIO: simulated disk write failure");
				await expect(writer.flush()).rejects.toThrow("EIO: simulated disk write failure");

				writeSpy.mockRestore();
				await writer.close();
				expect(writer.isOpen()).toBe(false);
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
				await expect(writer.flush()).rejects.toThrow("EIO: simulated disk write failure");
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("preserves first-error latching even when onError callback throws", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-writer-throw-"));
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = new FileSessionStorage();
				const filePath = path.join(tmpDir, "err_throw.jsonl");
				writer = storage.openWriter(filePath, {
					onError: () => {
						throw new Error("onError consumer exploded");
					},
				});

				const writeSpy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
					throw new Error("EIO: original write fault");
				});

				// append propagates the error from onError callback on initial failure
				await expect(writer.append('{"type":"session"}\n')).rejects.toThrow("onError consumer exploded");

				// First error from fs.writeSync must still be latched as the writer error
				expect(writer.getError()?.message).toBe("EIO: original write fault");

				// Subsequent calls rethrow the latched original write fault, distinguishing callback error from storage error
				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("EIO: original write fault");
				await expect(writer.flush()).rejects.toThrow("EIO: original write fault");

				writeSpy.mockRestore();
			} finally {
				if (writer) {
					await writer.close();
				}
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		// fsp.readFile avoids the Bun.file().text() torn-read bug under concurrent complete appends,
		// though fs.promises.readFile is not an atomic snapshot under partial writeSync or arbitrary concurrent writes.
		it("readText observes complete records across concurrent single-write appends (Bun torn-read regression)", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-readtext-race-"));
			const filePath = path.join(tmpDir, "session.jsonl");
			const baseLine = `${JSON.stringify({ id: "0", type: "message", text: "x".repeat(1800) })}\n`;
			await fsp.writeFile(filePath, baseLine.repeat(600), "utf8");

			const storage = new FileSessionStorage();
			const writer = storage.openWriter(filePath);
			const appendLine = `${JSON.stringify({
				id: "1",
				type: "custom_message",
				customType: "agent-terminal-outcome",
				content: 'Agent "Orphan" stalled: Parent session no longer exists.',
				details: { outcome: "stalled" },
			})}\n`;

			let badLines = 0;
			let totalReads = 0;
			let writing = true;
			const writerLoop = (async () => {
				try {
					for (let i = 0; i < 120; i++) {
						await writer.append(appendLine);
						await yieldToEventLoop();
					}
				} finally {
					writing = false;
				}
			})();

			const readerLoop = (async () => {
				while (writing) {
					const batch = Array.from({ length: 16 }, async () => {
						const text = await storage.readText(filePath);
						totalReads++;
						for (const line of text.split("\n")) {
							if (line.trim().length === 0) continue;
							try {
								JSON.parse(line);
							} catch {
								badLines++;
							}
						}
					});
					await Promise.all(batch);
				}
			})();

			try {
				await Promise.all([writerLoop, readerLoop]);
				await writer.close();
				expect(totalReads).toBeGreaterThan(0);
				expect(badLines).toBe(0);
			} finally {
				if (writer.isOpen()) await writer.close().catch(() => {});
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("handles partial multi-call fs.writeSync appends, mid-record loadSessionFile reads, and Windows EBUSY sharing errors", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-readtext-interleave-"));
			const filePath = path.join(tmpDir, "session.jsonl");
			const midPath = path.join(tmpDir, "mid-record.jsonl");
			const header = `${JSON.stringify({
				type: "session",
				version: 3,
				id: "s1",
				timestamp: "2026-11-16T00:00:00.000Z",
				cwd: tmpDir,
			})}\n`;
			const firstMsg = `${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-11-16T00:00:01.000Z",
				message: { role: "user", content: "hello" },
			})}\n`;
			const appendLine = `${JSON.stringify({
				type: "custom_message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-11-16T00:00:02.000Z",
				customType: "agent-terminal-outcome",
				content: "ok",
				details: { outcome: "stalled" },
			})}\n`;

			await fsp.writeFile(filePath, `${header}${firstMsg}`, "utf8");
			const storage = new FileSessionStorage();
			const writer = storage.openWriter(filePath);
			const splitAt = Math.floor(appendLine.length / 2);
			let writeCalls = 0;
			let midWriteSnapshot = "";

			try {
				const realWriteSync = fs.writeSync.bind(fs);
				const writeSpy = vi
					.spyOn(fs, "writeSync")
					.mockImplementation(
						(
							fd: number,
							data: NodeJS.ArrayBufferView | string,
							offset?: number | null,
							length?: number | BufferEncoding | null,
							position?: number | null,
						) => {
							writeCalls++;
							if (
								writeCalls === 1 &&
								Buffer.isBuffer(data) &&
								typeof offset === "number" &&
								typeof length === "number"
							) {
								const chunkLen = Math.min(splitAt, length);
								const written = realWriteSync(fd, data, offset, chunkLen, position);
								midWriteSnapshot = fs.readFileSync(filePath, "utf8");
								return written;
							}
							if (typeof data === "string") {
								return realWriteSync(fd, data, offset, typeof length === "string" ? length : undefined);
							}
							return realWriteSync(
								fd,
								data,
								offset ?? undefined,
								typeof length === "number" ? length : undefined,
								position ?? undefined,
							);
						},
					);

				await writer.append(appendLine);
				writeSpy.mockRestore();

				expect(writeCalls).toBe(2);
				expect(midWriteSnapshot).toBe(`${header}${firstMsg}${appendLine.slice(0, splitAt)}`);
				expect(await storage.readText(filePath)).toBe(`${header}${firstMsg}${appendLine}`);

				await fsp.writeFile(midPath, `${header}${firstMsg}${appendLine.slice(0, splitAt)}`, "utf8");
				expect(await storage.readText(midPath)).toBe(`${header}${firstMsg}${appendLine.slice(0, splitAt)}`);
				const midLoaded = await loadSessionFile(midPath, storage);
				expect(midLoaded.entries.map(entry => entry.type)).toEqual(["session", "message"]);
				expect(midLoaded.endsMidLine).toBe(true);
				expect(midLoaded.layout).toBeUndefined();

				await fsp.appendFile(midPath, appendLine.slice(splitAt), "utf8");
				const fullLoaded = await loadSessionFile(midPath, storage);
				expect(fullLoaded.entries.map(entry => entry.type)).toEqual(["session", "message", "custom_message"]);
				expect(fullLoaded.endsMidLine).toBe(false);

				vi.spyOn(fsp, "readFile").mockRejectedValueOnce(
					Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
				);
				let ebusyCode: string | undefined;
				try {
					await storage.readText(filePath);
				} catch (err) {
					ebusyCode = (err as NodeJS.ErrnoException).code;
				}
				expect(ebusyCode).toBe("EBUSY");
			} finally {
				if (writer.isOpen()) await writer.close().catch(() => {});
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("readText strips a leading UTF-8 BOM, preserves CRLF, and keeps ENOENT .code", async () => {
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-readtext-bom-"));
			const filePath = path.join(tmpDir, "bom.jsonl");
			const line1 = JSON.stringify({ id: "1", type: "session" });
			const line2 = JSON.stringify({ id: "2", type: "message", text: "ok" });
			const bytes = Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from(`${line1}\r\n${line2}\r\n`, "utf8"),
			]);
			await fsp.writeFile(filePath, bytes);

			const storage = new FileSessionStorage();
			try {
				const text = await storage.readText(filePath);
				expect(text.startsWith("\uFEFF")).toBe(false);
				expect(text).toBe(`${line1}\r\n${line2}\r\n`);
				expect(JSON.parse(text.split("\r\n")[0]!)).toEqual({ id: "1", type: "session" });

				let enoentCode: string | undefined;
				try {
					await storage.readText(path.join(tmpDir, "missing.jsonl"));
				} catch (err) {
					enoentCode = (err as NodeJS.ErrnoException).code;
				}
				expect(enoentCode).toBe("ENOENT");
			} finally {
				await fsp.rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("IndexedSessionStorage / SqlSessionStorage writer", () => {
		it("manages healthy open/append/flush/close lifecycle", async () => {
			const client = new SQL("sqlite::memory:");
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = await SqlSessionStorage.create({ client });
				const filePath = "/sessions/p/sess_sql.jsonl";
				writer = storage.openWriter(filePath);

				expect(writer.isOpen()).toBe(true);
				expect(writer.getError()).toBeUndefined();

				await writer.append('{"type":"session","id":"s1"}\n');
				await writer.flush();
				expect(await storage.readText(filePath)).toBe('{"type":"session","id":"s1"}\n');

				await writer.close();
				expect(writer.isOpen()).toBe(false);

				// Idempotent close
				await writer.close();
				expect(writer.isOpen()).toBe(false);

				await expect(writer.append('{"type":"message"}\n')).rejects.toThrow("Writer closed");
			} finally {
				if (writer?.isOpen()) {
					await writer.close().catch(() => {});
				}
				await client.end();
			}
		});

		it("reports backend write error via onError, latches error, and rejects close on pending write failure", async () => {
			const client = new SQL("sqlite::memory:");
			let writer: SessionStorageWriter | undefined;
			try {
				const storage = await SqlSessionStorage.create({ client });
				const filePath = "/sessions/p/fail_sql.jsonl";
				const seenErrors: Error[] = [];
				writer = storage.openWriter(filePath, {
					onError: err => seenErrors.push(err),
				});

				// Force error by dropping the table so background queueAppend rejects
				await client.unsafe("DROP TABLE veyyon_session_files");

				await expect(writer.append("doomed\n")).rejects.toThrow(/no such table/i);

				expect(seenErrors).toHaveLength(1);
				expect(seenErrors[0]?.message).toMatch(/no such table/i);
				expect(writer.getError()?.message).toMatch(/no such table/i);

				// Subsequent append/flush rethrows latched error
				await expect(writer.append("more\n")).rejects.toThrow(/no such table/i);
				await expect(writer.flush()).rejects.toThrow(/no such table/i);

				// IndexedSessionStorageWriter.close() awaits flush() and rejects with the latched write error
				await expect(writer.close()).rejects.toThrow(/no such table/i);
				expect(writer.isOpen()).toBe(false);

				// Subsequent close is idempotent and resolves
				await writer.close();
				expect(writer.isOpen()).toBe(false);
			} finally {
				if (writer?.isOpen()) {
					await writer.close().catch(() => {});
				}
				await client.end();
			}
		});
	});
});
