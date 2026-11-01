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

	it("fails closed on structurally invalid JSONL entry objects without hiding explicit archives", async () => {
		const dir = TempDir.createSync("@veyyon-history-invalid-object-tail-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "title", v: 1, title: "Initial title", updatedAt: "2026-10-31T00:00:00Z", pad: "" },
				{ type: "session", id: "s-valid" },
				{ type: "message", id: "a", parentId: null, message: "root" },
				{ type: "message", id: "b", parentId: "a", message: "abandoned-only evidence" },
			];
			const prefix = records.map(record => JSON.stringify(record)).join("\n") + "\n";
			await fs.writeFile(file, prefix);
			const healthyRead = await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 200 });
			expect(healthyRead.status).toBe("ok");
			expect(healthyRead.leafId).toBe("b");
			expect((await searchStoredHistoryEntries(file, { query: "abandoned-only", limit: 5 })).status).toBe("ok");

			for (const invalid of [
				'{"type":"message"}',
				'{"type":"message","id":42}',
				'{"id":"new-tip"}',
				'{"type":"session"}',
				'{"type":"message","id":"invalid-parent-number","parentId":42}',
				'{"type":"message","id":"invalid-parent-boolean","parentId":false}',
				'{"type":"message","id":"invalid-parent-array","parentId":[]}',
				'{"type":"message","id":"invalid-parent-object","parentId":{}}',
				'{}',
			]) {
				await fs.writeFile(file, prefix + invalid + "\n");
				const implicitRead = await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 200 });
				expect(implicitRead.status).toBe("unavailable");
				expect(implicitRead.fragment).toBeUndefined();
				const implicitSearch = await searchStoredHistoryEntries(file, { query: "abandoned-only", limit: 5 });
				expect(implicitSearch.status).toBe("unavailable");
				expect(implicitSearch.matches).toEqual([]);
				const archivedRead = await readStoredHistoryEntry(file, {
					entryId: "b", leafId: "b", offset: 0, limit: 200,
				});
				expect(archivedRead.status).toBe("ok");
				expect(archivedRead.fragment).toContain("abandoned-only");
				const archivedSearch = await searchStoredHistoryEntries(file, {
					query: "abandoned-only", leafId: "b", limit: 5,
				});
				expect(archivedSearch.status).toBe("partial");
				expect(archivedSearch.matches.map(match => match.entryId)).toEqual(["b"]);
			}
		} finally {
			await dir.remove();
		}
	});


	it("refuses duplicate stored entry IDs even when the requested leaf is explicit", async () => {
		const dir = TempDir.createSync("@veyyon-history-duplicate-ids-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "s-unique" },
				{ type: "message", id: "a", parentId: null, message: "needle original ancestor" },
				{ type: "message", id: "b", parentId: "a", message: "needle archived sibling" },
				{ type: "message", id: "c", parentId: "a", message: "needle active leaf" },
			];
			const prefix = records.map(record => JSON.stringify(record)).join("\n") + "\n";
			await fs.writeFile(file, prefix);
			const validRead = await readStoredHistoryEntry(file, { entryId: "a", leafId: "c", offset: 0, limit: 256 });
			expect(validRead.status).toBe("ok");
			expect(validRead.fragment).toContain("needle original ancestor");
			const validSearch = await searchStoredHistoryEntries(file, { query: "needle", leafId: "c", limit: 5 });
			expect(validSearch.status).toBe("ok");
			expect(validSearch.matches.map(match => match.entryId)).toEqual(["c", "a"]);

			// A second physical record with an existing ID can forge text, ancestry,
			// or the selected leaf. Even leaf=c cannot uniquely identify the record.
			for (const duplicate of [
				{ type: "message", id: "a", parentId: "c", message: "needle forged ancestor" },
				{ type: "message", id: "b", parentId: "c", message: "needle forged sibling" },
				{ type: "message", id: "c", parentId: "b", message: "needle forged leaf" },
			]) {
				await fs.writeFile(file, prefix + JSON.stringify(duplicate) + "\n");
				for (const leafId of [undefined, "c"]) {
					const read = await readStoredHistoryEntry(file, { entryId: "a", leafId, offset: 0, limit: 256 });
					expect(read.status).toBe("unavailable");
					expect(read.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
			}
			const validContinuation = {
				type: "message", id: "d", parentId: "c", message: "needle distinct continuation",
			};
			await fs.writeFile(file, prefix + JSON.stringify(validContinuation) + "\n");
			const continued = await searchStoredHistoryEntries(file, { query: "needle", limit: 5 });
			expect(continued.status).toBe("ok");
			expect(continued.leafId).toBe("d");
			expect(continued.matches.map(match => match.entryId)).toEqual(["d", "c", "a"]);
		} finally {
			await dir.remove();
		}
	});

	it("refuses cyclic stored ancestry for implicit and explicit leaf selection", async () => {
		const dir = TempDir.createSync("@veyyon-history-cyclic-parents-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = { type: "session", id: "s-cycle" };
			const healthy = [
				{ type: "message", id: "root", parentId: null, message: "needle stable ancestor" },
				{ type: "message", id: "healthy", parentId: "root", message: "needle healthy branch" },
			];
			const write = async (tail: Array<{ type: string; id: string; parentId: string; message: string }>) => {
				await fs.writeFile(file, [header, ...healthy, ...tail].map(record => JSON.stringify(record)).join("\n") + "\n");
			};
			await write([]);
			expect((await readStoredHistoryEntry(file, { entryId: "root", offset: 0, limit: 256 })).status)
				.toBe("ok");
			expect((await searchStoredHistoryEntries(file, { query: "needle", limit: 5 })).matches
				.map(match => match.entryId)).toEqual(["healthy", "root"]);

			for (const cycle of [
				[{ type: "message", id: "self", parentId: "self", message: "needle self-parent" }],
				[
					{ type: "message", id: "a", parentId: "b", message: "needle first" },
					{ type: "message", id: "b", parentId: "a", message: "needle second" },
				],
				[
					{ type: "message", id: "a", parentId: "c", message: "needle first" },
					{ type: "message", id: "b", parentId: "a", message: "needle second" },
					{ type: "message", id: "c", parentId: "b", message: "needle third" },
				],
			]) {
				await write(cycle);
				const corruptLeaf = cycle[cycle.length - 1]!.id;
				for (const leafId of [undefined, corruptLeaf]) {
					const read = await readStoredHistoryEntry(file, {
						entryId: "root", leafId, offset: 0, limit: 256,
					});
					expect(read.status).toBe("unavailable");
					expect(read.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
				// An unrelated, explicitly selected valid archived branch remains readable.
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "healthy", offset: 0, limit: 256,
				});
				expect(archived.status).toBe("ok");
				const healthySearch = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "healthy", limit: 5,
				});
				expect(healthySearch.status).toBe("ok");
				expect(healthySearch.matches.map(match => match.entryId)).toEqual(["healthy", "root"]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("refuses dangling stored parent links without hiding a healthy archived branch", async () => {
		const dir = TempDir.createSync("@veyyon-history-dangling-ancestor-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			for (const parentId of ["missing-ancestor", ""]) {
				const records = [
					{ type: "session", id: "s-dangling" },
					{ type: "message", id: "root", parentId: null, message: "needle root" },
					{ type: "message", id: "archived", parentId: "root", message: "needle archived" },
					{ type: "message", id: "orphan", parentId, message: "needle ungrounded" },
				];
				await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
				for (const leafId of [undefined, "orphan"]) {
					const exact = await readStoredHistoryEntry(file, {
						entryId: "orphan", leafId, offset: 0, limit: 256,
					});
					expect(exact.status).toBe("unavailable");
					expect(exact.fragment).toBeUndefined();
					const ancestor = await readStoredHistoryEntry(file, {
						entryId: "root", leafId, offset: 0, limit: 256,
					});
					expect(ancestor.status).toBe("unavailable");
						expect(ancestor.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "archived", offset: 0, limit: 256,
				});
				expect(archived.status).toBe("ok");
				const healthySearch = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "archived", limit: 5,
				});
				expect(healthySearch.status).toBe("ok");
				expect(healthySearch.matches.map(match => match.entryId)).toEqual(["archived", "root"]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("does not certify explicit archived evidence when the 100,000-entry index is exhausted", async () => {
		const dir = TempDir.createSync("@veyyon-history-index-bound-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const lines = [
				JSON.stringify({ type: "session", id: "s-index-cap" }),
				JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle original evidence" }),
			];
			for (let i = 1; i < 100_000; i++) {
				lines.push(JSON.stringify({ type: "message", id: `entry-${i}`, parentId: "root", message: "other" }));
			}
			await fs.writeFile(file, lines.join("\n") + "\n");
			const valid = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(valid.status).toBe("ok");
			expect(valid.fragment).toContain("needle original evidence");

			// A 100,001st distinct entry is beyond the bounded ancestry index.
			// Accepting an explicit leaf would permit an unseen duplicate later.
			await fs.appendFile(file, JSON.stringify({
				type: "message", id: "out-of-index", parentId: "root", message: "needle extra",
			}) + "\n");
			for (const leafId of [undefined, "root"]) {
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId, offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
			await fs.appendFile(file, JSON.stringify({
				type: "message", id: "root", parentId: null, message: "needle forged duplicate",
			}) + "\n");
			const hiddenDuplicate = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(hiddenDuplicate.status).toBe("unavailable");
			expect(hiddenDuplicate.fragment).toBeUndefined();
		} finally {
			await dir.remove();
		}
	});

	it("does not return explicit archived content from a 128 MiB truncated scan", async () => {
		const dir = TempDir.createSync("@veyyon-history-byte-bound-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, [
				JSON.stringify({ type: "session", id: "s-byte-cap" }),
				JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle saved" }),
			].join("\n") + "\n");
			const valid = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(valid.status).toBe("ok");
			expect(valid.fragment).toContain("needle saved");

			// Extend only this disposable test file with a sparse, unterminated
			// tail beyond the real production byte cap (no session files touched).
			const handle = await fs.open(file, "r+");
			try {
				await handle.truncate(128 * 1024 * 1024 + 1);
			} finally {
				await handle.close();
			}
			const exact = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(exact.status).toBe("unavailable");
			expect(exact.fragment).toBeUndefined();
			const search = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "root", limit: 5,
			});
			expect(search.status).toBe("unavailable");
			expect(search.matches).toEqual([]);
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

