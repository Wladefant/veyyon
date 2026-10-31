// WHY: A 32-byte useless result can grow after adding its recovery reference. This suite covers all-skip, mixed, stale, and overflow cost decisions; it does not measure provider billing or RSS.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@veyyon/agent-core";
import { USELESS_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import { estimateTokens } from "@veyyon/agent-core/compaction/token-estimate";
import type { AssistantMessage } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HistoryRewrites } from "@veyyon/coding-agent/session/runtime/history-rewrites";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const SMALL_RESULT = "neutral ".repeat(4);
const PROFITABLE_RESULT = "neutral ".repeat(12);
const OVERFLOW_RESULT = "neutral ".repeat(10_250);

type UselessPruneHarness = {
	temp: TempDir;
	manager: SessionManager;
	agent: Agent;
	rewrites: HistoryRewrites;
	file: string;
	entryIds: string[];
};

async function createHarness(texts: readonly string[]): Promise<UselessPruneHarness> {
	const temp = TempDir.createSync("@veyyon-useless-recovery-cost-");
	const manager = SessionManager.create(temp.path(), temp.path(), new FileSessionStorage());
	try {
		manager.appendMessage({ role: "user", content: "Search for neutral terms.", timestamp: Date.now() });
		const entryIds = texts.map((text, index) => {
			const toolCallId = `search-${index}`;
			const call: AssistantMessage = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				content: [{ type: "toolCall", id: toolCallId, name: "search", arguments: { query: "neutral" } }],
				stopReason: "toolUse",
				usage: USAGE,
				timestamp: Date.now(),
			};
			manager.appendMessage(call);
			return manager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "search",
				isError: false,
				useless: true,
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
		});
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const agent = new Agent({
			initialState: { tools: [], systemPrompt: ["Test"], messages: manager.buildSessionContext().messages },
		});
		const rewrites = new HistoryRewrites({
			sessionStore: manager,
			agent,
			settings: Settings.isolated({ "compaction.supersedeReads": false, "compaction.dropUseless": true }),
			withPlanProtection: config => config,
			model: () => undefined,
			keepBoundaryId: () => undefined,
			rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => {},
			closeCodexSessions: () => {},
			markHistoryRewritten: () => {},
			syncTodos: () => {},
		});
		return { temp, manager, agent, rewrites, file, entryIds };
	} catch (error) {
		await manager.close();
		await temp.remove();
		throw error;
	}
}

function getToolResult(manager: SessionManager, id: string) {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message" || entry.message.role !== "toolResult") {
		throw new Error("Expected a persisted tool result");
	}
	return entry;
}

async function closeHarness(harness: UselessPruneHarness): Promise<void> {
	await harness.manager.close();
	await harness.temp.remove();
}

describe("useless pruning pays for its recovery reference", () => {
	it("leaves a boundary-sized latest stale result untouched", async () => {
		const harness = await createHarness([SMALL_RESULT]);
		try {
			const entryId = harness.entryIds[0]!;
			const originalEntry = structuredClone(getToolResult(harness.manager, entryId));
			const branchBefore = structuredClone(harness.manager.getBranch());
			const agentBefore = structuredClone(harness.agent.state.messages);
			const diskBefore = await fs.readFile(harness.file, "utf8");

			expect(SMALL_RESULT).toHaveLength(32);
			expect(estimateTokens(originalEntry.message)).toBe(8);
			expect(await harness.rewrites.pruneStale()).toBeUndefined();
			expect(harness.manager.getBranch()).toEqual(branchBefore);
			expect(harness.agent.state.messages).toEqual(agentBefore);
			expect(getToolResult(harness.manager, entryId)).toEqual(originalEntry);
			expect(await fs.readFile(harness.file, "utf8")).toBe(diskBefore);
		} finally {
			await closeHarness(harness);
		}
	});

	it("archives and shrinks a profitable stale useless result", async () => {
		const harness = await createHarness([PROFITABLE_RESULT]);
		let reloaded: SessionManager | undefined;
		try {
			const entryId = harness.entryIds[0]!;
			const originalEntry = structuredClone(getToolResult(harness.manager, entryId));
			if (originalEntry.message.role !== "toolResult") throw new Error("Expected a tool result");
			const originalTokens = estimateTokens(originalEntry.message);

			const outcome = await harness.rewrites.pruneStale();
			expect(outcome?.prunedCount).toBe(1);
			expect(outcome?.tokensSaved).toBeGreaterThan(0);
			const replacement = getToolResult(harness.manager, entryId);
			if (replacement.message.role !== "toolResult") throw new Error("Expected the rewritten tool result");
			expect(replacement.message.content).toContainEqual({ type: "text", text: USELESS_NOTICE });
			expect(estimateTokens(replacement.message)).toBeLessThan(originalTokens);
			const reference = JSON.stringify(replacement.message.content).match(/artifact:\/\/([^\s)]+)/)?.[1];
			expect(reference).toBeDefined();
			expect(harness.agent.state.messages).toEqual(harness.manager.buildSessionContext().messages);

			reloaded = await SessionManager.open(harness.file, harness.temp.path(), undefined, { suppressBreadcrumb: true });
			expect(reloaded.getEntry(entryId)).toEqual(replacement);
			expect(reloaded.getBranch()).toEqual(harness.manager.getBranch());
			const artifactPath = await reloaded.getArtifactPath(reference!);
			if (!artifactPath) throw new Error("Expected the recovery artifact to exist after reload");
			const archive = JSON.parse(await fs.readFile(artifactPath, "utf8"));
			expect(archive.entries).toEqual([originalEntry]);
			expect(archive.operation).toBe("prune-stale");
		} finally {
			if (reloaded) await reloaded.close();
			await closeHarness(harness);
		}
	});

	it("counts only profitable entries in a mixed stale batch", async () => {
		const harness = await createHarness([PROFITABLE_RESULT, SMALL_RESULT]);
		let reloaded: SessionManager | undefined;
		try {
			const [profitableId, smallId] = harness.entryIds;
			if (!profitableId || !smallId) throw new Error("Expected both tool results");
			const profitableOriginal = structuredClone(getToolResult(harness.manager, profitableId));
			const smallOriginal = structuredClone(getToolResult(harness.manager, smallId));
			const diskBefore = await fs.readFile(harness.file, "utf8");

			const outcome = await harness.rewrites.pruneStale();
			expect(outcome?.prunedCount).toBe(1);
			expect(outcome?.tokensSaved).toBeGreaterThan(0);
			expect(getToolResult(harness.manager, smallId)).toEqual(smallOriginal);
			const profitableReplacement = getToolResult(harness.manager, profitableId);
			expect(profitableReplacement.message).not.toEqual(profitableOriginal.message);
			expect(profitableReplacement.message.content).toContainEqual({ type: "text", text: USELESS_NOTICE });
			expect(harness.agent.state.messages).toEqual(harness.manager.buildSessionContext().messages);

			reloaded = await SessionManager.open(harness.file, harness.temp.path(), undefined, { suppressBreadcrumb: true });
			expect(reloaded.getEntry(smallId)).toEqual(smallOriginal);
			expect(reloaded.getEntry(profitableId)).toEqual(profitableReplacement);
			const text = JSON.stringify(profitableReplacement.message.content);
			const artifactId = text.match(/artifact:\/\/([^\s)]+)/)?.[1];
			expect(artifactId).toBeDefined();
			const artifactPath = await reloaded.getArtifactPath(artifactId!);
			if (!artifactPath) throw new Error("Expected the batch recovery artifact to exist");
			const archive: { entries: Array<typeof profitableOriginal> } = JSON.parse(await fs.readFile(artifactPath, "utf8"));
			expect(archive.entries).toContainEqual(profitableOriginal);
			const archivedSmall = archive.entries.find(entry => entry.id === smallOriginal.id);
			if (archivedSmall) expect(archivedSmall).toEqual(smallOriginal);
			expect(await fs.readFile(harness.file, "utf8")).not.toBe(diskBefore);
		} finally {
			if (reloaded) await reloaded.close();
			await closeHarness(harness);
		}
	});

	it("keeps boundary-sized entries out of an overflow batch while pruning profitable output", async () => {
		const harness = await createHarness([OVERFLOW_RESULT, SMALL_RESULT]);
		let reloaded: SessionManager | undefined;
		try {
			const [profitableId, smallId] = harness.entryIds;
			if (!profitableId || !smallId) throw new Error("Expected both tool results");
			const profitableOriginal = structuredClone(getToolResult(harness.manager, profitableId));
			const smallOriginal = structuredClone(getToolResult(harness.manager, smallId));
			if (profitableOriginal.message.role !== "toolResult") throw new Error("Expected a tool result");
			expect(estimateTokens(profitableOriginal.message)).toBeGreaterThan(20_000);

			const outcome = await harness.rewrites.pruneOverflow();
			expect(outcome?.prunedCount).toBe(1);
			expect(outcome?.tokensSaved).toBeGreaterThan(20_000);
			expect(getToolResult(harness.manager, smallId)).toEqual(smallOriginal);
			const profitableReplacement = getToolResult(harness.manager, profitableId);
			expect(profitableReplacement.message).not.toEqual(profitableOriginal.message);
			expect(harness.agent.state.messages).toEqual(harness.manager.buildSessionContext().messages);

			reloaded = await SessionManager.open(harness.file, harness.temp.path(), undefined, { suppressBreadcrumb: true });
			expect(reloaded.getEntry(smallId)).toEqual(smallOriginal);
			expect(reloaded.getEntry(profitableId)).toEqual(profitableReplacement);
			const artifactId = JSON.stringify(profitableReplacement.message.content).match(/artifact:\/\/([^\s)]+)/)?.[1];
			expect(artifactId).toBeDefined();
			const artifactPath = await reloaded.getArtifactPath(artifactId!);
			if (!artifactPath) throw new Error("Expected the overflow recovery artifact to exist");
			const archive: { entries: Array<typeof profitableOriginal> } = JSON.parse(await fs.readFile(artifactPath, "utf8"));
			expect(archive.entries).toContainEqual(profitableOriginal);
			const archivedSmall = archive.entries.find(entry => entry.id === smallOriginal.id);
			if (archivedSmall) expect(archivedSmall).toEqual(smallOriginal);
		} finally {
			if (reloaded) await reloaded.close();
			await closeHarness(harness);
		}
	});
});
