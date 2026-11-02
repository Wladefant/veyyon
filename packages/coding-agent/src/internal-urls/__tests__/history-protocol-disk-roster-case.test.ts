/** Regression: history:// is case-insensitive, so one registered agent must not
 * cause an identically folded disk-only transcript to appear as a second
 * selectable entry in the index or completions. This does not read private
 * session content or change stored transcript files.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { HistoryProtocolHandler } from "../history-protocol";
import { parseInternalUrl } from "../parse";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests, sessionFilesFromDisk } from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

function register(id: string, live = false): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		session: live
			? ({ messages: [], sessionManager: { getArtifactsDir: () => null } } as unknown as AgentSession)
			: null,
		sessionFile: null,
		status: live ? "running" : "parked",
	});
}

/** Synthetic roots retain their scope even when the root session is parked. */
function scopedRoot(id: string, scope: string, live: boolean): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "main",
		scope,
		session: live
			? ({ messages: [], sessionManager: { getArtifactsDir: () => null } } as unknown as AgentSession)
			: null,
		sessionFile: null,
		status: live ? "running" : "parked",
	});
}

function scopedParkedScout(parentId: string, sessionFile: string): void {
	AgentRegistry.global().register({
		id: "Scout",
		displayName: "Scout",
		kind: "sub",
		parentId,
		session: null,
		sessionFile,
		status: "parked",
	});
}

async function createDiskArchive(root: string, id: string, folder = "saved"): Promise<void> {
	const dir = path.join(root, folder);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, `${id}.jsonl`), [
		JSON.stringify({ type: "session", id: "saved-session" }),
		JSON.stringify({ type: "message", id: "saved-entry", parentId: null, message: "saved text" }),
	].join("\n") + "\n");
}

function idRows(markdown: string): string[] {
	return markdown.split("\n").filter(line => /^\| (?:Reviewer|reviewer) \|/.test(line));
}

describe("history:// case-folded disk roster", () => {
	it("does not advertise disk-only alias of a registered agent as a second selectable row", async () => {
		const temp = TempDir.createSync("@veyyon-history-roster-alias-");
		try {
			registerArtifactsDir(temp.path());
			await createDiskArchive(temp.path(), "reviewer");
			register("Reviewer", true);

			const handler = new HistoryProtocolHandler();
			const index = await handler.resolve(new URL("history://") as never);
			expect(idRows(index.content)).toHaveLength(1);
			expect(idRows(index.content)[0]).toContain("| Reviewer |");

			const ids = (await handler.complete()).map(item => item.value)
				.filter(id => id.toLowerCase() === "reviewer");
			expect(ids).toEqual(["Reviewer"]);
			// A lower-cased URL resolves the live registered agent, not the hidden
			// on-disk spelling. This must agree with what the roster advertises.
			const selected = await handler.resolve(new URL("history://reviewer") as never);
			expect(selected.notes).toContain("Source: live session");
		} finally {
			await temp.remove();
		}
	});

	it("still advertises a genuinely disk-only agent when no registry alias exists", async () => {
		const temp = TempDir.createSync("@veyyon-history-roster-disk-");
		try {
			registerArtifactsDir(temp.path());
			await createDiskArchive(temp.path(), "reviewer");

			const handler = new HistoryProtocolHandler();
			const index = await handler.resolve(new URL("history://") as never);
			expect(idRows(index.content)).toHaveLength(1);
			expect(idRows(index.content)[0]).toContain("| reviewer | on disk |");
			expect((await handler.complete()).map(item => item.value)).toContain("reviewer");
		} finally {
			await temp.remove();
		}
	});

	it("keeps disk-only completions and the index consistent with disk discovery", async () => {
		const temp = TempDir.createSync("@veyyon-history-roster-disk-variants-");
		try {
			registerArtifactsDir(temp.path());
			// Two directories allow both names even on a case-insensitive host.
			await createDiskArchive(temp.path(), "Reviewer", "first");
			await createDiskArchive(temp.path(), "reviewer", "second");

			// Before #872, disk discovery may expose both spellings; #872 will
			// instead reject their collision. Neither policy may be silently
			// overridden by the index/completer's registered-name deduplication.
			const diskNames = [...(await sessionFilesFromDisk()).keys()]
				.filter(id => id.toLowerCase() === "reviewer").sort();
			const handler = new HistoryProtocolHandler();
			const indexed = idRows((await handler.resolve(new URL("history://") as never)).content)
				.map(row => row.split("|")[1]?.trim()).sort();
			const completed = (await handler.complete()).map(item => item.value)
				.filter(id => id.toLowerCase() === "reviewer").sort();
			expect(indexed).toEqual(diskNames);
			expect(completed).toEqual(diskNames);
		} finally {
			await temp.remove();
		}
	});

	it("does not collapse two distinct registered names while deduplicating disk aliases", async () => {
		register("Reviewer");
		register("reviewer");

		const handler = new HistoryProtocolHandler();
		const index = await handler.resolve(new URL("history://") as never);
		expect(idRows(index.content)).toHaveLength(2);
		expect((await handler.complete()).map(item => item.value)
			.filter(id => id.toLowerCase() === "reviewer")).toEqual(["Reviewer", "reviewer"]);
	});
	
	it("refuses third-case registered aliases in overview, exact reads and search", async () => {
		// WHY: registry names are exact-case identities, but an unqualified
		// case-fold fallback used to choose the first of two matching agents.
		register("Reviewer", true);
		register("reviewer", true);
		const handler = new HistoryProtocolHandler();
		// parseInternalUrl retains the raw host spelling; new URL() may fold it.
		for (const suffix of ["", "?q=needle", "?entry=entry-1&offset=0&limit=8000"]) {
			await expect(handler.resolve(parseInternalUrl(`history://REVIEWER${suffix}`)))
				.rejects.toThrow("Ambiguous registered agent: REVIEWER");
		}
		// Explicit exact spellings are still distinct selectable identities.
		const upper = await handler.resolve(parseInternalUrl("history://Reviewer"));
		const lower = await handler.resolve(parseInternalUrl("history://reviewer"));
		expect(upper.content).toContain("# Reviewer (running)");
		expect(lower.content).toContain("# reviewer (running)");
		const names = (await handler.complete()).map(item => item.value)
			.filter(id => id.toLowerCase() === "reviewer");
		expect(names).toEqual(["Reviewer", "reviewer"]);
	});

	it("keeps single registered agent's case-insensitive convenience lookup", async () => {
		register("Reviewer", true);
		const handler = new HistoryProtocolHandler();
		for (const alias of ["reviewer", "REVIEWER"]) {
			const result = await handler.resolve(parseInternalUrl(`history://${alias}`));
			expect(result.notes).toContain("Source: live session");
			expect(result.content).toContain("# Reviewer (running)");
		}
	});

	it("refuses parked foreign conversation history in index, overview, exact, search and completions", async () => {
		const temp = TempDir.createSync("@veyyon-history-parked-foreign-scope-");
		try {
			await createDiskArchive(temp.path(), "Scout");
			const file = path.join(temp.path(), "saved", "Scout.jsonl");
			scopedRoot("acp:a", "session-a", true);
			scopedRoot("acp:b", "session-b", false);
			scopedParkedScout("acp:b", file);

			// A live-only root count incorrectly sees one conversation and
			// leaks B's archived transcript through the process-global registry.
			const handler = new HistoryProtocolHandler();
			for (const url of ["history://", "history://Scout", "history://Scout?q=saved",
				"history://Scout?entry=saved-entry&limit=1000"]) {
				await expect(handler.resolve(parseInternalUrl(url)))
					.rejects.toThrow(/2 conversations at once/);
			}
			expect(await handler.complete()).toEqual([]);
		} finally {
			await temp.remove();
		}
	});

	it("retains same-scope parked retrieval and one-scope archived-only continuity", async () => {
		const temp = TempDir.createSync("@veyyon-history-same-parked-scope-");
		try {
			await createDiskArchive(temp.path(), "Scout");
			const file = path.join(temp.path(), "saved", "Scout.jsonl");
			const check = async (): Promise<void> => {
				const handler = new HistoryProtocolHandler();
				const result = await handler.resolve(parseInternalUrl("history://Scout?entry=saved-entry&limit=1000"));
				const payload = JSON.parse(result.content) as { status: string; fragment: string; sessionId: string };
				expect(payload.status).toBe("ok");
				expect(payload.sessionId).toBe("saved-session");
				expect(payload.fragment).toContain("saved text");
				expect((await handler.resolve(parseInternalUrl("history://"))).content).toContain("| Scout |");
				expect((await handler.complete()).map(item => item.value)).toContain("Scout");
			};

			scopedRoot("acp:a", "session-a", true);
			scopedParkedScout("acp:a", file);
			await check();

			// No live root but a single retained scope: stored history still works.
			AgentRegistry.resetGlobalForTests();
			scopedRoot("acp:b", "session-b", false);
			scopedParkedScout("acp:b", file);
			await check();
		} finally {
			await temp.remove();
		}
	});


	it("keeps discoverable registered advisor transcripts out of every agent-facing history path", async () => {
		const temp = TempDir.createSync("@veyyon-history-advisor-private-");
		try {
			registerArtifactsDir(temp.path());
			await createDiskArchive(temp.path(), "Guide");
			await createDiskArchive(temp.path(), "Helper");
			AgentRegistry.global().register({
				id: "Guide",
				displayName: "Guide",
				kind: "advisor",
				session: null,
				sessionFile: path.join(temp.path(), "saved", "Guide.jsonl"),
				status: "parked",
			});
			register("Scout", true);

			const handler = new HistoryProtocolHandler();
			const index = (await handler.resolve(parseInternalUrl("history://"))).content;
			expect(index).not.toContain("| Guide |");
			expect(index).toContain("| Scout |");
			expect(index).toContain("| Helper | on disk |");
			const names = (await handler.complete()).map(item => item.value);
			expect(names).not.toContain("Guide");
			expect(names).toContain("Scout");
			expect(names).toContain("Helper");

			// The same private ID must not be reintroduced by case-insensitive
			// disk fallback, for either markdown or stored exact/search routes.
			for (const id of ["Guide", "guide", "GUIDE"]) {
				for (const suffix of ["", "?q=saved", "?entry=saved-entry&limit=1000"]) {
					await expect(handler.resolve(parseInternalUrl(`history://${id}${suffix}`)))
						.rejects.toThrow("Unknown agent");
				}
			}
			const archived = await handler.resolve(parseInternalUrl("history://Helper?entry=saved-entry&limit=1000"));
			expect((JSON.parse(archived.content) as { status: string }).status).toBe("ok");
			expect((await handler.resolve(parseInternalUrl("history://Scout"))).notes)
				.toContain("Source: live session");
		} finally {
			await temp.remove();
		}
	});

	it("preserves an exact live visible ID even when a separate advisor has the folded spelling", async () => {
		const temp = TempDir.createSync("@veyyon-history-advisor-folded-");
		try {
			registerArtifactsDir(temp.path());
			await createDiskArchive(temp.path(), "Guide");
			AgentRegistry.global().register({
				id: "Guide",
				displayName: "Guide",
				kind: "advisor",
				session: null,
				sessionFile: path.join(temp.path(), "saved", "Guide.jsonl"),
				status: "parked",
			});
			register("guide", true);

			const handler = new HistoryProtocolHandler();
			const index = (await handler.resolve(parseInternalUrl("history://"))).content;
			expect(index).toContain("| guide |");
			expect(index).not.toContain("| Guide |");
			expect((await handler.complete()).map(item => item.value)).toEqual(["guide"]);
			expect((await handler.resolve(parseInternalUrl("history://guide"))).notes)
				.toContain("Source: live session");
			for (const name of ["Guide", "GUIDE"]) {
				await expect(handler.resolve(parseInternalUrl(`history://${name}`)))
					.rejects.toThrow("Unknown agent");
			}
		} finally {
			await temp.remove();
		}
	});
});
