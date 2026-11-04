/**
 * WHY: threshold pruning used to replace recorded results without a recovery copy. These cases
 * drive the production collaborator with a real session manager and artifact store, and observe
 * the persisted transcript, live agent messages, and original recovery entries. They cover an
 * absent archive ID, rejected archive/persistence writes, and a branch change during archival.
 * They do not qualify provider compaction or storage failure after an atomic rename has committed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@veyyon/agent-core";
import { USELESS_NOTICE } from "@veyyon/agent-core/compaction/pruning";
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
const ORIGINAL_TEXT = "  original line\twith exact whitespace Ω 😀\r\n".repeat(20_000);

describe("a history prune preserves original evidence", () => {
	let temp: TempDir;
	let manager: SessionManager;
	let storage: FileSessionStorage;
	let agent: Agent;
	let rewrites: HistoryRewrites;
	let resultId: string;
	let file: string;

	function appendAssistant(call = false): void {
		const message: AssistantMessage = {
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
			content: call
				? [{ type: "toolCall", id: "call-example", name: "search", arguments: { query: "fixture" } }]
				: [{ type: "text", text: "Continue the task." }],
			stopReason: call ? "toolUse" : "stop", usage: USAGE,
			timestamp: Date.now(),
		};
		manager.appendMessage(message);
	}

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-prune-recovery-");
		storage = new FileSessionStorage();
		manager = SessionManager.create(temp.path(), temp.path(), storage);
		manager.appendMessage({ role: "user", content: "Find the item.", timestamp: Date.now() });
		appendAssistant(true);
		resultId = manager.appendMessage({
			role: "toolResult", toolCallId: "call-example", toolName: "search", isError: false,
			content: [{ type: "text", text: ORIGINAL_TEXT }], useless: true,
			details: { source: "fixture", selected: [1, 3] }, timestamp: Date.now(),
		});
		appendAssistant();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted history");
		file = sessionFile;
		agent = new Agent({ initialState: { tools: [], systemPrompt: ["Test"], messages: manager.buildSessionContext().messages } });
		rewrites = new HistoryRewrites({
			sessionStore: manager,
			agent,
			settings: Settings.isolated({ "compaction.dropUseless": true, "compaction.supersedeReads": true }),
			withPlanProtection: config => config,
			model: () => undefined,
			keepBoundaryId: () => undefined,
			rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => {},
			closeCodexSessions: () => {},
			markHistoryRewritten: () => {},
			syncTodos: () => {},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		await temp.remove();
	});

	it("preserves the exact original entry and a recovery reference across reload", async () => {
		const original = JSON.parse(JSON.stringify(manager.getEntry(resultId)));
		const outcome = await rewrites.pruneOverflow();
		expect(outcome?.prunedCount).toBe(1);
		const reloaded = await SessionManager.open(file, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			const entry = reloaded.getEntry(resultId);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected result");
			expect(entry.message.content[0]).toEqual({ type: "text", text: USELESS_NOTICE });
			const reference = JSON.stringify(entry.message.content).match(/artifact:\/\/([^\s)]+)/)?.[1];
			if (!reference) throw new Error("Expected recovery reference");
			const artifactPath = await reloaded.getArtifactPath(reference);
			if (!artifactPath) throw new Error("Expected a persisted recovery artifact");
			const archive = JSON.parse(await fs.readFile(artifactPath, "utf8"));
			expect(archive.version).toBe(1);
			expect(archive.operation).toBe("prune-overflow");
			expect(archive.entries).toEqual([original]);
			expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
		} finally {
			await reloaded.close();
		}
	});

	for (const failure of ["missing-id", "archive-write", "transcript-write"] as const) {
		it(`retains live and persisted originals when ${failure} fails`, async () => {
			const branchBefore = JSON.stringify(manager.getBranch());
			const liveBefore = JSON.stringify(agent.state.messages);
			const diskBefore = await fs.readFile(file, "utf8");
			if (failure === "missing-id") vi.spyOn(manager, "saveArtifact").mockResolvedValue(undefined);
			if (failure === "archive-write") vi.spyOn(manager, "saveArtifact").mockRejectedValue(new Error("archive unavailable"));
			if (failure === "transcript-write") {
				vi.spyOn(storage, "writeTextAtomic").mockRejectedValue(new Error("transcript unavailable"));
				vi.spyOn(storage, "rewriteTailAtomic").mockRejectedValue(new Error("transcript unavailable"));
			}
			await expect(rewrites.pruneOverflow()).rejects.toThrow();
			expect(JSON.stringify(manager.getBranch())).toBe(branchBefore);
			expect(JSON.stringify(agent.state.messages)).toBe(liveBefore);
			expect(await fs.readFile(file, "utf8")).toBe(diskBefore);
		});
	}

	it("does not publish a stale prune after the branch changes during archival", async () => {
		const saving = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, type) => {
			saving.resolve();
			await release.promise;
			return save(content, type);
		});
		const operation = rewrites.pruneOverflow().then(() => null, error => error);
		await saving.promise;
		const original = JSON.stringify(manager.getEntry(resultId));
		manager.appendMessage({ role: "user", content: "A newer decision arrived.", timestamp: Date.now() });
		release.resolve();
		const failure = await operation;
		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toContain("changed while preserving");
		expect(JSON.stringify(manager.getEntry(resultId))).toBe(original);
		await manager.flush();
		expect(await fs.readFile(file, "utf8")).toContain("A newer decision arrived.");
	});
});
