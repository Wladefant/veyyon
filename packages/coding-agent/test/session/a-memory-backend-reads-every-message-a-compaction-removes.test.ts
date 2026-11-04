/**
 * Before a compaction, the memory backend reads every message the compaction takes out of context:
 * the messages being summarized and, for a split turn, the prefix of the turn that is cut. What it
 * returns reaches the summarizer as extra context.
 *
 * WHY. `collectMemoryBackendContext` concatenates `messagesToSummarize` and `turnPrefixMessages`.
 * The only suite that drove it used a preparation with an empty prefix, so dropping the prefix
 * passed while a split turn's opening request and tool calls left context without the backend ever
 * reading them.
 *
 * WHAT IT DOES NOT CATCH. Which messages `prepareCompaction` selects; the preparation is fixed here
 * so the split is certain.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { UserMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { MemoryBackend } from "@veyyon/coding-agent/memory/backend";
import * as memoryBackendModule from "@veyyon/coding-agent/memory/backend";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

function userText(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** The text of each message, in order, so a reordering or a dropped message shows. */
function texts(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		if (!("content" in message) || typeof message.content === "string") return String(message.role);
		const first = message.content[0];
		return first && first.type === "text" ? first.text : message.role;
	});
}

describe("a memory backend reads every message a compaction removes", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let dir: TempDir | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		dir?.removeSync();
		session = undefined;
		authStorage = undefined;
		dir = undefined;
	});

	it("passes the summarized messages and the cut turn's prefix, and forwards its answer", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected a bundled anthropic model");
		dir = TempDir.createSync("@memory-compaction-reads-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage(userText("kept", 3));
		const preparation: CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [userText("summarized one", 1), userText("summarized two", 2)],
			turnPrefixMessages: [userText("prefix of the cut turn", 3)],
			recentMessages: [],
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: undefined,
			previousPreserveData: undefined,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...DEFAULT_COMPACTION_SETTINGS, strategy: "summary" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(preparation);

		const read: string[][] = [];
		const memoryBackend: MemoryBackend = {
			id: "local",
			start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
			async preCompactionContext(messages) {
				read.push(texts(messages));
				return "remembered: the parser owns tokenization";
			},
		};
		vi.spyOn(memoryBackendModule, "resolveMemoryBackend").mockResolvedValue(memoryBackend);

		const summarizerContext: string[][] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (prepared, _model, _key, _i, _s, options) => {
			summarizerContext.push([...(options?.extraContext ?? [])]);
			return {
				summary: "summary",
				shortSummary: "short",
				firstKeptEntryId: prepared.firstKeptEntryId,
				tokensBefore: prepared.tokensBefore,
				details: {},
			};
		});

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "summary" }),
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		});

		await session.compact();

		expect(read).toEqual([["summarized one", "summarized two", "prefix of the cut turn"]]);
		expect(summarizerContext).toHaveLength(1);
		expect(summarizerContext[0]).toContainEqual(expect.stringContaining("remembered: the parser owns tokenization"));
	});
});
