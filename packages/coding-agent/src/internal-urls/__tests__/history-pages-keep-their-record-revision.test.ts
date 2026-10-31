/**
 * WHY: joining pages across a rewrite invents a transcript that never existed.
 * These fixtures exercise stored and live revisions, branch changes and the URL
 * parser. They do not prove artifact durability or model recall quality.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { parseExactHistoryRequest, readLiveHistoryEntry, readStoredHistoryEntry, searchStoredHistoryEntries } from "../history-exact";
import { HistoryProtocolHandler } from "../history-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

describe("exact history pages keep their record revision", () => {
	it("refuses changed bytes and keeps a pinned page valid across unrelated appends", async () => {
		const dir = TempDir.createSync("@veyyon-history-revisions-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s" });
			const record = { type: "message", id: "a", parentId: null, message: "before 🔑" };
			const raw = JSON.stringify(record);
			await fs.writeFile(file, `${header}\n${raw}\n`);
			const first = await readStoredHistoryEntry(file, { entryId: "a", offset: 0, limit: 20 });
			const request = { entryId: "a", leafId: first.leafId, revision: first.revision, offset: first.nextOffset!, limit: 1000 };
			await fs.appendFile(file, JSON.stringify({ type: "message", id: "b", parentId: "a", message: "later" }) + "\n");
			const second = await readStoredHistoryEntry(file, request);
			expect(first.fragment! + second.fragment!).toBe(raw);
			expect(second.revision).toBe(first.revision);
			const search = await searchStoredHistoryEntries(file, { query: "before", leafId: "a", limit: 5 });
			expect(search.matches[0]?.revision).toBe(first.revision);
			await fs.writeFile(file, `${header}\n${JSON.stringify({ ...record, message: "after 🔑" })}\n`);
			const stale = await readStoredHistoryEntry(file, request);
			expect(stale.status).toBe("stale");
			expect(stale.fragment).toBeUndefined();
			const refreshed = await readStoredHistoryEntry(file, { entryId: "a", offset: 0, limit: 1000 });
			expect(refreshed.fragment).toBe(JSON.stringify({ ...record, message: "after 🔑" }));
			expect(refreshed.revision).not.toBe(first.revision);
		} finally {
			await dir.remove();
		}
	});

	it("binds live revisions to the selected branch leaf", () => {
		const manager = SessionManager.inMemory("/repo");
		const a = manager.appendMessage({ role: "user", content: "first", timestamp: 0 });
		const b = manager.appendMessage({ role: "user", content: "second", timestamp: 1 });
		const first = readLiveHistoryEntry(manager.getBranch(), { entryId: a, leafId: a, offset: 0, limit: 10 });
		const changed = readLiveHistoryEntry(manager.getBranch(), {
			entryId: a, leafId: b, offset: 10, limit: 10, revision: first.revision,
		});
		expect(changed.status).toBe("stale");
		expect(changed.fragment).toBeUndefined();
	});

	it("distinguishes an unreadable file from missing evidence and skips an oversized line", async () => {
		const dir = TempDir.createSync("@veyyon-history-bounds-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const absent = await readStoredHistoryEntry(file, { entryId: "a", offset: 0, limit: 100 });
			expect(absent.status).toBe("unavailable");
			expect((await searchStoredHistoryEntries(file, { query: "needle", limit: 2 })).status).toBe("unavailable");
			await fs.writeFile(file, JSON.stringify({ type: "session", id: "s" }) + "\n");
			const tooLarge = JSON.stringify({ type: "message", id: "large", message: "x".repeat(8 * 1024 * 1024) });
			const raw = JSON.stringify({ type: "message", id: "a", parentId: null, message: "needle 🔑" });
			await fs.appendFile(file, `${tooLarge}\n${raw}\n`);
			expect((await readStoredHistoryEntry(file, { entryId: "a", leafId: "a", offset: 0, limit: 1000 })).fragment).toBe(raw);
			expect((await readStoredHistoryEntry(file, { entryId: "large", offset: 0, limit: 100 })).status).toBe("unavailable");
			const searched = await searchStoredHistoryEntries(file, { query: "needle", leafId: "a", limit: 2 });
			expect(searched.status).toBe("partial");
			expect(searched.matches.map(match => match.entryId)).toEqual(["a"]);
		} finally {
			await dir.remove();
		}
	});

	it("defaults a live persisted agent to its active branch instead of the newest disk sibling", async () => {
		const dir = TempDir.createSync("@veyyon-history-selected-leaf-");
		const manager = SessionManager.create("/repo", dir.path());
		try {
			const a = manager.appendMessage({ role: "user", content: "branch alpha", timestamp: 0 });
			manager.appendMessage({ role: "user", content: "branch beta", timestamp: 1 });
			// The lazy session writer materializes on an assistant entry. Without this,
			// the handler could take its live-only path and never inspect the disk sibling.
			manager.appendMessage({
				role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture",
				content: [{ type: "text", text: "Persist branch beta." }], stopReason: "stop", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			});
			await manager.flush();
			const persistedFile = manager.getSessionFile();
			if (!persistedFile) throw new Error("Expected a persisted session fixture");
			await fs.access(persistedFile);
			manager.branch(a);
			AgentRegistry.global().register({
				id: "Scout", displayName: "scout", kind: "main", scope: "s",
				session: { sessionManager: manager } as AgentSession,
				sessionFile: manager.getSessionFile() ?? null,
			});
			const resource = await new HistoryProtocolHandler().resolve(new URL(`history://Scout?entry=${a}`) as never);
			expect(JSON.parse(resource.content).leafId).toBe(a);
			const search = await new HistoryProtocolHandler().resolve(new URL("history://Scout?q=branch") as never);
			expect(JSON.parse(search.content).matches.map((match: { entryId: string }) => match.entryId)).toEqual([a]);
		} finally {
			await manager.close();
			await dir.remove();
		}
	});

	it("rejects unpinned continuation offsets and malformed revision tokens", () => {
		for (const query of ["offset=1", "offset=1&leaf=a", "revision=bad", "revision=" + "a".repeat(65)]) {
			expect(() => parseExactHistoryRequest(new URL(`history://Scout?entry=a&${query}`))).toThrow();
		}
		const request = parseExactHistoryRequest(new URL(`history://Scout?entry=a&leaf=a&offset=1&revision=${"a".repeat(64)}`));
		expect(request?.revision).toBe("a".repeat(64));
	});
});
