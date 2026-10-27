// WHY: with context promotion on, a context that crosses the compaction threshold switches to the
// model's larger-context sibling and keeps its history whole; compaction is the fallback when no
// such model can take over. Mutation testing of `session/runtime/turn-context-check.ts` found the
// promotion step of the pre-prompt and mid-run checks unpinned (removing it compacted a session
// that should have moved to the larger model), and three of the conditions on the target unpinned:
// its key has to resolve, its window has to be strictly larger, and the switch must not become the
// model a resumed session restores.
//
// Class closed: every threshold check (before a prompt, between the provider calls of a tool loop,
// after an overflow) tries promotion before it compacts, and promotion picks only a target that can
// serve the request. The suite drives the real `AgentSession` with a scripted provider stream and
// the summary call replaced at its module export.
//
// Not caught: the advisor roster's use of the same target, which its own suites cover, and the
// queued-message hand-off a mid-run compaction suppresses, which the core loop delivers either way.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { getRestorableSessionModels } from "@veyyon/kernel/session/session-context";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const OVERFLOW_ERROR = "context_length_exceeded: Your input exceeds the context window of this model.";

function usage(input: number): AssistantMessage["usage"] {
	return {
		input,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantFrom(
	model: Model,
	fields: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">,
	input: number,
): AssistantMessage {
	return {
		role: "assistant" as const,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(input),
		timestamp: Date.now(),
		...fields,
	};
}

describe("a context past the threshold moves to a larger model before it compacts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let smallModel: Model;
	let largeModel: Model;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-context-promotion-boundaries-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const spark = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const promoted = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!spark || !promoted) throw new Error("Expected the codex spark model and its promotion target");
		smallModel = spark;
		largeModel = promoted;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	function thresholdSettings(overrides: Record<string, unknown>): Settings {
		return Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.autoContinue": false,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": true,
			"todo.enabled": false,
			"todo.reminders": false,
			...overrides,
		});
	}

	/** A session whose provider answers each call through `reply`, recording the model it was called with. */
	function scriptedSession(
		settings: Settings,
		reply: (model: Model, index: number) => AssistantMessage,
	): { session: AgentSession; sessionManager: SessionManager; calledWith: string[] } {
		const calledWith: string[] = [];
		const bash: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Scripted bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "tool output" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: smallModel, systemPrompt: ["Test"], tools: [bash], messages: [] },
			convertToLlm,
			streamFn: model => {
				calledWith.push(model.id);
				const message = reply(model, calledWith.length - 1);
				const reason = message.stopReason;
				if (reason !== "stop" && reason !== "toolUse")
					throw new Error(`A scripted turn ends a call, not ${reason}`);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[bash.name, bash]]),
		});
		return { session, sessionManager, calledWith };
	}

	/** A session that holds `model` and whose last turn overflowed its context. */
	async function overflowedSession(model: Model): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const created = new AgentSession({
			agent,
			sessionManager,
			settings: thresholdSettings({ "compaction.enabled": false }),
			modelRegistry,
		});
		session = created;
		const overflow = assistantFrom(
			model,
			{ content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: OVERFLOW_ERROR },
			0,
		);
		created.agent.emitExternalEvent({ type: "message_end", message: overflow });
		created.agent.emitExternalEvent({ type: "agent_end", messages: [overflow] });
		// The agent_end handler is fire-and-forget; one macrotask runs it and waitForIdle settles the
		// retry a promotion schedules.
		await new Promise(resolve => setTimeout(resolve, 0));
		await created.waitForIdle();
		return { session: created, sessionManager };
	}

	function summaryCall(): void {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "COMPACTED-INSTEAD-OF-PROMOTED",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	function compactionsOn(sessionManager: SessionManager): number {
		return sessionManager.getEntries().filter(entry => entry.type === "compaction").length;
	}

	it("runs a prompt that would cross the threshold on the larger model, history whole", async () => {
		summaryCall();
		const { session, sessionManager, calledWith } = scriptedSession(
			thresholdSettings({ "compaction.midTurnEnabled": false }),
			model => assistantFrom(model, { content: [{ type: "text", text: "Done." }], stopReason: "stop" }, 100),
		);

		await session.prompt(`Review this:\n${"lorem ipsum dolor sit amet ".repeat(800)}`);

		expect(calledWith).toEqual([largeModel.id]);
		expect(compactionsOn(sessionManager)).toBe(0);
	});

	it("moves a tool loop that crosses the threshold to the larger model instead of compacting it", async () => {
		summaryCall();
		const { session, sessionManager, calledWith } = scriptedSession(
			thresholdSettings({ "compaction.midTurnEnabled": true }),
			(model, index) =>
				index === 0
					? assistantFrom(
							model,
							{
								content: [{ type: "toolCall", id: "tc-0", name: "bash", arguments: {} }],
								stopReason: "toolUse",
							},
							50_000,
						)
					: assistantFrom(model, { content: [{ type: "text", text: "Done." }], stopReason: "stop" }, 100),
		);

		await session.prompt("work on the release");

		expect(calledWith[0]).toBe(smallModel.id);
		expect(session.model?.id).toBe(largeModel.id);
		expect(compactionsOn(sessionManager)).toBe(0);
	});

	it("keeps the model when the larger model's key does not resolve", async () => {
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);

		const { session } = await overflowedSession(smallModel);

		expect(session.model?.id).toBe(smallModel.id);
	});

	it("promotes only to a strictly larger window", async () => {
		const largeWindow = largeModel.contextWindow ?? 0;
		expect(largeWindow).toBeGreaterThan(1);

		const sameWindow = await overflowedSession({ ...smallModel, contextWindow: largeWindow });
		expect(sameWindow.session.model?.id).toBe(smallModel.id);
		await sameWindow.session.dispose();
		session = undefined;

		const smallerWindow = await overflowedSession({ ...smallModel, contextWindow: largeWindow - 1 });
		expect(smallerWindow.session.model?.id).toBe(largeModel.id);
	});

	it("does not make the promoted model the one a resumed session restores", async () => {
		const { session, sessionManager } = await overflowedSession(smallModel);
		expect(session.model?.id).toBe(largeModel.id);

		const restored = getRestorableSessionModels(
			sessionManager.buildSessionContext().models,
			sessionManager.getLastModelChangeRole(),
		);
		expect(restored).not.toContain(`${largeModel.provider}/${largeModel.id}`);
	});
});
