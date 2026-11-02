import * as path from "node:path";
import { setImmediate as yieldToTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@veyyon/coding-agent/tools/agent/todo";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("AgentSession external turn refresh", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-external-turn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("does not append a prompt after abort while external-turn refresh is pending", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = vi.spyOn(sessionManager, "refreshExternalTurn").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return false;
		});
		const promptCall = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const promptPromise = session.prompt("interrupted prompt");
		let abortPromise: Promise<void> | undefined;
		let abortSettled = false;
		try {
			await entered.promise;
			abortPromise = session.abort().then(() => { abortSettled = true; });
			await yieldToTurn();
			const abortWasPendingBeforeRelease = !abortSettled;
			release.resolve();
			await Promise.all([promptPromise, abortPromise]);
			expect(promptCall).not.toHaveBeenCalled();
			expect(sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")).toHaveLength(0);
			expect(abortWasPendingBeforeRelease).toBe(true);
		} finally {
			release.resolve();
			await Promise.allSettled([promptPromise, ...(abortPromise ? [abortPromise] : [])]);
		}
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("adopts todo state from an externally appended completed turn", async () => {
		const original = [{ name: "Local", tasks: [{ content: "old task", status: "pending" as const }] }];
		const external = [{ name: "External", tasks: [{ content: "new task", status: "completed" as const }] }];
		session.setTodoPhases(original);
		sessionManager.appendMessage({ role: "user", content: "local work", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "local done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		const externalSessionManager = await SessionManager.open(sessionManager.getSessionFile()!, tempDir.path());
		externalSessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: external });
		externalSessionManager.appendMessage({ role: "user", content: "external work", timestamp: Date.now() });
		externalSessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: Date.now(),
		});
		await externalSessionManager.flush();
		await externalSessionManager.close();

		expect(await session.refreshExternalTurn()).toBe(true);
		expect(session.getTodoPhases()).toEqual(external);
	});
});
