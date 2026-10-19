import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";

describe("60s session heartbeat interval", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	async function createSession(): Promise<AgentSession> {
		tempDir = TempDir.createSync("@pi-heartbeat-test-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry,
		});
		return session;
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			tempDir?.removeSync();
			tempDir = undefined;
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it("logs a session heartbeat JSON line every 60s with pid, sessionId, and phase", async () => {
		const s = await createSession();
		const infoSpy = vi.spyOn(logger, "info");

		// Initially, no heartbeat logged
		expect(infoSpy).not.toHaveBeenCalledWith("Session heartbeat", expect.anything());

		// 59 seconds: no heartbeat yet
		vi.advanceTimersByTime(59_000);
		expect(infoSpy).not.toHaveBeenCalledWith("Session heartbeat", expect.anything());

		// 60 seconds: first heartbeat logged with empty string phase
		vi.advanceTimersByTime(1_000);
		expect(infoSpy).toHaveBeenCalledWith("Session heartbeat", {
			pid: process.pid,
			sessionId: s.sessionManager.getSessionId(),
			phase: "",
		});

		// Tool starts in flight
		s.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "call_test_1",
			toolName: "bash",
			args: { command: "ls" },
		});

		// 120 seconds total: heartbeat logged with tool name phase
		vi.advanceTimersByTime(60_000);
		expect(infoSpy).toHaveBeenCalledWith("Session heartbeat", {
			pid: process.pid,
			sessionId: s.sessionManager.getSessionId(),
			phase: "bash",
		});

		// Tool ends
		s.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "call_test_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
		});

		// 180 seconds total: heartbeat logged with empty string phase again
		vi.advanceTimersByTime(60_000);
		expect(infoSpy).toHaveBeenCalledWith("Session heartbeat", {
			pid: process.pid,
			sessionId: s.sessionManager.getSessionId(),
			phase: "",
		});
	});

	it("clears the heartbeat interval on session exit/dispose", async () => {
		const s = await createSession();
		const infoSpy = vi.spyOn(logger, "info");

		// Advance 60s to confirm it was logging
		vi.advanceTimersByTime(60_000);
		expect(infoSpy).toHaveBeenCalledTimes(1);

		// Dispose session (exit path)
		await s.dispose();
		session = undefined;
		infoSpy.mockClear();

		// Advance another 180s: no heartbeats logged
		vi.advanceTimersByTime(180_000);
		expect(infoSpy).not.toHaveBeenCalledWith("Session heartbeat", expect.anything());
	});

	it("wraps the heartbeat log call so an exception cannot break the session", async () => {
		await createSession();
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {
			throw new Error("Simulated logger failure");
		});

		// Advancing 60s invokes interval callback which must not throw or crash
		expect(() => {
			vi.advanceTimersByTime(60_000);
		}).not.toThrow();
		expect(infoSpy).toHaveBeenCalledTimes(1);
	});
});
