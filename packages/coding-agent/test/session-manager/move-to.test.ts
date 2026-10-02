import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripOuterDoubleQuotes } from "@veyyon/coding-agent/tools/core/path-utils";
import type { SessionHeader } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir } from "@veyyon/utils";

// -- helpers ----------------------------------------------------------------

import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

function hasAssistantEntry(entries: unknown[]): boolean {
	return entries.some(
		e =>
			typeof e === "object" &&
			e !== null &&
			"type" in e &&
			(e as any).type === "message" &&
			"message" in e &&
			(e as any).message?.role === "assistant",
	);
}

// -- stripOuterDoubleQuotes tests -------------------------------------------

describe("stripOuterDoubleQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripOuterDoubleQuotes('"C:\\Users\\test"')).toBe("C:\\Users\\test");
	});
	it("strips matching double quotes from POSIX paths", () => {
		expect(stripOuterDoubleQuotes('"/home/user/test"')).toBe("/home/user/test");
	});
	it("passes through unquoted paths", () => {
		expect(stripOuterDoubleQuotes("C:\\Users\\test")).toBe("C:\\Users\\test");
	});
	it("does not strip mismatched quotes", () => {
		expect(stripOuterDoubleQuotes('"mismatched')).toBe('"mismatched');
	});
	it("does not strip single quotes", () => {
		expect(stripOuterDoubleQuotes("'foo'")).toBe("'foo'");
	});
	it("does not strip a lone double quote", () => {
		expect(stripOuterDoubleQuotes('"')).toBe('"');
	});
	it("strips empty quoted string to empty", () => {
		expect(stripOuterDoubleQuotes('""')).toBe("");
	});
});

// -- moveTo() tests ---------------------------------------------------------

describe("SessionManager.moveTo", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	// One owner for "undo a setAgentDir call": the hand-rolled version below could not
	// restore an ABSENT VEYYON_CODING_AGENT_DIR and left the active profile cleared,
	// which leaked into every file that ran after this one.
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-move-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		restoreDirOverrides(dirOverrides);
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("moves session file and updates header cwd (baseline)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldFile)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Reload and verify content
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("makes the moved session visible to resume from the target cwd", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile()!;

		await session.moveTo(cwdB);

		const movedFile = session.getSessionFile()!;
		const sourceSessions = await SessionManager.list(cwdA);
		const targetSessions = await SessionManager.list(cwdB);

		expect(sourceSessions.some(item => item.path === oldFile)).toBe(false);
		expect(targetSessions.some(item => item.path === movedFile)).toBe(true);
	});

	it("succeeds on fresh session without ENOENT, then deferred persistence works", async () => {
		const session = SessionManager.create(cwdA);
		// No messages — file never written to disk
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		// Lazy-persist preserved: no header-only .jsonl created
		expect(fs.existsSync(newFile)).toBe(false);

		// Verify deferred persistence at the new path
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		expect(fs.existsSync(newFile)).toBe(true);
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("recreates file from memory when old file is deleted (assistant exists)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.close();

		const oldFile = session.getSessionFile()!;
		// Delete the file to simulate unexpected removal
		await fsp.unlink(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Verify content recreated from memory
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("moves header-only session and rewrites cwd", async () => {
		// Create a header-only session via open() with a non-existent explicit path
		const explicitPath = path.join(cwdA, "explicit-session.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves header-only session with pending user message (#flushed regression)", async () => {
		// Create a header-only session
		const explicitPath = path.join(cwdA, "explicit-session-2.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		// Add a user message only — _persist() sets #flushed=false (line 1827)
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Rewrite must have run (hadSessionFile=true) even though #flushed was reset
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves artifact dir independently when session file does not exist", async () => {
		const session = SessionManager.create(cwdA);
		// Allocate an artifact — creates dir via ArtifactManager
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");

		const oldArtifactDir = path.dirname(artifactPath);
		expect(fs.existsSync(oldArtifactDir)).toBe(true);

		// No messages — session file doesn't exist
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		// Old artifact dir moved
		expect(fs.existsSync(oldArtifactDir)).toBe(false);
		// New artifact dir exists
		const newFile = session.getSessionFile()!;
		const newArtifactDir = newFile.slice(0, -6); // strip .jsonl
		expect(fs.existsSync(newArtifactDir)).toBe(true);
	});
	it("moves a custom session and artifacts when rename crosses devices", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const oldArtifacts = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifacts);
		await Bun.write(path.join(oldArtifacts, "1.bash.log"), "saved output");
		const destinationDir = path.join(testAgentDir, "custom-b");
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldFile || from.toString() === oldArtifacts) {
				throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			}
			return rename(from, to);
		});
		try {
			await session.moveTo(cwdB, destinationDir);
		} finally {
			renameSpy.mockRestore();
		}
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);
		expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(path.resolve(cwdB));
		expect(await Bun.file(path.join(newFile.slice(0, -6), "1.bash.log")).text()).toBe("saved output");
		await session.close();
	});
	it("retains the source when cross-device publication finds an occupied destination", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "occupied");
		await fsp.mkdir(destinationDir);
		const destination = path.join(destinationDir, path.basename(oldFile));
		await Bun.write(destination, "another session");
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return rename(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(path.resolve(cwdA));
		expect(await Bun.file(destination).text()).toBe("another session");
		expect(await fsp.readdir(destinationDir)).toEqual([path.basename(oldFile)]);
		await session.close();
	});

	it("includes completed appends made while a cross-device copy is staged", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "custom-b");
		const rename = fs.promises.rename.bind(fs.promises);
		const copyFile = fs.promises.copyFile.bind(fs.promises);
		let appended = false;
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return rename(from, to);
		});
		const copySpy = spyOn(fs.promises, "copyFile").mockImplementation(async (from, to, flags) => {
			await copyFile(from, to, flags);
			if (from.toString() === oldFile && !appended) {
				appended = true;
				session.appendMessage({ role: "user", content: "during staged copy", timestamp: 2 });
			}
		});
		try {
			await session.moveTo(cwdB, destinationDir);
		} finally {
			renameSpy.mockRestore();
			copySpy.mockRestore();
		}
		const entries = await loadEntriesFromFile(session.getSessionFile()!);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during staged copy",
			),
		).toBe(true);
		expect(fs.existsSync(oldFile)).toBe(false);
		await session.close();
	});

	it("rolls a cross-device session back when its artifacts cannot be relocated", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const oldArtifacts = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifacts);
		await Bun.write(path.join(oldArtifacts, "1.bash.log"), "saved output");
		const destinationDir = path.join(testAgentDir, "destination");
		const destinationFile = path.join(destinationDir, path.basename(oldFile));
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldFile || from.toString() === destinationFile) {
				throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			}
			if (from.toString() === oldArtifacts) {
				throw Object.assign(new Error("artifact move denied"), { code: "EACCES" });
			}
			return rename(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("artifact move denied");
		} finally {
			renameSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(path.resolve(cwdA));
		expect(await Bun.file(path.join(oldArtifacts, "1.bash.log")).text()).toBe("saved output");
		expect(await fsp.readdir(destinationDir)).toEqual([]);
		await session.close();
	});

	it("retains the source when cross-device source cleanup fails", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "destination");
		const rename = fs.promises.rename.bind(fs.promises);
		const unlink = fs.unlinkSync.bind(fs);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return rename(from, to);
		});
		const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (file.toString() === oldFile) throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
			return unlink(file);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source removal denied");
		} finally {
			renameSpy.mockRestore();
			unlinkSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(path.resolve(cwdA));
		expect(await fsp.readdir(destinationDir)).toEqual([]);
		await session.close();
	});
});
