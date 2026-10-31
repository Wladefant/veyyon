import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import {
	parseExactHistoryRequest,
	readLiveHistoryEntry,
	readStoredHistoryEntry,
	parseHistorySearchRequest,
	searchStoredHistoryEntries,
} from "../history-exact";

describe("history exact record lookup", () => {
	it("reads exact text in bounded Unicode pages with stable record and branch IDs", async () => {
		const dir = TempDir.createSync("@veyyon-history-exact-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "session-1" },
				{ type: "message", id: "a", parentId: null, message: "first" },
				{ type: "message", id: "b", parentId: "a", message: "sibling branch" },
				{ type: "message", id: "c", parentId: "a", message: "exact 🔑  line\\nsecond line" },
			];
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const query = parseExactHistoryRequest(new URL("history://Scout?entry=c&limit=17"));
			expect(query).toBeDefined();
			const first = await readStoredHistoryEntry(file, query!);
			expect(first.status).toBe("ok");
			expect(first.entryId).toBe("c");
			expect(first.leafId).toBe("c");
			expect(first.sessionId).toBe("session-1");
			expect(Array.from(first.fragment ?? "").length).toBeLessThanOrEqual(17);
			const second = await readStoredHistoryEntry(file, { ...query!, offset: first.nextOffset!, revision: first.revision });
			expect(second.offset).toBe(first.nextOffset);
			const whole = JSON.stringify(records[3]);
			const parts: string[] = [];
			let offset = 0;
			let revision = first.revision;
			while (true) {
				const read = await readStoredHistoryEntry(file, { ...query!, offset, revision });
				expect(read.status).toBe("ok");
				parts.push(read.fragment!);
				if (read.nextOffset === null) break;
				offset = read.nextOffset!;
				revision = read.revision;
			}
			expect(parts.join("")).toBe(whole);
			// Sibling history must not be returned by a default-current-branch read.
			expect((await readStoredHistoryEntry(file, { ...query!, entryId: "b" })).status).toBe("not_on_branch");
			const sibling = await readStoredHistoryEntry(file, { ...query!, entryId: "b", leafId: "b", limit: 1000 });
			expect(sibling.status).toBe("ok");
			expect(sibling.fragment).toContain("sibling");
		} finally {
			await dir.remove();
		}
	});

	it("preserves a whole Unicode code point at a page boundary", async () => {
		const dir = TempDir.createSync("@veyyon-history-unicode-");
		try {
			const record = { type: "message", id: "emoji", parentId: null, message: "x🔑y" };
			const raw = JSON.stringify(record);
			const index = Array.from(raw).indexOf("🔑");
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, JSON.stringify({ type: "session", id: "s" }) + "\n" + raw + "\n");
			const first = await readStoredHistoryEntry(file, { entryId: "emoji", offset: 0, limit: index });
			const read = await readStoredHistoryEntry(file, { entryId: "emoji", offset: index, limit: 1, revision: first.revision });
			expect(read.fragment).toBe("🔑");
			expect(read.nextOffset).toBe(index + 1);
		} finally {
			await dir.remove();
		}
	});


	it("rejects continuation after a same-ID record rewrite", async () => {
		const dir = TempDir.createSync("@veyyon-history-revision-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s1" });
			const firstRecord = { type: "message", id: "same", parentId: null, message: "alpha".repeat(12) };
			const rewritten = { ...firstRecord, message: "omega".repeat(12) };
			await fs.writeFile(file, header + "\n" + JSON.stringify(firstRecord) + "\n");
			const first = await readStoredHistoryEntry(file, { entryId: "same", offset: 0, limit: 24 });
			expect(first.status).toBe("ok");
			expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
			const same = await readStoredHistoryEntry(file, {
				entryId: "same", offset: first.nextOffset!, limit: 24, revision: first.revision,
			});
			expect(same.status).toBe("ok");
			expect(same.revision).toBe(first.revision);
			await fs.writeFile(file, header + "\n" + JSON.stringify(rewritten) + "\n");
			const stale = await readStoredHistoryEntry(file, {
				entryId: "same", offset: first.nextOffset!, limit: 24, revision: first.revision,
			});
			expect(stale.status).toBe("stale");
			expect(stale.fragment).toBeUndefined();
			const fresh = await readStoredHistoryEntry(file, { entryId: "same", offset: 0, limit: 24 });
			expect(fresh.revision).not.toBe(first.revision);
			const offset = JSON.stringify(rewritten).indexOf("omega");
			const page = await readStoredHistoryEntry(file, {
				entryId: "same", offset, limit: 5, revision: fresh.revision,
			});
			expect(page.fragment).toBe("omega");
		} finally {
			await dir.remove();
		}
	});

	it("does not invent missing records or make them look like exact evidence", async () => {
		const dir = TempDir.createSync("@veyyon-history-missing-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, JSON.stringify({ type: "session", id: "s" }) + "\n");
			const found = await readStoredHistoryEntry(file, { entryId: "gone", offset: 0, limit: 8 });
			expect(found.status).toBe("missing");
			expect(found.fragment).toBeUndefined();
			const corrupted = path.join(dir.path(), "corrupted.jsonl");
			await fs.writeFile(corrupted, '{"type":"message","id":bad}\n');
			expect((await readStoredHistoryEntry(corrupted, { entryId: "gone", offset: 0, limit: 8 })).status)
				.toBe("unavailable");
		} finally {
			await dir.remove();
		}
	});

	it("uses the active branch for non-persistent sessions", () => {
		const branch = [
			{ type: "message", id: "a", message: { role: "user", content: "hello" } },
			{ type: "message", id: "b", message: { role: "user", content: "world" } },
		] as unknown as SessionEntry[];
		const read = readLiveHistoryEntry(branch, { entryId: "a", offset: 0, limit: 1000 });
		expect(read.status).toBe("ok");
		expect(read.fragment).toContain("hello");
		expect(readLiveHistoryEntry(branch, { entryId: "b", leafId: "a", offset: 0, limit: 1000 }).status)
			.toBe("not_on_branch");
	});

	it("rejects malformed page IDs and unbounded reads", () => {
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=../secret"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&limit=999999"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=-1"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10"))).toThrow(/rev/);
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10&rev=short"))).toThrow(/SHA-256/);
		expect(parseExactHistoryRequest(new URL("history://Scout"))).toBeUndefined();
	});
	it("finds stored evidence IDs on the selected branch and returns newest matches first", async () => {
		const dir = TempDir.createSync("@veyyon-history-search-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "s1" },
				{ type: "message", id: "a", parentId: null, message: "early decision: project atlas" },
				{ type: "message", id: "b", parentId: "a", message: "project atlas sibling" },
				{ type: "message", id: "c", parentId: "a", message: "later correction: project atlas" },
			];
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const request = parseHistorySearchRequest(new URL("history://Scout?q=project%20atlas&limit=5"))!;
			const result = await searchStoredHistoryEntries(file, request);
			expect(result.status).toBe("ok");
			expect(result.sessionId).toBe("s1");
			expect(result.matches.map(match => match.entryId)).toEqual(["c", "a"]);
			expect(result.matches[0]?.preview).toContain("later correction");
			const sibling = await searchStoredHistoryEntries(file, { ...request, leafId: "b" });
			expect(sibling.matches.map(match => match.entryId)).toEqual(["b", "a"]);
		} finally {
			await dir.remove();
		}
	});

	it("rejects malformed search queries without suppressing ordinary letters and digits", () => {
		expect(parseHistorySearchRequest(new URL("history://Scout?q=x0file"))?.query).toBe("x0file");
		expect(() => parseHistorySearchRequest(new URL("history://Scout?q=one&entry=two"))).toThrow();
		expect(() => parseHistorySearchRequest(new URL("history://Scout?q=a"))).toThrow();
		expect(() => parseHistorySearchRequest(new URL("history://Scout?q=thing&limit=999"))).toThrow();
	});
});
