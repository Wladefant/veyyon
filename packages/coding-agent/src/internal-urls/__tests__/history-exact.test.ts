import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { TempDir } from "@veyyon/utils";
import {
	parseExactHistoryRequest,
	parseHistorySearchRequest,
	readLiveHistoryEntry,
	readStoredHistoryEntry,
	searchLiveHistoryEntries,
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
			const second = await readStoredHistoryEntry(file, {
				...query!,
				leafId: first.leafId,
				revision: first.revision,
				offset: nextOffset,
			});
			expect(second.offset).toBe(nextOffset);
			const whole = JSON.stringify(records[3]);
			const parts: string[] = [];
			let offset = 0;
			while (true) {
				const read = await readStoredHistoryEntry(file, {
					...query!,
					leafId: first.leafId,
					revision: first.revision,
					offset,
				});
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
			const read = await readStoredHistoryEntry(file, {
				entryId: "emoji",
				leafId: first.leafId,
				revision: first.revision,
				offset: index,
				limit: 1,
			});
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
				entryId: "same",
				leafId: first.leafId,
				offset: first.nextOffset!,
				limit: 24,
				revision: first.revision,
			});
			expect(same.status).toBe("ok");
			expect(same.revision).toBe(first.revision);
			await fs.writeFile(file, header + "\n" + JSON.stringify(rewritten) + "\n");
			const stale = await readStoredHistoryEntry(file, {
				entryId: "same",
				leafId: first.leafId,
				offset: first.nextOffset!,
				limit: 24,
				revision: first.revision,
			});
			expect(stale.status).toBe("stale");
			expect(stale.fragment).toBeUndefined();
			const fresh = await readStoredHistoryEntry(file, { entryId: "same", offset: 0, limit: 24 });
			expect(fresh.revision).not.toBe(first.revision);
			const offset = JSON.stringify(rewritten).indexOf("omega");
			const page = await readStoredHistoryEntry(file, {
				entryId: "same",
				leafId: fresh.leafId,
				offset,
				limit: 5,
				revision: fresh.revision,
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
			expect((await readStoredHistoryEntry(corrupted, { entryId: "gone", offset: 0, limit: 8 })).status).toBe(
				"unavailable",
			);
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
		expect(readLiveHistoryEntry(branch, { entryId: "b", leafId: "a", offset: 0, limit: 1000 }).status).toBe(
			"not_on_branch",
		);
	});

	it("rejects malformed page IDs and unbounded reads", () => {
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=../secret"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&limit=999999"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=-1"))).toThrow();
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10"))).toThrow(/rev/);
		expect(() =>
			parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10&leaf=a&revision=short")),
		).toThrow(/SHA-256/);
		expect(() => parseExactHistoryRequest(new URL("history://Scout?entry=a&offset=10&revision=short"))).toThrow(
			/SHA-256/,
		);
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

	it("keeps case-fold-expanding Unicode matches visible in stored JSONL previews", async () => {
		const dir = TempDir.createSync("@veyyon-history-unicode-preview-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const records = [
				{ type: "session", id: "s-preview" },
				{
					type: "message", id: "unicode", parentId: null,
					message: "İ".repeat(100) + " NeedLe archived",
				},
				{ type: "message", id: "plain", parentId: "unicode", message: "Plain ASCII NeedLe" },
			];
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const request = parseHistorySearchRequest(new URL("history://Scout?q=needle&leaf=plain&limit=2"))!;
			const found = await searchStoredHistoryEntries(file, request);
			expect(found.status).toBe("ok");
			expect(found.matches.map(match => match.entryId)).toEqual(["plain", "unicode"]);
			for (const match of found.matches) {
				expect(match.preview).toContain("NeedLe");
				expect(match.preview.length).toBeLessThanOrEqual(200);
				expect(match.revision).toMatch(/^[0-9a-f]{64}$/);
			}
			// Search previews are not evidence substitutions; exact reads remain byte-preserving.
			const exact = await readStoredHistoryEntry(file, {
				entryId: "unicode", leafId: "plain", offset: 0, limit: 1000,
			});
			expect(exact.status).toBe("ok");
			expect(exact.fragment).toBe(JSON.stringify(records[1]));
		} finally {
			await dir.remove();
		}
	});

	it("keeps Unicode and ordinary mixed-case matches visible in live branch previews", () => {
		const branch = [
			{
				type: "message", id: "unicode", parentId: null,
				message: { role: "user", content: "İ".repeat(100) + " NeedLe live" },
			},
			{
				type: "message", id: "plain", parentId: "unicode",
				message: { role: "assistant", content: "ASCII NeedLe live" },
			},
		] as unknown as SessionEntry[];
		const found = searchLiveHistoryEntries(branch, { query: "needle", limit: 2 });
		expect(found.status).toBe("ok");
		expect(found.matches.map(match => match.entryId)).toEqual(["plain", "unicode"]);
		for (const match of found.matches) {
			expect(match.preview).toContain("NeedLe");
			expect(match.preview.length).toBeLessThanOrEqual(200);
		}
	});

	it("does not split surrogate pairs at search-preview boundaries", () => {
		const cases = [
			{ before: "🔑" + "x".repeat(69), after: "x".repeat(40) },
			{ before: "x".repeat(70), after: "x".repeat(49) + "🔑" + "x".repeat(40) },
		];
		for (const { before, after } of cases) {
			const branch = [
				{
					type: "message", id: "boundary", parentId: null,
					message: { role: "user", content: before + "N".repeat(80) + after },
				},
			] as unknown as SessionEntry[];
			const found = searchLiveHistoryEntries(branch, { query: "n".repeat(80), limit: 1 });
			expect(found.status).toBe("ok");
			expect(found.matches).toHaveLength(1);
			const preview = found.matches[0]!.preview;
			expect(preview).toContain("N".repeat(80));
			expect(preview.length).toBeLessThanOrEqual(200);
			const first = preview.charCodeAt(0);
			const last = preview.charCodeAt(preview.length - 1);
			expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		}
	});


	it("shows the entire allowed 180-character query without exceeding the preview cap", () => {
		const match = "N".repeat(180);
		const branch = [
			{
				type: "message", id: "long-query", parentId: null,
				message: { role: "user", content: "prefix ".repeat(18) + match + " suffix" },
			},
		] as unknown as SessionEntry[];
		const found = searchLiveHistoryEntries(branch, { query: match.toLowerCase(), limit: 1 });
		expect(found.status).toBe("ok");
		expect(found.matches).toHaveLength(1);
		expect(found.matches[0]!.preview).toContain(match);
		expect(found.matches[0]!.preview.length).toBeLessThanOrEqual(200);
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
					type: "message",
					id: `s${i}`,
					parentId: i === 0 ? "root" : `s${i - 1}`,
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
				query: "needle",
				leafId: "s500",
				limit: 3,
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
					type: "message",
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					message: `needle record ${i}`,
				});
			}
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const result = await searchStoredHistoryEntries(file, { query: "needle", limit: 5 });
			expect(result.status).toBe("partial");
			expect(result.leafId).toBe("e501");
			expect(result.sessionId).toBe("s-many");
			expect(result.matches.map(match => match.entryId)).toEqual(["e501", "e500", "e499", "e498", "e497"]);
			expect((await readStoredHistoryEntry(file, { entryId: "e501", offset: 0, limit: 100 })).status).toBe("ok");
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
				query: "branchb-only",
				leafId: "b",
				limit: 10,
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
			await fs.writeFile(
				file,
				valid.map(record => JSON.stringify(record)).join("\n") + '\n{"type":"message","id":bad}\n',
			);
			expect((await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 200 })).status).toBe(
				"unavailable",
			);
			const search = await searchStoredHistoryEntries(file, { query: "old sibling", limit: 10 });
			expect(search.status).toBe("unavailable");
			expect(search.matches).toEqual([]);
			expect((await readStoredHistoryEntry(file, { entryId: "b", leafId: "b", offset: 0, limit: 200 })).status).toBe(
				"ok",
			);
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
			await fs.writeFile(
				file,
				["Optional title", "", ...records.map(record => JSON.stringify(record)), ""].join("\n") + "\n",
			);
			// Initial title and blank lines must not spoil valid implicit selection.
			expect((await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 100 })).status).toBe("ok");
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
				entryId: "b",
				leafId: "b",
				offset: 0,
				limit: 100,
			});
			expect(explicitRead.status).toBe("ok");
			const explicitSearch = await searchStoredHistoryEntries(file, {
				query: "archived-branch-only",
				leafId: "b",
				limit: 5,
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
				'{"type":"message","id":"invalid-parent-number","parentId":42}',
				'{"type":"message","id":"invalid-parent-boolean","parentId":false}',
				'{"type":"message","id":"invalid-parent-array","parentId":[]}',
				'{"type":"message","id":"invalid-parent-object","parentId":{}}',
				"{}",
			]) {
				await fs.writeFile(file, prefix + invalid + "\n");
				const implicitRead = await readStoredHistoryEntry(file, { entryId: "b", offset: 0, limit: 200 });
				expect(implicitRead.status).toBe("unavailable");
				expect(implicitRead.fragment).toBeUndefined();
				const implicitSearch = await searchStoredHistoryEntries(file, { query: "abandoned-only", limit: 5 });
				expect(implicitSearch.status).toBe("unavailable");
				expect(implicitSearch.matches).toEqual([]);
				const archivedRead = await readStoredHistoryEntry(file, {
					entryId: "b",
					leafId: "b",
					offset: 0,
					limit: 200,
				});
				expect(archivedRead.status).toBe("ok");
				expect(archivedRead.fragment).toContain("abandoned-only");
				const archivedSearch = await searchStoredHistoryEntries(file, {
					query: "abandoned-only",
					leafId: "b",
					limit: 5,
				});
				expect(archivedSearch.status).toBe("partial");
				expect(archivedSearch.matches.map(match => match.entryId)).toEqual(["b"]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("search never presents rejected JSONL records as accepted branch evidence", async () => {
		const dir = TempDir.createSync("@veyyon-history-search-rejected-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = { type: "session", id: "s-evidence" };
			const root = { type: "message", id: "root", parentId: null, message: "trusted atlas evidence" };
			const leaf = { type: "message", id: "leaf", parentId: "root", message: "ordinary continuation" };
			const prefix = [header, root, leaf].map(record => JSON.stringify(record)).join("\n") + "\n";
			for (const invalid of [
				{ type: "message", id: "root", parentId: 42, message: "forged needle from corrupt parent" },
				{ type: "message", id: "root", parentId: [], message: "forged needle from corrupt parent" },
			]) {
				await fs.writeFile(file, prefix + JSON.stringify(invalid) + "\n");
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root",
					leafId: "leaf",
					offset: 0,
					limit: 256,
				});
				// Invalid-parent siblings are still physical duplicate ID claims.
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const forged = await searchStoredHistoryEntries(file, {
					query: "forged needle",
					leafId: "leaf",
					limit: 5,
				});
				expect(forged.status).toBe("unavailable");
				expect(forged.matches).toEqual([]);
				const trusted = await searchStoredHistoryEntries(file, {
					query: "trusted atlas",
					leafId: "leaf",
					limit: 5,
				});
				expect(trusted.status).toBe("unavailable");
				expect(trusted.matches).toEqual([]);
			}

			// The first-pass title-slot exception must also apply to matching.
			const title = { type: "title", id: "root", title: "forged needle in metadata" };
			await fs.writeFile(file, [title, header, root, leaf].map(record => JSON.stringify(record)).join("\n") + "\n");
			const forgedTitle = await searchStoredHistoryEntries(file, {
				query: "forged needle",
				leafId: "leaf",
				limit: 5,
			});
			expect(forgedTitle.status).toBe("ok");
			expect(forgedTitle.matches).toEqual([]);
			const accepted = await searchStoredHistoryEntries(file, {
				query: "trusted atlas",
				leafId: "leaf",
				limit: 5,
			});
			expect(accepted.status).toBe("ok");
			expect(accepted.matches.map(match => match.entryId)).toEqual(["root"]);
			const exact = await readStoredHistoryEntry(file, {
				entryId: "root",
				leafId: "leaf",
				offset: 0,
				limit: 256,
			});
			expect(exact.status).toBe("ok");
			expect(accepted.matches[0]!.revision).toBe(exact.revision!);

			const nested = {
				...root,
				message: { id: "nested", type: "message", content: [{ type: "text", text: "trusted atlas" }] },
			};
			const titleChange = { type: "title_change", id: "renamed", parentId: "root", title: "updated title" };
			await fs.writeFile(
				file,
				[title, header, nested, titleChange].map(record => JSON.stringify(record)).join("\n") + "\n",
			);
			const nestedRead = await readStoredHistoryEntry(file, { entryId: "root", offset: 0, limit: 256 });
			expect(nestedRead.status).toBe("ok");
			expect(nestedRead.fragment).toContain("trusted atlas");
			const titleRead = await readStoredHistoryEntry(file, { entryId: "renamed", offset: 0, limit: 256 });
			expect(titleRead.status).toBe("ok");
			expect(titleRead.recordType).toBe("title_change");
			const nestedSearch = await searchStoredHistoryEntries(file, { query: "trusted atlas", limit: 5 });
			expect(nestedSearch.status).toBe("ok");
			expect(nestedSearch.matches.map(match => match.entryId)).toEqual(["root"]);
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
				type: "message",
				id: "d",
				parentId: "c",
				message: "needle distinct continuation",
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
				await fs.writeFile(
					file,
					[header, ...healthy, ...tail].map(record => JSON.stringify(record)).join("\n") + "\n",
				);
			};
			await write([]);
			expect((await readStoredHistoryEntry(file, { entryId: "root", offset: 0, limit: 256 })).status).toBe("ok");
			expect(
				(await searchStoredHistoryEntries(file, { query: "needle", limit: 5 })).matches.map(match => match.entryId),
			).toEqual(["healthy", "root"]);

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
						entryId: "root",
						leafId,
						offset: 0,
						limit: 256,
					});
					expect(read.status).toBe("unavailable");
					expect(read.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
				// An unrelated, explicitly selected valid archived branch remains readable.
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root",
					leafId: "healthy",
					offset: 0,
					limit: 256,
				});
				expect(archived.status).toBe("ok");
				const healthySearch = await searchStoredHistoryEntries(file, {
					query: "needle",
					leafId: "healthy",
					limit: 5,
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
						entryId: "orphan",
						leafId,
						offset: 0,
						limit: 256,
					});
					expect(exact.status).toBe("unavailable");
					expect(exact.fragment).toBeUndefined();
					const ancestor = await readStoredHistoryEntry(file, {
						entryId: "root",
						leafId,
						offset: 0,
						limit: 256,
					});
					expect(ancestor.status).toBe("unavailable");
					expect(ancestor.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root",
					leafId: "archived",
					offset: 0,
					limit: 256,
				});
				expect(archived.status).toBe("ok");
				const healthySearch = await searchStoredHistoryEntries(file, {
					query: "needle",
					leafId: "archived",
					limit: 5,
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
				entryId: "root",
				leafId: "root",
				offset: 0,
				limit: 256,
			});
			expect(valid.status).toBe("ok");
			expect(valid.fragment).toContain("needle original evidence");

			// A 100,001st distinct entry is beyond the bounded ancestry index.
			// Accepting an explicit leaf would permit an unseen duplicate later.
			await fs.appendFile(
				file,
				JSON.stringify({
					type: "message",
					id: "out-of-index",
					parentId: "root",
					message: "needle extra",
				}) + "\n",
			);
			for (const leafId of [undefined, "root"]) {
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root",
					leafId,
					offset: 0,
					limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, { query: "needle", leafId, limit: 5 });
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
			await fs.appendFile(
				file,
				JSON.stringify({
					type: "message",
					id: "root",
					parentId: null,
					message: "needle forged duplicate",
				}) + "\n",
			);
			const hiddenDuplicate = await readStoredHistoryEntry(file, {
				entryId: "root",
				leafId: "root",
				offset: 0,
				limit: 256,
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
			await fs.writeFile(
				file,
				[
					JSON.stringify({ type: "session", id: "s-byte-cap" }),
					JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle saved" }),
				].join("\n") + "\n",
			);
			const valid = await readStoredHistoryEntry(file, {
				entryId: "root",
				leafId: "root",
				offset: 0,
				limit: 256,
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
				entryId: "root",
				leafId: "root",
				offset: 0,
				limit: 256,
			});
			expect(exact.status).toBe("unavailable");
			expect(exact.fragment).toBeUndefined();
			const search = await searchStoredHistoryEntries(file, {
				query: "needle",
				leafId: "root",
				limit: 5,
			});
			expect(search.status).toBe("unavailable");
			expect(search.matches).toEqual([]);
		} finally {
			await dir.remove();
		}
	});

	it.each([
		[
			"repeated same session header",
			[
				{ type: "session", id: "s" },
				{ type: "session", id: "s" },
			],
		],
		[
			"repeated different session header",
			[
				{ type: "session", id: "s" },
				{ type: "session", id: "other" },
			],
		],
		[
			"entry before session header",
			[
				{ type: "message", id: "root", parentId: null, message: "forged needle" },
				{ type: "session", id: "s" },
			],
		],
		["missing session header", [{ type: "message", id: "root", parentId: null, message: "forged needle" }]],
	] as const)("rejects %s for implicit read and search", async (_name, records) => {
		const dir = TempDir.createSync("@veyyon-history-header-shape-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
			const read = await readStoredHistoryEntry(file, { entryId: "root", offset: 0, limit: 256 });
			expect(read.status).toBe("unavailable");
			expect(read.fragment).toBeUndefined();
			const search = await searchStoredHistoryEntries(file, { query: "forged needle", limit: 5 });
			expect(search.status).toBe("unavailable");
			expect(search.matches).toEqual([]);
		} finally {
			await dir.remove();
		}
	});

	it.each([
		[
			"repeated leading title",
			[
				{ type: "title", title: "first title" },
				{ type: "title", title: "second title" },
				{ type: "session", id: "s" },
				{ type: "message", id: "root", parentId: null, message: "trusted atlas" },
			],
		],
		[
			"late id-bearing title",
			[
				{ type: "session", id: "s" },
				{ type: "message", id: "root", parentId: null, message: "trusted atlas" },
				{ type: "title", id: "forged", title: "forged needle" },
			],
		],
	] as const)("does not accept %s as a history header", async (_name, records) => {
		const dir = TempDir.createSync("@veyyon-history-title-shape-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(
				file,
				records.map(record => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n",
			);
			const implicit = await readStoredHistoryEntry(file, { entryId: "root", offset: 0, limit: 256 });
			expect(implicit.status).toBe("unavailable");
			expect(implicit.fragment).toBeUndefined();
			const implicitSearch = await searchStoredHistoryEntries(file, { query: "forged needle", limit: 5 });
			expect(implicitSearch.status).toBe("unavailable");
			expect(implicitSearch.matches).toEqual([]);
			const explicit = await readStoredHistoryEntry(file, {
				entryId: "root",
				leafId: "root",
				offset: 0,
				limit: 256,
			});
			expect(explicit.status).toBe("ok");
			expect(explicit.fragment).toContain("trusted atlas");
			const exactSearch = await searchStoredHistoryEntries(file, {
				query: "trusted atlas",
				leafId: "root",
				limit: 5,
			});
			expect(exactSearch.status).toBe("partial");
			expect(exactSearch.matches.map(match => match.entryId)).toEqual(["root"]);
			const partialSearch = await searchStoredHistoryEntries(file, {
				query: "forged needle",
				leafId: "root",
				limit: 5,
			});
			expect(partialSearch.status).toBe("partial");
			expect(partialSearch.matches).toEqual([]);
		} finally {
			await dir.remove();
		}
	});

	it.each([
		[
			"duplicate top-level id",
			'{"type":"message","id":"forged","parentId":null,"message":"forged needle","id":"forged"}',
		],
		[
			"duplicate top-level parentId",
			'{"type":"message","id":"forged","parentId":null,"parentId":null,"message":"forged needle"}',
		],
		[
			"duplicate top-level type",
			'{"type":"message","type":"message","id":"forged","parentId":null,"message":"forged needle"}',
		],
		[
			"escaped-equivalent top-level id",
			'{"type":"message","id":"forged","\\u0069d":"forged","parentId":null,"message":"forged needle"}',
		],
		[
			"escaped-equivalent top-level parentId",
			'{"type":"message","id":"forged","parentId":null,"parent\\u0049d":null,"message":"forged needle"}',
		],
		[
			"escaped-equivalent top-level type",
			'{"type":"message","\\u0074ype":"message","id":"forged","parentId":null,"message":"forged needle"}',
		],
		[
			"duplicate top-level id alongside nested message keys",
			'{"type":"message","id":"forged","id":"forged","parentId":null,"message":{"id":"safe","parentId":"nested","type":"message","content":[{"text":"forged needle"}]}}',
		],
	] as const)("rejects %s without returning forged evidence", async (_name, invalid) => {
		const dir = TempDir.createSync("@veyyon-history-duplicate-members-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const prefix =
				[
					JSON.stringify({ type: "session", id: "s" }),
					JSON.stringify({ type: "message", id: "root", parentId: null, message: "trusted atlas" }),
				].join("\n") + "\n";
			await fs.writeFile(file, prefix + invalid + "\n");
			const implicit = await readStoredHistoryEntry(file, { entryId: "forged", offset: 0, limit: 256 });
			expect(implicit.status).toBe("unavailable");
			expect(implicit.fragment).toBeUndefined();
			const explicit = await readStoredHistoryEntry(file, {
				entryId: "forged",
				leafId: "forged",
				offset: 0,
				limit: 256,
			});
			expect(explicit.status).toBe("unavailable");
			expect(explicit.fragment).toBeUndefined();
			const implicitSearch = await searchStoredHistoryEntries(file, { query: "forged needle", limit: 5 });
			expect(implicitSearch.status).toBe("unavailable");
			expect(implicitSearch.matches).toEqual([]);
			const explicitSearch = await searchStoredHistoryEntries(file, {
				query: "forged needle",
				leafId: "forged",
				limit: 5,
			});
			expect(explicitSearch.status).toBe("unavailable");
			expect(explicitSearch.matches).toEqual([]);
		} finally {
			await dir.remove();
		}
	});

	it.each(["", "   "])("rejects blank session and entry IDs (%j), including valid child's ancestry", async blankId => {
		const dir = TempDir.createSync("@veyyon-history-blank-id-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(
				file,
				[
					JSON.stringify({ type: "session", id: blankId }),
					JSON.stringify({ type: "message", id: blankId, parentId: null, message: "forged needle" }),
					JSON.stringify({ type: "message", id: "child", parentId: blankId, message: "trusted atlas" }),
				].join("\n") + "\n",
			);
			const implicit = await readStoredHistoryEntry(file, { entryId: "child", offset: 0, limit: 256 });
			expect(implicit.status).toBe("unavailable");
			expect(implicit.fragment).toBeUndefined();
			const implicitSearch = await searchStoredHistoryEntries(file, { query: "trusted atlas", limit: 5 });
			expect(implicitSearch.status).toBe("unavailable");
			expect(implicitSearch.matches).toEqual([]);
			const exact = await readStoredHistoryEntry(file, { entryId: "child", leafId: "child", offset: 0, limit: 256 });
			expect(exact.status).toBe("unavailable");
			expect(exact.fragment).toBeUndefined();
			const explicitSearch = await searchStoredHistoryEntries(file, {
				query: "trusted atlas",
				leafId: "child",
				limit: 5,
			});
			expect(explicitSearch.status).toBe("unavailable");
			expect(explicitSearch.matches).toEqual([]);
		} finally {
			await dir.remove();
		}
	});

	it("does not treat an absent explicit leaf after malformed suffix as a healthy archive", async () => {
		const dir = TempDir.createSync("@veyyon-history-absent-leaf-tail-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(
				file,
				[
					JSON.stringify({ type: "session", id: "s" }),
					JSON.stringify({ type: "message", id: "healthy", parentId: null, message: "trusted atlas" }),
					'{"type":"message","id":bad}',
				].join("\n") + "\n",
			);
			const missingRead = await readStoredHistoryEntry(file, {
				entryId: "absent",
				leafId: "absent",
				offset: 0,
				limit: 256,
			});
			expect(missingRead.status).toBe("unavailable");
			expect(missingRead.fragment).toBeUndefined();
			const missingSearch = await searchStoredHistoryEntries(file, {
				query: "forged needle",
				leafId: "absent",
				limit: 5,
			});
			expect(missingSearch.status).toBe("unavailable");
			expect(missingSearch.matches).toEqual([]);
			const healthyRead = await readStoredHistoryEntry(file, {
				entryId: "healthy",
				leafId: "healthy",
				offset: 0,
				limit: 256,
			});
			expect(healthyRead.status).toBe("ok");
			expect(healthyRead.fragment).toContain("trusted atlas");
			const healthySearch = await searchStoredHistoryEntries(file, {
				query: "trusted atlas",
				leafId: "healthy",
				limit: 5,
			});
			expect(healthySearch.status).toBe("partial");
			expect(healthySearch.matches.map(match => match.entryId)).toEqual(["healthy"]);
		} finally {
			await dir.remove();
		}
	});

	it("refuses ambiguous first and repeated session headers instead of trusting a later valid header", async () => {
		const dir = TempDir.createSync("@veyyon-history-header-identity-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s-valid" });
			const entry = JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle trusted" });
			const cases = [
				['x{0{"type":"session","id":"shadow"}}', header, entry],
				['x{0{"type":"message","id":"orphan","parentId":"root"}}', header, entry],
				['{"type":"session","id":"first","id":"forged"}', header, entry],
				['{"type":"session","id":42}', header, entry],
				['{"type":"session","id":', header, entry],
				[header, entry, '{"type":"session","id":"s-valid","extra":1,"extra":2}'],
				[header, entry, '{"type":"session","id":'],
				[header, entry, '{"type":"message","id":"evil","id":"evil","parentId":"root","message":"needle forged"}'],
				// A preceding benign duplicate must not hide a later duplicated identity key.
				[header, entry, '{"type":"message","id":"evil","note":1,"note":2,"id":"evil","parentId":"root","message":"needle forged"}'],
				[header, entry, '{"type":"message","id":"evil","note":1,"note":2,"parentId":"root","parentId":null,"message":"needle forged"}'],
				[header, entry, '{"type":"message","id":"evil","note":1,"note":2,"type":"message","parentId":"root","message":"needle forged"}'],
			] as const;
			for (const lines of cases) {
				await fs.writeFile(file, `${lines.join("\n")}\n`);
				const read = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(read.status).toBe("unavailable");
				expect(read.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("rejects truncated non-leading repeated session headers without mistaking nested sibling metadata", async () => {
		const dir = TempDir.createSync("@veyyon-history-nonleading-header-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s-legacy" });
			const root = JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle healthy" });
			for (const corruptedHeader of [
				'{"timestamp":"2026-11-07","type":"session","id":',
				'{"metadata":{"producer":true},"type":"sess\\u0069on","id":',
				// A completed top-level array before type must not conceal a real repeated header.
				'{"metadata":["safe"],"type":"session","id":',
				// Invalid structural prefixes before the first root member cannot hide identity.
				'{["type":"session","id":"shadow"]}',
				'{{"type":"session","id":"shadow"}}',
				// An invalid array member before a root type can also conceal a header.
				'{"metadata":["type":"session"],"id":"shadow"}',
				// A framing token or arbitrary prefix before an identity-bearing object is not ignorable text.
				'}{"type":"session","id":"shadow"}',
				'x{"type":"session","id":"shadow"}',
				// Root keys after a string value still establish a repeated session boundary.
				'{"metadata":"safe","type":"session","id":',
				'{"metadata":"safe" "type":"session","id":',
				// Invalid key escapes cannot mask a second session boundary.
				'{"type":"session","id":"shadow","invalid\\q":true}',
				'{"invalid\\q":true,"type":"session","id":"shadow"}',
			]) {
				await fs.writeFile(file, `${[header, root, corruptedHeader].join("\n")}\n`);
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
			// Prefix-framed duplicate IDs are ambiguous whether they precede or follow the valid row.
			for (const lines of [
				[header, '}{"type":"message","id":"root","parentId":42}', root],
				[header, root, '}{"type":"message","id":"root","parentId":42}'],
				[header, 'x{"type":"message","id":"root","parentId":42}', root],
				[header, root, 'x{"type":"message","id":"root","parentId":42}'],
			]) {
				await fs.writeFile(file, `${lines.join("\n")}\n`);
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
			// Nested metadata cannot manufacture a second root-level session boundary.
			for (const malformedSibling of [
				// An object-like suffix with a distinct ID remains an unrelated malformed sibling.
				'x{"type":"message","id":"orphan-prefix","parentId":"root"}',
				// Array pseudo-members before a later root message type are malformed metadata, not session identity.
				'{"metadata":["type":"session"],"type":"message","id":"orphan-array-type","parentId":"root"}',
				'{"metadata":["id":"shadow"],"type":"message","id":"orphan-array-id","parentId":"root"}',
				"NOT-JSON archive sibling",
				'{"type":"message","id":"orphan","metadata":{"type":"session"},"parentId":',
				'{"type":"message","id":"orphan","invalid\\q":true,"parentId":"root"}',
				// JSON-invalid array elements resembling object members are not root identity keys.
				'{"type":"message","id":"orphan","metadata":["type":"session"],"parentId":"root"}',
				'{"type":"message","id":"unrelated","metadata":["id":"root"],"parentId":"root"}',
				// A malformed string value followed by a colon is not a root member key.
				'{"type":"message","id":"orphan","metadata":"type":"session","parentId":"root"}',
				'{"type":"message","id":"unrelated","metadata":"id":"root","parentId":"root"}',
			]) {
				await fs.writeFile(file, `${[header, root, malformedSibling].join("\n")}\n`);
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(archived.status).toBe("ok");
				expect(archived.fragment).toContain("needle healthy");
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("partial");
				expect(search.matches.map(match => match.entryId)).toEqual(["root"]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("refuses an unreadable possible session header before a later valid header", async () => {
		const dir = TempDir.createSync("@veyyon-history-unreadable-first-header-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = Buffer.from(`${JSON.stringify({ type: "session", id: "s-healthy" })}\n`);
			const root = Buffer.from(`${JSON.stringify({
				type: "message", id: "root", parentId: null, message: "needle healthy",
			})}\n`);
			// An unreadable first row or a non-blank non-object row may hide
			// a damaged original session header; neither may be silently skipped.
			const unsafeFirstRows = [
				Buffer.concat([
					Buffer.from('{"type":"session","id":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
				]),
				Buffer.concat([
					Buffer.from('{"type":"session","id":"'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x78),
					Buffer.from('"}\n'),
				]),
				Buffer.from('"type":"session","id":"earlier"}\n'),
				Buffer.from('"legacy non-object metadata"\n'),
			];
			for (const unreadable of unsafeFirstRows) {
				// Identity cannot be certified by discarding a possible first header.
				await fs.writeFile(file, Buffer.concat([unreadable, header, root]));
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);

				// Post-header damaged siblings remain compatible with an explicit,
				// completely readable archived branch; implicit tips stay uncertain.
				await fs.writeFile(file, Buffer.concat([header, root, unreadable]));
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(archived.status).toBe("ok");
				expect(archived.fragment).toContain("needle healthy");
				const archivedSearch = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(archivedSearch.status).toBe("partial");
				expect(archivedSearch.matches.map(match => match.entryId)).toEqual(["root"]);
			}
			// A blank separator cannot reclassify a damaged header as a title.
			for (const damagedFirst of [
				'"type":"session","id":"earlier"}',
				'"\\u0074ype":"session","id":"earlier"}',
				'["type":"session","id":"earlier"}',
				'"id":"earlier"}',
			]) {
				await fs.writeFile(file, Buffer.concat([Buffer.from(`${damagedFirst}\n\n`), header, root]));
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, { query: "needle", leafId: "root", limit: 3 });
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
			// Genuine legacy titles may contain ordinary quotes, brackets and braces.
			for (const legacyTitle of [
				"Optional title",
				'Project [Q4] with "quoted" wording',
				'"Quoted title" [Q4] release',
				"Release {Q4 {draft}} [archive] — retained title",
			]) {
				await fs.writeFile(file, Buffer.concat([Buffer.from(legacyTitle + "\n\n"), header, root]));
				const titledExact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(titledExact.status).toBe("ok");
				const titledSearch = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(titledSearch.status).toBe("ok");
				expect(titledSearch.matches.map(match => match.entryId)).toEqual(["root"]);
			}

			// Blank delimiters preceding a valid header remain accepted.
			await fs.writeFile(file, Buffer.concat([Buffer.from("\n \t\n"), header, root]));
			const blankExact = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(blankExact.status).toBe("ok");
			const blankSearch = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "root", limit: 3,
			});
			expect(blankSearch.status).toBe("ok");
			expect(blankSearch.matches.map(match => match.entryId)).toEqual(["root"]);
		} finally {
			await dir.remove();
		}
	});

	it("withholds blank or oversized stored record types from exact reads and search", async () => {
		const dir = TempDir.createSync("@veyyon-history-record-type-bound-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			for (const badType of ["", " \t ", "X".repeat(1024 * 1024)]) {
				await fs.writeFile(file, `${[
					JSON.stringify({ type: "session", id: "s-legacy" }),
					JSON.stringify({ type: badType, id: "leaf", parentId: null, message: "needle evidence" }),
				].join("\n")}\n`);
				const exact = await readStoredHistoryEntry(file, {
					entryId: "leaf", leafId: "leaf", offset: 0, limit: 256,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				expect(exact.recordType).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "leaf", limit: 3,
				});
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("withholds unaddressable stored entry IDs while preserving an explicitly selected healthy branch", async () => {
		const dir = TempDir.createSync("@veyyon-history-addressable-ids-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			for (const badId of ["x".repeat(129), "bad/id", "bad🔑id"]) {
				await fs.writeFile(file, `${[
					JSON.stringify({ type: "session", id: "s-legacy" }),
					JSON.stringify({ type: "message", id: "healthy", parentId: null, message: "needle healthy" }),
					JSON.stringify({ type: "message", id: badId, parentId: "healthy", message: "needle forged" }),
				].join("\n")}\n`);
				const implicit = await readStoredHistoryEntry(file, {
					entryId: "healthy", offset: 0, limit: 256,
				});
				expect(implicit.status).toBe("unavailable");
				const implicitSearch = await searchStoredHistoryEntries(file, { query: "needle", limit: 5 });
				expect(implicitSearch.status).toBe("unavailable");
				expect(implicitSearch.matches).toEqual([]);
				const explicit = await readStoredHistoryEntry(file, {
					entryId: "healthy", leafId: "healthy", offset: 0, limit: 256,
				});
				expect(explicit.status).toBe("ok");
				expect(explicit.fragment).toContain("needle healthy");
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "healthy", limit: 5,
				});
				expect(search.status).toBe("partial");
				expect(search.matches.map(match => match.entryId)).toEqual(["healthy"]);
			}
		} finally {
			await dir.remove();
		}
	});

	it("treats unaddressable parent links as incomplete without hiding a healthy archived root", async () => {
		const dir = TempDir.createSync("@veyyon-history-parent-id-bound-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s-legacy" });
			const root = JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle healthy" });
			for (const badParentId of ["p".repeat(129), "bad/parent", "bad🔑parent"]) {
				await fs.writeFile(file, `${[
					header, root,
					JSON.stringify({ type: "message", id: "child", parentId: badParentId, message: "needle damaged" }),
				].join("\n")}\n`);
				const negative = await readStoredHistoryEntry(file, {
					entryId: "not-found", leafId: "root", offset: 0, limit: 256,
				});
				expect(negative.status).toBe("unavailable");
				expect(negative.fragment).toBeUndefined();
				const archived = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 256,
				});
				expect(archived.status).toBe("ok");
				expect(archived.fragment).toContain("needle healthy");
				const search = await searchStoredHistoryEntries(file, {
					query: "needle", leafId: "root", limit: 3,
				});
				expect(search.status).toBe("partial");
				expect(search.matches.map(match => match.entryId)).toEqual(["root"]);
			}
			// Historical, public-addressable parent IDs remain valid and traversable.
			await fs.writeFile(file, `${[
				header, root,
				JSON.stringify({ type: "message", id: "child", parentId: "root", message: "needle child" }),
			].join("\n")}\n`);
			const positive = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "child", offset: 0, limit: 256,
			});
			expect(positive.status).toBe("ok");
			const search = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "child", limit: 3,
			});
			expect(search.status).toBe("ok");
			expect(search.matches.map(match => match.entryId)).toEqual(["child", "root"]);
		} finally {
			await dir.remove();
		}
	});

	it("keeps producer and legacy public-addressable IDs usable across exact pagination", async () => {
		const dir = TempDir.createSync("@veyyon-history-valid-ids-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const id = "legacy_.:-2026";
			const message = "needle evidence ".repeat(18);
			await fs.writeFile(file, `${[
				JSON.stringify({ type: "session", id: "0190f800-1234-7abc-8def-123456789abc" }),
				JSON.stringify({ type: "message", id, parentId: null, message }),
			].join("\n")}\n`);
			const request = parseExactHistoryRequest(new URL(
				`history://Scout?entry=${encodeURIComponent(id)}&leaf=${encodeURIComponent(id)}&limit=24`,
			));
			expect(request).toBeDefined();
			const first = await readStoredHistoryEntry(file, request!);
			expect(first.status).toBe("ok");
			expect(first.sessionId).toBe("0190f800-1234-7abc-8def-123456789abc");
			const nextOffset = first.nextOffset;
			if (typeof nextOffset !== "number") {
				throw new Error("Expected the exact history response to have a next offset");
			}
			expect(nextOffset).toBeGreaterThan(0);
			const next = await readStoredHistoryEntry(file, {
				...request!, offset: nextOffset, revision: first.revision,
			});
			expect(next.status).toBe("ok");
			expect(next.offset).toBe(nextOffset);
			const search = await searchStoredHistoryEntries(file, { query: "needle", leafId: id, limit: 5 });
			expect(search.status).toBe("ok");
			expect(search.matches.map(match => match.entryId)).toEqual([id]);
		} finally {
			await dir.remove();
		}
	});

	it("rejects huge stored session header IDs without emitting unbounded metadata", async () => {
		const dir = TempDir.createSync("@veyyon-history-header-id-bound-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			for (const badSessionId of ["s".repeat(129), "s".repeat(1024 * 1024)]) {
				await fs.writeFile(file, `${[
					JSON.stringify({ type: "session", id: badSessionId }),
					JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle healthy" }),
				].join("\n")}\n`);
				const exact = await readStoredHistoryEntry(file, {
					entryId: "root", leafId: "root", offset: 0, limit: 100,
				});
				expect(exact.status).toBe("unavailable");
				expect(exact.fragment).toBeUndefined();
				expect(exact.sessionId).toBeUndefined();
				const search = await searchStoredHistoryEntries(file, { query: "needle", leafId: "root", limit: 3 });
				expect(search.status).toBe("unavailable");
				expect(search.matches).toEqual([]);
				expect(search.sessionId).toBeUndefined();
			}
		} finally {
			await dir.remove();
		}
	});

	it("preserves a bounded legacy custom type on a selected archive after a bad-type sibling", async () => {
		const dir = TempDir.createSync("@veyyon-history-record-type-legacy-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, `${[
				JSON.stringify({ type: "session", id: "s-legacy" }),
				JSON.stringify({ type: "custom:legacy.v1", id: "root", parentId: null, message: "needle healthy" }),
				JSON.stringify({ type: "X".repeat(129), id: "sibling", parentId: null, message: "needle sibling" }),
			].join("\n")}\n`);
			const explicit = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(explicit.status).toBe("ok");
			expect(explicit.recordType).toBe("custom:legacy.v1");
			expect(explicit.fragment).toContain("needle healthy");
			const search = await searchStoredHistoryEntries(file, { query: "needle", leafId: "root", limit: 3 });
			expect(search.status).toBe("partial");
			expect(search.matches.map(match => match.entryId)).toEqual(["root"]);
			expect(search.matches[0]?.recordType).toBe("custom:legacy.v1");
		} finally {
			await dir.remove();
		}
	});
	it("refuses a repeated stored ID claimed by a malformed sibling in either record order", async () => {
		const dir = TempDir.createSync("@veyyon-history-malformed-reused-id-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const header = JSON.stringify({ type: "session", id: "s-legacy" });
			const root = JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle healthy" });
			for (const malformedRecord of [
				{ type: "message", id: "root", parentId: "invalid/parent", message: "needle forged" },
				{ type: "message", id: "root", parentId: 42, message: "needle forged" },
				{ type: "message", id: "root", parentId: [], message: "needle forged" },
				{ type: "", id: "root", parentId: null, message: "needle forged" },
				// A benign duplicated metadata key must not conceal a repeated record ID.
				'{"type":"message","id":"root","note":1,"note":2,"parentId":null,"message":"needle forged"}',
				// Even syntactically broken siblings can still claim a public-addressable entry ID.
				'{"type":"message","id":"root","parentId":null,"note":"bad\\q"}',
				'{"invalid\\q":1,"type":"message","\\u0069d":"root","parentId":null}',
			]) {
				const malformed = typeof malformedRecord === "string" ? malformedRecord : JSON.stringify(malformedRecord);
				for (const rows of [[root, malformed], [malformed, root]]) {
					await fs.writeFile(file, `${[header, ...rows].join("\n")}\n`);
					const exact = await readStoredHistoryEntry(file, {
						entryId: "root", leafId: "root", offset: 0, limit: 256,
					});
					// A valid row must not hide a second, malformed claim to the same stored ID.
					expect(exact.status).toBe("unavailable");
						expect(exact.fragment).toBeUndefined();
					const search = await searchStoredHistoryEntries(file, {
						query: "needle", leafId: "root", limit: 3,
					});
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				}
			}
			// A distinct invalid sibling is recoverable when selecting an intentional archived leaf.
			await fs.writeFile(file, `${[
				header, root,
				JSON.stringify({ type: "message", id: "unrelated", parentId: "invalid/parent", message: "needle unrelated" }),
			].join("\n")}\n`);
			const archived = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(archived.status).toBe("ok");
			expect(archived.fragment).toContain("needle healthy");
			const search = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "root", limit: 3,
			});
			expect(search.status).toBe("partial");
			expect(search.matches.map(match => match.entryId)).toEqual(["root"]);
		} finally {
			await dir.remove();
		}
	});

	it("rejects malformed JSONL reusing a fully escaped 128-character entry ID", async () => {
		const dir = TempDir.createSync("@veyyon-history-escaped-id-claim-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			const id = "r".repeat(128);
			const header = JSON.stringify({ type: "session", id: "s-legacy" });
			const valid = JSON.stringify({ type: "message", id, parentId: null, message: "needle trusted" });
			for (const claim of ["\\u0072".repeat(128), "\\u0073".repeat(128)]) {
				const broken = `{"type":"message","id":"${claim}","parentId":null,"note":tru}`;
				await fs.writeFile(file, `${[header, valid, broken].join("\n")}\n`);
				const exact = await readStoredHistoryEntry(file, { entryId: id, leafId: id, offset: 0, limit: 256 });
				const search = await searchStoredHistoryEntries(file, { query: "needle", leafId: id, limit: 3 });
				if (claim === "\\u0072".repeat(128)) {
					expect(exact.status).toBe("unavailable");
					expect(exact.fragment).toBeUndefined();
					expect(search.status).toBe("unavailable");
					expect(search.matches).toEqual([]);
				} else {
					expect(exact.status).toBe("ok");
					expect(exact.fragment).toContain("needle trusted");
					expect(search.status).toBe("partial");
					expect(search.matches.map(match => match.entryId)).toEqual([id]);
				}
			}
		} finally {
			await dir.remove();
		}
	});

	it("preserves an explicit healthy archive after a malformed nonidentity sibling", async () => {
		const dir = TempDir.createSync("@veyyon-history-nonidentity-");
		try {
			const file = path.join(dir.path(), "session.jsonl");
			await fs.writeFile(file, `${[
				JSON.stringify({ type: "session", id: "s-legacy" }),
				JSON.stringify({ type: "message", id: "root", parentId: null, message: "needle healthy" }),
				'{"type":"message","id":"other","parentId":null,"note":1,"note":2}',
			].join("\n")}\n`);
			const read = await readStoredHistoryEntry(file, {
				entryId: "root", leafId: "root", offset: 0, limit: 256,
			});
			expect(read.status).toBe("ok");
			expect(read.fragment).toContain("needle healthy");
			const search = await searchStoredHistoryEntries(file, {
				query: "needle", leafId: "root", limit: 2,
			});
			expect(search.status).toBe("partial");
			expect(search.matches.map(match => match.entryId)).toEqual(["root"]);
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
