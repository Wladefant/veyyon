import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { useTempDirs } from "./helpers/temp-dirs";

const makeTempDir = useTempDirs();

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

function messageRole(entry: Record<string, unknown>): string | undefined {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

function messageContent(entry: Record<string, unknown>): unknown {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	return (message as { content?: unknown }).content;
}

describe("SessionManager immediate JSONL persistence", () => {
	it("writes the first assistant turn and later entries before appendMessage returns", () => {
		const cwd = makeTempDir("@pi-immediate-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		expect(fs.existsSync(sessionFile)).toBe(false);

		manager.appendMessage(createAssistantMessage("hello"));
		expect(fs.existsSync(sessionFile)).toBe(true);

		let entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(3);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageRole(entries[2] ?? {})).toBe("assistant");

		manager.appendMessage({ role: "user", content: "written immediately", timestamp: Date.now() });

		entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(4);
		expect(messageRole(entries[3] ?? {})).toBe("user");
		expect(messageContent(entries[3] ?? {})).toBe("written immediately");
	});

	it("keeps pre-assistant sessions out of history during shutdown", async () => {
		const cwd = makeTempDir("@pi-empty-session-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.flushSync();
		await manager.close();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		manager.flushSync();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);
	});

	it("lets explicit rewrites materialize pre-assistant entries", async () => {
		const cwd = makeTempDir("@pi-explicit-rewrite-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
		await manager.rewriteEntries();

		expect(fs.existsSync(sessionFile)).toBe(true);
		const entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(2);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageContent(entries[1] ?? {})).toBe("persist me");
	});
});
