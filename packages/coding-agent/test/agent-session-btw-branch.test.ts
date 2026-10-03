import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockHandler } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import { BtwController } from "@veyyon/coding-agent/modes/terminal/controllers/btw-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Container, type TUI } from "@veyyon/tui";
import { Snowflake } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

beforeAll(async () => {
	await initTheme();
});

function createBtwAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Check the failure mode first.", thinkingSignature: "sig" },
			{ type: "redactedThinking", data: "encrypted-side-channel-thinking" },
			{ type: "text", text: "The fix is to branch the side answer." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "side-channel" }] },
	};
}

function expectSanitizedBtwAssistant(message: AssistantMessage): void {
	expect(message.providerPayload).toBeUndefined();
	expect(message.content).toEqual([
		{ type: "thinking", thinking: "Check the failure mode first." },
		{ type: "text", text: "The fix is to branch the side answer." },
	]);
}

function requiredLeafId(session: AgentSession): string {
	const leafId = session.sessionManager.getLeafId();
	if (!leafId) throw new Error("Expected session leaf");
	return leafId;
}

describe("AgentSession.branchFromBtw", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-btw-branch-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(options?: {
		persisted?: boolean;
		extensionRunner?: ExtensionRunner;
		handler?: MockHandler;
	}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: options?.handler ?? (() => ({ content: ["unused"] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager =
			options?.persisted === false ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options?.extensionRunner,
		});
		return session;
	}

	it("creates a persisted branch with the /btw user input and complete assistant message", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 2 });
		activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		expect(originalFile).toBeDefined();
		const originalRaw = fs.readFileSync(originalFile!, "utf8");
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw(
			"why did this fail?",
			assistantMessage,
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result.cancelled).toBe(false);
		expect(result.sessionFile).toBe(activeSession.sessionFile);
		expect(result.sessionFile).toBeDefined();
		expect(result.sessionFile).not.toBe(originalFile);
		expect(fs.readFileSync(originalFile!, "utf8")).toBe(originalRaw);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "why did this fail?" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("honors session_before_branch cancellation without creating a branch", async () => {
		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit,
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const result = await activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result).toEqual({ cancelled: true, sessionFile: originalFile });
		expect(activeSession.sessionFile).toBe(originalFile);
		expect(emit).toHaveBeenCalledWith({
			type: "session_before_branch",
			entryId: activeSession.sessionManager.getLeafId(),
		});
	});

	it("refuses when the session leaf advances while a branch hook is pending", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				hookStarted.resolve();
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const branchPromise = activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);
		await hookStarted.promise;
		activeSession.sessionManager.appendMessage({ role: "user", content: "late work", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		hookRelease.resolve();

		await expect(branchPromise).rejects.toThrow("Cannot branch /btw: session changed since /btw started");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("refuses when the authorized session id no longer matches the loaded session", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		const leafId = requiredLeafId(activeSession);

		// A resumed/branched session preserves the entry id, so the leaf still matches
		// while the loaded session is different.
		await expect(
			activeSession.branchFromBtw("question", createBtwAssistant(), leafId, "some-other-session"),
		).rejects.toThrow("Cannot branch /btw: session changed since /btw started");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("syncs promoted /btw messages into live context even when hooks skip conversation restore", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => ({ skipConversationRestore: true })),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw(
			"question",
			assistantMessage,
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result.cancelled).toBe(false);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("refuses to defer a /btw branch while the main turn is streaming", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const activeSession = await createSession({
			handler: () => {
				providerStarted.resolve();
				return { content: ["main response"], delayMs: 60_000 };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const promptPromise = activeSession.prompt("main prompt");
		await providerStarted.promise;
		expect(activeSession.isStreaming).toBe(true);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");
		expect(activeSession.isStreaming).toBe(true);
		expect(activeSession.sessionFile).toBe(originalFile);

		await activeSession.abort({ goalReason: "internal", reason: "test cleanup" });
		await promptPromise;
	});

	it("refuses to branch /btw while user bash work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();

		const bashPromise = activeSession.executeBash('bun -e "await Bun.sleep(60_000)"', () => undefined, {
			useUserShell: false,
		});
		while (!activeSession.isBashRunning) await Bun.sleep(1);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");

		activeSession.abortBash();
		await bashPromise.catch(() => undefined);
	});

	it("refuses to branch /btw while user Python work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const abortController = new AbortController();
		const execution = Promise.withResolvers<void>().promise;
		activeSession.trackEvalExecution(execution, abortController).catch(() => undefined);
		expect(activeSession.isEvalRunning).toBe(true);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");

		abortController.abort();
	});

	it("refuses to branch /btw while context maintenance is running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const sessionWithMaintenance = activeSession as AgentSession & { _maintenanceForTest?: boolean };
		Object.defineProperty(sessionWithMaintenance, "isCompacting", {
			get: () => sessionWithMaintenance._maintenanceForTest === true,
		});
		sessionWithMaintenance._maintenanceForTest = true;

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");
	});

	it("refuses when post-prompt work starts a turn while a branch hook is pending", async () => {
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		activeSession.queueDeferredMessage({
			role: "custom",
			customType: "test-hidden-message",
			content: "hidden",
			display: false,
			timestamp: Date.now(),
		});
		expect(activeSession.hasPostPromptWork).toBe(true);

		const branchPromise = activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);
		await Promise.resolve();
		hookRelease.resolve();

		await expect(branchPromise).rejects.toThrow(
			"Cannot branch /btw while session maintenance or user work is still running",
		);
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	// WHY: a post-prompt task that never settles (a hung provider stream) must not park a /btw
	// promotion forever. The 5 s drain deadline is the only bound on that wait. Closes the class
	// "branchFromBtw never settles on a stuck drain" for the drain; the extension-hook and flush
	// awaits around it are deliberately unbounded here, as upstream leaves them.
	describe("when a post-prompt task never settles", () => {
		// The hidden turn finishes quickly, then its `agent_end` extension hook never returns: the
		// session is idle (not streaming) but a tracked post-prompt task is still in flight.
		let hookGate = Promise.withResolvers<void>();

		beforeEach(() => {
			hookGate = Promise.withResolvers<void>();
		});

		afterEach(() => {
			hookGate.resolve();
		});

		async function createSessionWithHungDrain() {
			const extensionRunner = {
				hasHandlers: () => false,
				hasUI: () => false,
				emit: async (event: { type: string }) => {
					if (event.type === "agent_end") await hookGate.promise;
					return undefined;
				},
				emitBeforeAgentStart: async () => undefined,
				emitError: () => {},
			} as unknown as ExtensionRunner;
			const activeSession = await createSession({ extensionRunner });
			activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
			await activeSession.sessionManager.flush();
			activeSession.queueDeferredMessage({
				role: "custom",
				customType: "test-hidden-message",
				content: "hidden",
				display: false,
				timestamp: Date.now(),
			});
			for (
				let attempt = 0;
				attempt < 200 && (activeSession.isStreaming || !activeSession.hasPostPromptWork);
				attempt++
			) {
				await sleep(10);
			}
			expect(activeSession.isStreaming).toBe(false);
			expect(activeSession.hasPostPromptWork).toBe(true);
			await activeSession.sessionManager.flush();
			return activeSession;
		}

		it(
			"settles at the drain deadline and leaves the transcript untouched",
			async () => {
				const activeSession = await createSessionWithHungDrain();
				const originalFile = activeSession.sessionFile;
				const leafId = requiredLeafId(activeSession);
				const entryCount = activeSession.sessionManager.getEntries().length;

				const startedAt = performance.now();
				const outcome = await activeSession
					.branchFromBtw("question", createBtwAssistant(), leafId, activeSession.sessionManager.getSessionId())
					.then(
						() => "resolved" as const,
						(error: Error) => error.message,
					);
				const elapsedMs = performance.now() - startedAt;

				expect(outcome).toBe("Timed out draining post-prompt tasks before /btw branch");
				// Waited out the 5 s deadline (not an early refusal) and settled within its bound.
				expect(elapsedMs).toBeGreaterThanOrEqual(4_900);
				expect(elapsedMs).toBeLessThan(8_000);
				expect(activeSession.sessionFile).toBe(originalFile);
				expect(activeSession.sessionManager.getLeafId()).toBe(leafId);
				expect(activeSession.sessionManager.getEntries()).toHaveLength(entryCount);
			},
			{ timeout: 20_000 },
		);

		it(
			"returns the controller to an actionable state after the refused promotion",
			async () => {
				const activeSession = await createSessionWithHungDrain();
				const manager = activeSession.sessionManager;
				const btwContainer = new Container();
				const showStatus = vi.fn();
				const answer = createBtwAssistant();
				const controller = new BtwController({
					ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
					btwContainer,
					session: {
						model: activeSession.model,
						get isStreaming() {
							return activeSession.isStreaming;
						},
						runEphemeralTurn: async () => ({ replyText: "the answer", assistantMessage: answer }),
					} as unknown as InteractiveModeContext["session"],
					sessionManager: manager,
					showStatus,
					showError: vi.fn(),
					handleBtwBranch: (question, assistantMessage, leafId, sessionId) =>
						activeSession.branchFromBtw(question, assistantMessage, leafId, sessionId).then(() => {}),
				});
				await controller.start("question");
				await sleep(0);
				expect(controller.canCopy()).toBe(true);

				const branch = controller.handleBranch().then(
					() => "resolved" as const,
					(error: Error) => error.message,
				);
				expect(controller.handlesBranchKey()).toBe(true);

				expect(await branch).toBe("Timed out draining post-prompt tasks before /btw branch");
				// Not stuck "in progress": Esc dismisses the panel instead of being refused.
				expect(controller.handleEscape()).toBe(true);
				expect(controller.hasActiveRequest()).toBe(false);
				expect(showStatus.mock.calls.some(([msg]) => msg === "/btw branch is in progress")).toBe(false);
			},
			{ timeout: 20_000 },
		);
	});

	it("throws for in-memory sessions", async () => {
		const activeSession = await createSession({ persisted: false });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw: session is not persisted");
	});
});
