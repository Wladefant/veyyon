import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@veyyon/ai";
import * as logger from "@veyyon/utils/logger";
import {
	BlobStore,
	resolveImageData,
	resolveImageDataUrl,
	resolveTextBlobRef,
} from "../src/session/blob-store";
import type { SessionMessageEntry } from "../src/session/session-entries";
import { resolveBlobRefsInEntries } from "../src/session/session-loader";

// WHY: When session loading or history resolution is cancelled via an AbortSignal,
// in-flight blob store reads must abort promptly. The cancellation must propagate
// as an abort rejection instead of falling back to a "missing blob" warning or returning
// un-restored references. Furthermore, a cancelled restoration must not mutate entry
// target properties after the abort signal fires.
//
// What this suite does NOT catch: synchronous resolution paths (e.g. resolveBlobSiteSync),
// which are non-blocking and do not accept an AbortSignal.

const base = fs.mkdtempSync(path.join(os.tmpdir(), "blob-cancellation-test-"));
const blobDir = path.join(base, "blobs");
fs.mkdirSync(blobDir, { recursive: true });
const store = new BlobStore(blobDir);

afterAll(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("blob restoration cancellation", () => {
	it("BlobStore.get rejects on already-aborted signal without reading", async () => {
		const controller = new AbortController();
		controller.abort();
		const put = store.putSync(Buffer.from("hello world"));

		await expect(store.get(put.hash, { signal: controller.signal })).rejects.toThrow();
	});

	it("BlobStore.get rejects on pending abort while reading", async () => {
		const controller = new AbortController();
		const put = store.putSync(Buffer.from("pending read data"));

		const origReadFile = fsp.readFile;
		const readStarted = Promise.withResolvers<void>();
		const readCanContinue = Promise.withResolvers<void>();
		const readFileSpy = spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
			readStarted.resolve();
			await readCanContinue.promise;
			return (origReadFile as Function)(...args);
		}) as typeof fsp.readFile);

		try {
			const getPromise = store.get(put.hash, { signal: controller.signal });
			await readStarted.promise;
			controller.abort();
			readCanContinue.resolve();
			await expect(getPromise).rejects.toThrow();
		} finally {
			readFileSpy.mockRestore();
		}
	});

	it("BlobStore.get rejects when pending read rejects ENOENT after abort", async () => {
		const controller = new AbortController();
		const put = store.putSync(Buffer.from("pending read data"));

		const readStarted = Promise.withResolvers<void>();
		const readCanReject = Promise.withResolvers<void>();
		const readFileSpy = spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
			readStarted.resolve();
			await readCanReject.promise;
			const enoent = new Error(`ENOENT: no such file or directory, open '${String(args[0])}'`) as NodeJS.ErrnoException;
			enoent.code = "ENOENT";
			enoent.errno = -2;
			enoent.syscall = "open";
			throw enoent;
		}) as typeof fsp.readFile);

		try {
			const getPromise = store.get(put.hash, { signal: controller.signal });
			await readStarted.promise;
			controller.abort();
			readCanReject.resolve();

			await expect(getPromise).rejects.toThrow();
		} finally {
			readFileSpy.mockRestore();
		}
	});

	it("resolveTextBlobRef propagates abort rejection without missing blob fallback or warning", async () => {
		const controller = new AbortController();
		controller.abort();
		const put = store.putSync(Buffer.from("some text"));
		const ref = `blobtext:sha256:${put.hash}`;

		let warnCalled = false;
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {
			warnCalled = true;
		});

		try {
			await expect(resolveTextBlobRef(store, ref, { signal: controller.signal })).rejects.toThrow();
			expect(warnCalled).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("resolveImageData and resolveImageDataUrl propagate abort rejection without missing blob fallback or warning", async () => {
		const controller = new AbortController();
		controller.abort();
		const put = store.putSync(Buffer.from("image bytes"));

		let warnCalled = false;
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {
			warnCalled = true;
		});

		try {
			await expect(resolveImageData(store, put.ref, { signal: controller.signal })).rejects.toThrow();
			await expect(resolveImageDataUrl(store, put.ref, { signal: controller.signal })).rejects.toThrow();
			expect(warnCalled).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("resolveBlobRefsInEntries aborts during pending blob read and prevents post-abort mutations", async () => {
		const controller = new AbortController();
		const put = store.putSync(Buffer.from("large tool output payload"));
		const ref = `blobtext:sha256:${put.hash}`;

		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: ref }],
			isError: false,
			timestamp: Date.now(),
		};

		const entry: SessionMessageEntry = {
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: toolMessage,
		};

		const origReadFile = fsp.readFile;
		const readStarted = Promise.withResolvers<void>();
		const readCanContinue = Promise.withResolvers<void>();
		const readFileSpy = spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
			readStarted.resolve();
			await readCanContinue.promise;
			return (origReadFile as Function)(...args);
		}) as typeof fsp.readFile);
		let warnCalled = false;
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {
			warnCalled = true;
		});

		try {
			const loadPromise = resolveBlobRefsInEntries([entry], store, { signal: controller.signal });
			await readStarted.promise;
			controller.abort();
			readCanContinue.resolve();
			await expect(loadPromise).rejects.toThrow();
			expect(warnCalled).toBe(false);
			// Post-abort mutation check: target property must not have been mutated into restored content
			const contentBlock = toolMessage.content?.[0];
			expect(contentBlock && "text" in contentBlock ? contentBlock.text : "").toBe(ref);
		} finally {
			readFileSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("resolveBlobRefsInEntries aborts and suppresses missing-blob warning when pending read rejects ENOENT after abort", async () => {
		const controller = new AbortController();
		const put = store.putSync(Buffer.from("payload subject to abort/missing race"));
		const ref = `blobtext:sha256:${put.hash}`;

		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: ref }],
			isError: false,
			timestamp: Date.now(),
		};

		const entry: SessionMessageEntry = {
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: toolMessage,
		};

		const readStarted = Promise.withResolvers<void>();
		const readCanReject = Promise.withResolvers<void>();
		const readFileSpy = spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
			readStarted.resolve();
			await readCanReject.promise;
			const enoent = new Error(`ENOENT: no such file or directory, open '${String(args[0])}'`) as NodeJS.ErrnoException;
			enoent.code = "ENOENT";
			enoent.errno = -2;
			enoent.syscall = "open";
			throw enoent;
		}) as typeof fsp.readFile);

		let warnCalled = false;
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {
			warnCalled = true;
		});

		try {
			const loadPromise = resolveBlobRefsInEntries([entry], store, { signal: controller.signal });
			await readStarted.promise;
			controller.abort();
			readCanReject.resolve();

			await expect(loadPromise).rejects.toThrow();
			expect(warnCalled).toBe(false);
			// Post-abort mutation check: target property must not have been mutated into restored content
			const contentBlock = toolMessage.content?.[0];
			expect(contentBlock && "text" in contentBlock ? contentBlock.text : "").toBe(ref);
		} finally {
			readFileSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});
});
