/** The per-turn supersede selector must not destroy the older file snapshot. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@veyyon/agent-core";
import { SUPERSEDED_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import type { AssistantMessage } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HistoryRewrites } from "@veyyon/coding-agent/session/runtime/history-rewrites";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

const USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const OLD_TEXT = "old snapshot\tΩ 😀\r\n".repeat(8_000);

describe("stale reads retain their original evidence", () => {
	let temp: TempDir;
	let manager: SessionManager;
	let storage: FileSessionStorage;
	let agent: Agent;
	let rewrites: HistoryRewrites;
	let oldId: string;
	let latestId: string;
	let file: string;

	function read(callId: string, text: string): string {
		const call: AssistantMessage = {
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "src/state.ts" } }],
			stopReason: "toolUse", usage: USAGE, timestamp: Date.now(),
		};
		manager.appendMessage(call);
		return manager.appendMessage({
			role: "toolResult", toolCallId: callId, toolName: "read", isError: false,
			content: [{ type: "text", text }], details: { path: "src/state.ts", revision: callId }, timestamp: Date.now(),
		});
	}

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-stale-recovery-");
		storage = new FileSessionStorage();
		manager = SessionManager.create(temp.path(), temp.path(), storage);
		manager.appendMessage({ role: "user", content: "Compare the old and new file contents.", timestamp: Date.now() });
		oldId = read("read-old", OLD_TEXT);
		latestId = read("read-latest", "the current snapshot");
		await manager.flush();
		file = manager.getSessionFile()!;
		agent = new Agent({ initialState: { tools: [], systemPrompt: ["Test"], messages: manager.buildSessionContext().messages } });
		rewrites = new HistoryRewrites({
			sessionStore: manager, agent,
			settings: Settings.isolated({ "compaction.supersedeReads": true, "compaction.dropUseless": false }),
			withPlanProtection: config => config, model: () => undefined, keepBoundaryId: () => undefined,
			rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => {}, closeCodexSessions: () => {}, markHistoryRewritten: () => {}, syncTodos: () => {},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		await temp.remove();
	});

	it("keeps the latest result and recovers the exact older entry after reload", async () => {
		const old = JSON.parse(JSON.stringify(manager.getEntry(oldId)));
		const latest = JSON.parse(JSON.stringify(manager.getEntry(latestId)));
		const outcome = await rewrites.pruneStale();
		expect(outcome?.prunedCount).toBe(1);
		expect(outcome?.tokensSaved).toBeGreaterThan(0);
		const reloaded = await SessionManager.open(file, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			const entry = reloaded.getEntry(oldId);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected pruned result");
			expect(entry.message.content[0]).toEqual({ type: "text", text: SUPERSEDED_NOTICE });
			const id = JSON.stringify(entry.message.content).match(/artifact:\/\/([^\s)]+)/)?.[1];
			if (!id) throw new Error("Expected recovery reference");
			const path = await reloaded.getArtifactPath(id);
			if (!path) throw new Error("Expected archive on disk");
			const archive = JSON.parse(await fs.readFile(path, "utf8"));
			expect(archive.operation).toBe("prune-stale");
			expect(archive.entries).toEqual([old]);
			expect(reloaded.getEntry(latestId)).toEqual(latest);
			expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
		} finally { await reloaded.close(); }
		const disk = await fs.readFile(file, "utf8");
		expect(await rewrites.pruneStale()).toBeUndefined();
		expect(await fs.readFile(file, "utf8")).toBe(disk);
	});

	for (const failure of ["archive-id", "archive-write", "transcript-write"] as const) {
		it(`preserves both snapshots when ${failure} fails`, async () => {
			const before = JSON.stringify(manager.getBranch());
			const live = JSON.stringify(agent.state.messages);
			const disk = await fs.readFile(file, "utf8");
			if (failure === "archive-id") vi.spyOn(manager, "saveArtifact").mockResolvedValue(undefined);
			if (failure === "archive-write") vi.spyOn(manager, "saveArtifact").mockRejectedValue(new Error("archive failure"));
			if (failure === "transcript-write") {
				vi.spyOn(storage, "writeTextAtomic").mockRejectedValue(new Error("transcript failure"));
				vi.spyOn(storage, "rewriteTailAtomic").mockRejectedValue(new Error("transcript failure"));
			}
			await expect(rewrites.pruneStale()).rejects.toThrow();
			expect(JSON.stringify(manager.getBranch())).toBe(before);
			expect(JSON.stringify(agent.state.messages)).toBe(live);
			expect(await fs.readFile(file, "utf8")).toBe(disk);
		});
	}
});
