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
			const nextOffset = first.nextOffset;
			if (nextOffset === null || nextOffset === undefined) throw new Error("Expected another page");
			const second = await readStoredHistoryEntry(file, { ...query!, leafId: first.leafId, revision: first.revision, offset: nextOffset });
			expect(second.offset).toBe(nextOffset);
			const whole = JSON.stringify(records[3]);
			const parts: string[] = [];
			let offset = 0;
			while (true) {
				const read = await readStoredHistoryEntry(file, { ...query!, leafId: first.leafId, revision: first.revision, offset });
				expect(read.status).toBe("ok");
				parts.push(read.fragment!);
				if (read.nextOffset === null) break;
				offset = read.nextOffset!;
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
			const first = await readStoredHistoryEntry(file, { entryId: "emoji", offset: 0, limit: 1 });
			const read = await readStoredHistoryEntry(file, { entryId: "emoji", leafId: first.leafId, revision: first.revision, offset: index, limit: 1 });
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
				entryId: "same", leafId: first.leafId, offset: first.nextOffset!, limit: 24, revision: first.revision,
			});
			expect(same.status).toBe("ok");
			expect(same.revision).toBe(first.revision);
			await fs.writeFile(file, header + "\n" + JSON.stringify(rewritten) + "\n");
			const stale = await readStoredHistoryEntry(file, {
				entryId: "same", leafId: first.leafId, offset: first.nextOffset!, limit: 24, revision: first.revision,
			});
			expect(stale.status).toBe("stale");
			expect(stale.fragment).toBeUndefined();
			const fresh = await readStoredHistoryEntry(file, { entryId: "same", offset: 0, limit: 24 });
			expect(fresh.revision).not.toBe(first.revision);
			const offset = JSON.stringify(rewritten).indexOf("omega");
			const page = await readStoredHistoryEntry(file, {
				entryId: "same", leafId: fresh.leafId, offset, limit: 5, revision: fresh.revision,
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
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10&leaf=a&revision=short"))).toThrow(/SHA-256/);
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10&revision=short"))).toThrow(/SHA-256/);
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

	it("keeps matching ancestors despite 501 hits in an abandoned sibling", async () => {
		const dir = TempDir.createSync("@veyyon-history-sibling-cap-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records: Array<{ type: string; id: string; parentId?: string | null; message?: string }> = [
				{ type: "session", id: "s-branch" },
				{ type: "message", id: "root", parentId: null, message: "needle ancestor" },
			];
			for (let i = 0; i < 501; i++) {
				records.push({
					type: "message", id: `s${i}`, parentId: i === 0 ? "root" : `s${i - 1}`,
					message: `needle abandoned sibling ${i}`,
				});
			}
			records.push({ type: "message", id: "active", parentId: "root", message: "needle active" });
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const current = await searchStoredHistoryEntries(file, { query: "needle", limit: 5 });
			expect(current.status).toBe("ok");
			expect(current.leafId).toBe("active");
			expect(current.matches.map(match => match.entryId)).toEqual(["active", "root"]);
			const archived = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "s500", limit: 3,
			});
			expect(archived.status).toBe("partial");
			expect(archived.matches.map(match => match.entryId)).toEqual(["s500", "s499", "s498"]);
		} finally {
			await dir.remove();
		}
	});

	it("returns bounded partial results for more than 500 readable matches without losing the current leaf", async () => {
		const dir = TempDir.createSync("@veyyon-history-search-many-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records: Array<{ type: string; id: string; parentId?: string | null; message?: string }> = [
				{ type: "session", id: "s-many" },
			];
			for (let i = 0; i < 502; i++) {
				records.push({
					type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`,
					message: `needle record ${i}`,
				});
			}
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const result = await searchStoredHistoryEntries(file, { query: "needle", limit: 5 });
			expect(result.status).toBe("partial");
			expect(result.leafId).toBe("e501");
			expect(result.sessionId).toBe("s-many");
			expect(result.matches.map(match => match.entryId))
				.toEqual(["e501", "e500", "e499", "e498", "e497"]);
			expect((await readStoredHistoryEntry(file, { entryId: "e501", offset: 0, limit: 100 })).status)
				.toBe("ok");
		} finally {
			await dir.remove();
		}
	});

	it("does not infer an abandoned branch when a later oversized record was skipped", async () => {
		const dir = TempDir.createSync("@veyyon-history-oversized-tail-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "s1" },
				{ type: "message", id: "a", parentId: null, message: "root" },
				{ type: "message", id: "b", parentId: "a", message: "branchb-only abandoned sibling" },
				{ type: "message", id: "c", parentId: "a", message: "x".repeat(8 * 1024 * 1024) },
			];
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const defaultRead = await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 100 });
			expect(defaultRead.status).toBe("unavailable");
			expect(defaultRead.fragment).toBeUndefined();
			const defaultSearch = await searchStoredHistoryEntries(file, { query: "branchb-only", limit: 10 });
			expect(defaultSearch.status).toBe("unavailable");
			expect(defaultSearch.matches).toEqual([]);
			// Deliberate archival selection stays available; the query remains partial
			// because the large record itself could not be inspected.
			const explicitRead = await readStoredHistoryEntry(file, { entryId: "b", leafId: "b", offset: 0, limit: 100 });
			expect(explicitRead.status).toBe("ok");
			const explicitSearch = await searchStoredHistoryEntries(file, {
				query: "branchb-only", leafId: "b", limit: 10,
			});
			expect(explicitSearch.status).toBe("partial");
			expect(explicitSearch.matches.map(match => match.entryId)).toEqual(["b"]);
		} finally {
			await dir.remove();
		}
	});

	it("refuses implicit branch selection after an unreadable final JSONL record", async () => {
		const dir = TempDir.createSync("@veyyon-history-broken-tail-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const valid = [
				{ type: "session", id: "s1" },
				{ type: "message", id: "a", parentId: null, message: "root" },
				{ type: "message", id: "b", parentId: "a", message: "old sibling" },
			];
			await fs.writeFile(file, valid.map(record => JSON.stringify(record)).join("\n") +
				'\n{"type":"message","id":bad}\n');
			expect((await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 200 })).status)
				.toBe("unavailable");
			const search = await searchStoredHistoryEntries(file, { query: "old sibling", limit: 10 });
			expect(search.status).toBe("unavailable");
			expect(search.matches).toEqual([]);
			expect((await readStoredHistoryEntry(file, { entryId: "b", leafId: "b", offset: 0, limit: 200 })).status)
				.toBe("ok");
		} finally {
			await dir.remove();
		}
	});

	it("refuses non-JSON corruption after records without rejecting initial titles or blanks", async () => {
		const dir = TempDir.createSync("@veyyon-history-nonjson-tail-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "s1" },
				{ type: "message", id: "a", parentId: null, message: "root" },
				{ type: "message", id: "b", parentId: "a", message: "archived-branch-only" },
			];
			await fs.writeFile(file, ["Optional title", "", ...records.map(record => JSON.stringify(record)), ""].join("\n") + "\n");
			// Initial title and blank lines must not spoil valid implicit selection.
			expect((await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 100 })).status)
				.toBe("ok");
			const healthy = await searchStoredHistoryEntries(file, { query: "archived-branch-only", limit: 5 });
			expect(healthy.status).toBe("ok");
			expect(healthy.matches.map(match => match.entryId)).toEqual(["b"]);

			await fs.appendFile(file, "NOT-JSON\n");
			const implicitRead = await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 100 });
			expect(implicitRead.status).toBe("unavailable");
			expect(implicitRead.fragment).toBeUndefined();
			const implicitSearch = await searchStoredHistoryEntries(file, { query: "archived-branch-only", limit: 5 });
			expect(implicitSearch.status).toBe("unavailable");
			expect(implicitSearch.matches).toEqual([]);

			// Deliberately selected historic branch stays readable; search is partial.
			const explicitRead = await readStoredHistoryEntry(file, {
				entryId: "b", leafId: "b", offset: 0, limit: 100,
			});
			expect(explicitRead.status).toBe("ok");
			const explicitSearch = await searchStoredHistoryEntries(file, {
				query: "archived-branch-only", leafId: "b", limit: 5,
			});
			expect(explicitSearch.status).toBe("partial");
			expect(explicitSearch.matches.map(match => match.entryId)).toEqual(["b"]);
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

