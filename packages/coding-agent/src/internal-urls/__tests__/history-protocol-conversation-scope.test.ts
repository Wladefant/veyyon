/**
 * `history://` when the process drives TWO conversations.
 *
 * WHY TWO, AND WHY REFUSAL RATHER THAN A FILTER. The disk fallback already
 * refuses an id whose transcript exists in two artifacts dirs. The REGISTRY path
 * never reached it: `registry.get(id)` is a process-global lookup keyed by a
 * name the caller chose, so a live ref belonging to another conversation was
 * served straight out, and the bare index listed every conversation's agents in
 * one table.
 *
 * There is nothing to filter with. `ProtocolHandler.resolve` is handed a URL and
 * a `ResolveContext` carrying cwd, settings and skills, and no agent id and no
 * scope, so the handler genuinely cannot tell who is asking. A transcript is the
 * fullest record an agent leaves, so it refuses while the answer is unknowable
 * and says why, which is the shape the `local://` root lookup already uses.
 *
 * With one conversation the refusal never triggers, and the leak it closes does
 * not exist to be observed: a one-conversation test proves nothing either way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { HistoryProtocolHandler } from "../history-protocol";
import {
	ambiguousSessionFileIds,
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	sessionFilesFromDisk,
} from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

/** A live root session with no artifacts dir, so nothing is read off disk. */
function liveRoot(id: string, scope: string): void {
	AgentRegistry.global().register({
		id,
		displayName: "main",
		kind: "main",
		session: { sessionManager: { getArtifactsDir: () => null } } as unknown as AgentSession,
		sessionFile: null,
		scope,
	});
}

describe("history:// across conversations", () => {

	/** A transcript filename is the public agent ID used for disk fallback. */
	async function archive(root: string, folder: string, id: string, sessionId: string, message: string): Promise<string> {
		const dir = path.join(root, folder);
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, id + ".jsonl");
		await fs.writeFile(file, [
			JSON.stringify({ type: "session", id: sessionId }),
			JSON.stringify({ type: "message", id: "entry", parentId: null, message }),
		].join("\n") + "\n");
		return file;
	}

	it("refuses a case-insensitive disk-name collision rather than selecting either transcript", async () => {
		const temp = TempDir.createSync("@veyyon-history-case-collision-");
		try {
			registerArtifactsDir(temp.path());
			await archive(temp.path(), "a", "Reviewer", "session-a", "conversation A evidence");
			await archive(temp.path(), "b", "reviewer", "session-b", "conversation B evidence");

			const files = await sessionFilesFromDisk();
			expect([...files.keys()].filter(id => id.toLowerCase() === "reviewer")).toEqual([]);
			expect([...(await ambiguousSessionFileIds())].some(id => id.toLowerCase() === "reviewer")).toBe(true);
			const handler = new HistoryProtocolHandler();
			await expect(handler.resolve(new URL("history://Reviewer?entry=entry") as never))
				.rejects.toThrow(/Ambiguous agent/i);
			await expect(handler.resolve(new URL("history://reviewer?entry=entry") as never))
				.rejects.toThrow(/Ambiguous agent/i);
		} finally {
			await temp.remove();
		}
	});

	it("never readmits an ambiguous transcript after a third distinct discovery path", async () => {
		const temp = TempDir.createSync("@veyyon-history-three-collisions-");
		try {
			registerArtifactsDir(temp.path());
			await archive(temp.path(), "a", "Reviewer", "session-a", "first transcript");
			await archive(temp.path(), "b", "Reviewer", "session-b", "second transcript");
			await archive(temp.path(), "c", "Reviewer", "session-c", "third transcript");

			expect((await sessionFilesFromDisk()).has("Reviewer")).toBe(false);
			expect((await ambiguousSessionFileIds()).has("Reviewer")).toBe(true);
			await expect(new HistoryProtocolHandler().resolve(new URL("history://Reviewer?entry=entry") as never))
				.rejects.toThrow(/Ambiguous agent: Reviewer/);
		} finally {
			await temp.remove();
		}
	});

	it("retains unique case-insensitive lookup despite overlapping artifact roots", async () => {
		const temp = TempDir.createSync("@veyyon-history-unique-discovery-");
		try {
			const file = await archive(temp.path(), "one", "Reviewer", "session-unique", "original unique transcript");
			registerArtifactsDir(temp.path());
			registerArtifactsDir(path.join(temp.path(), "one"));
			expect((await sessionFilesFromDisk()).get("Reviewer")).toBe(file);
			expect((await ambiguousSessionFileIds()).size).toBe(0);

			const resource = await new HistoryProtocolHandler().resolve(
				new URL("history://reviewer?entry=entry&limit=1000") as never,
			);
			const result = JSON.parse(resource.content) as { status: string; sessionId: string; fragment: string };
			expect(result.status).toBe("ok");
			expect(result.sessionId).toBe("session-unique");
			expect(result.fragment).toContain("original unique transcript");
		} finally {
			await temp.remove();
		}
	});

	it("finds a transcript below the recursion ceiling when its parent is also a registered root", async () => {
		const temp = TempDir.createSync("@veyyon-history-overlap-depth-");
		try {
			// The broad root encounters `nestedRoot` at depth 8, while its file
			// is one level deeper. The second registered root has its own budget.
			const nestedRoot = path.join(temp.path(), "a", "b", "c", "d", "e", "f", "g", "h");
			const file = await archive(nestedRoot, "child", "DeepReviewer", "session-deep", "deep archived evidence");
			registerArtifactsDir(temp.path());
			registerArtifactsDir(nestedRoot);

			expect((await sessionFilesFromDisk()).get("DeepReviewer")).toBe(file);
			expect((await ambiguousSessionFileIds()).size).toBe(0);
			const resource = await new HistoryProtocolHandler().resolve(
				new URL("history://deepreviewer?entry=entry&limit=1000") as never,
			);
			const result = JSON.parse(resource.content) as { status: string; sessionId: string; fragment: string };
			expect(result.status).toBe("ok");
			expect(result.sessionId).toBe("session-deep");
			expect(result.fragment).toContain("deep archived evidence");
		} finally {
			await temp.remove();
		}
	});
	/** The leak: naming another conversation's agent handed over its whole transcript. */
	it("refuses a lookup while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "acp:b",
			session: { messages: ["secret"] } as unknown as AgentSession,
			status: "running",
		});

		const resolve = new HistoryProtocolHandler().resolve(new URL("history://Scout") as never);

		await expect(resolve).rejects.toThrow(/2 conversations at once/);
		await expect(new HistoryProtocolHandler().resolve(new URL("history://Scout?entry=entry-one") as never))
			.rejects.toThrow(/2 conversations at once/);
	});

	/** The index is the same leak in table form: every conversation's agents in one list. */
	it("refuses the bare index while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");

		const resolve = new HistoryProtocolHandler().resolve(new URL("history://") as never);

		await expect(resolve).rejects.toThrow(/2 conversations at once/);
	});

	/**
	 * Completions go quiet rather than throwing: a completer must not raise, and
	 * offering names whose read is refused would put another conversation's agent
	 * ids in the operator's autocomplete, which is the leak stated plainly.
	 */
	it("offers no completions while more than one conversation is live", async () => {
		liveRoot("acp:a", "session-a");
		liveRoot("acp:b", "session-b");

		expect(await new HistoryProtocolHandler().complete()).toEqual([]);
	});

	/**
	 * The other direction, and the reason the trigger is "more than one live
	 * root" rather than "more than one ref": every ordinary single-conversation
	 * run, which is every interactive session, still resolves. Without this a
	 * refusal that broke `history://` outright would look like a fix.
	 */
	it("serves the stored entry only through a registered agent, without a session writer", async () => {
		const temp = TempDir.createSync("@veyyon-history-handler-");
		try {
			liveRoot("acp:a", "session-a");
			const file = path.join(temp.path(), "session.jsonl");
			await fs.writeFile(file, [
				JSON.stringify({ type: "session", id: "session-a" }),
				JSON.stringify({ type: "message", id: "record-one", parentId: null, message: "original text" }),
			].join("\n") + "\n");
			AgentRegistry.global().register({
				id: "Scout", displayName: "scout", kind: "sub", parentId: "acp:a",
				session: null, sessionFile: file, status: "parked",
			});
			const result = await new HistoryProtocolHandler().resolve(
				new URL("history://Scout?entry=record-one&limit=1000") as never,
			);
			expect(result.contentType).toBe("application/json");
			const payload = JSON.parse(result.content) as { status: string; fragment: string; sessionId: string };
			expect(payload.status).toBe("ok");
			expect(payload.fragment).toContain("original text");
			expect(payload.sessionId).toBe("session-a");
		} finally {
			await temp.remove();
		}
	});

	/** Branching can select an earlier leaf without changing the file's physical tail. */
	it("scopes persistent exact reads/search to the live leaf while retaining explicit archived-branch lookup", async () => {
		const temp = TempDir.createSync("@veyyon-history-branch-");
		try {
			liveRoot("acp:a", "session-a");
			const file = path.join(temp.path(), "session.jsonl");
			await fs.writeFile(file, [
				JSON.stringify({ type: "session", id: "session-a" }),
				JSON.stringify({ type: "message", id: "root-entry", parentId: null, message: "root text" }),
				JSON.stringify({ type: "message", id: "abandoned-entry", parentId: "root-entry", message: "onlyAbandoned" }),
			].join("\n") + "\n");
			let liveLeaf: string | null = "abandoned-entry";
			AgentRegistry.global().register({
				id: "Scout", displayName: "scout", kind: "sub", parentId: "acp:a",
				session: { sessionManager: {
					getSessionFile: () => file,
					getLeafId: () => liveLeaf,
				} } as unknown as AgentSession,
				sessionFile: file, status: "running",
			});
			const handler = new HistoryProtocolHandler();
			const read = async (query: string): Promise<{
				status: string; leafId?: string; fragment?: string;
				matches?: Array<{ entryId: string }>;
			}> => {
				const resource = await handler.resolve(new URL(`history://Scout?${query}`) as never);
				return JSON.parse(resource.content);
			};

			// Before branching, last stored row matches the active branch.
			expect((await read("entry=abandoned-entry")).status).toBe("ok");
			// branch(root-entry) only changes the live leaf; no JSONL append follows.
			liveLeaf = "root-entry";
			const abandoned = await read("entry=abandoned-entry");
			expect(abandoned.status).toBe("not_on_branch");
			expect(abandoned.leafId).toBe("root-entry");
			const search = await read("q=onlyAbandoned");
			expect(search.status).toBe("ok");
			expect(search.leafId).toBe("root-entry");
			expect(search.matches).toEqual([]);
			const active = await read("entry=root-entry");
			expect(active.status).toBe("ok");
			expect(active.fragment).toContain("root text");

			// The caller may explicitly select a saved, abandoned branch for recall.
			const explicit = await read("entry=abandoned-entry&leaf=abandoned-entry");
			expect(explicit.status).toBe("ok");
			expect(explicit.fragment).toContain("onlyAbandoned");
			expect((await read("q=onlyAbandoned&leaf=abandoned-entry")).matches?.map(hit => hit.entryId))
				.toEqual(["abandoned-entry"]);

			// resetLeaf() may leave an empty branch; never fall back to the disk tail.
			liveLeaf = null;
			await expect(read("entry=abandoned-entry")).rejects.toThrow(/no branch leaf/);
			await expect(read("q=onlyAbandoned")).rejects.toThrow(/no branch leaf/);
			expect((await read("entry=abandoned-entry&leaf=abandoned-entry")).status).toBe("ok");
		} finally {
			await temp.remove();
		}
	});

	it("resolves normally when the process drives one conversation", async () => {
		liveRoot("acp:a", "session-a");
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "acp:a",
			session: { messages: [] } as unknown as AgentSession,
			status: "running",
		});

		const resource = await new HistoryProtocolHandler().resolve(new URL("history://Scout") as never);

		expect(resource.notes).toContain("Source: live session");
	});
});
