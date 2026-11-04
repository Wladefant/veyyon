import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createSessionTeardown } from "@veyyon/coding-agent/modes/terminal/session-teardown";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@veyyon/kernel/session/exit-diagnostics";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem, TempDir } from "@veyyon/utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		const exitEntry = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("signal teardown persists the postmortem reason, not the generic dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-signal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const activeSession = session;

		// The assistant message persists through an async queue; the tool start
		// marker is appended synchronously and is what makes the session durable
		// enough for #recordSessionExit to write the exit entry (same setup as
		// the plain-dispose test above).
		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		// Mirror InteractiveMode.init(): the postmortem "session-teardown"
		// callback runs FIRST on SIGTERM/SIGHUP/uncaughtException (reverse
		// registration order) and calls dispose(). Without reason threading,
		// #doDispose would persist the generic "dispose"/"normal" and cancel the
		// reason-specific agent-session recorder — losing the real trigger.
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => activeSession.beginDispose(),
			saveDraft: async () => {},
			flushSettings: async () => {},
			disposeSession: reason => activeSession.dispose({ reason }),
		});

		await teardown(postmortem.Reason.SIGTERM);
		session = undefined;

		const exitEntry = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "sigterm",
			kind: "signal",
		});
	});

	it("does not materialize an empty session just to write an exit marker", async () => {
		tempDir = TempDir.createSync("@pi-empty-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.dispose();
		session = undefined;

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE),
		).toBe(false);
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	// A Cursor exec id carries a newline; the loop renames a repeated block `<id>_<n>`. Recorded
	// sessions held one such repeat per exec call, answered by the original's result and never by
	// its own, and the resume warning listed every one of them as pending.
	const cursorId = (index: number) =>
		`call-00000000-0000-4000-8000-000000000000-${index}\nfc_00000000-0000-4000-8000-000000000001_${index}`;
	const cursorBatch = (calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) =>
		({
			...pendingAssistant,
			provider: "cursor",
			stopReason: "error",
			errorMessage: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
			content: calls.map(call => ({ type: "toolCall" as const, ...call })),
		}) satisfies AssistantMessage;
	const answer = (sessionManager: SessionManager, toolCallId: string, toolName: string) =>
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

	it("does not report a renamed repeat of an answered call as pending", () => {
		const sessionManager = SessionManager.inMemory();
		const calls = [0, 1].flatMap(index => [
			{ id: cursorId(index), name: "read", arguments: { path: `src/file-${index}.ts` } },
			{ id: `${cursorId(index)}_2`, name: "read", arguments: { path: `src/file-${index}.ts` } },
		]);
		sessionManager.appendMessage(cursorBatch(calls));
		answer(sessionManager, cursorId(0), "read");
		answer(sessionManager, cursorId(1), "read");

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	it("reports an unanswered call once, not once per recorded repeat", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(
			cursorBatch([
				{ id: cursorId(0), name: "bash", arguments: { command: "make" } },
				{ id: `${cursorId(0)}_2`, name: "bash", arguments: { command: "make" } },
			]),
		);

		expect(collectPendingToolCalls(sessionManager.getBranch()).map(call => call.toolCallId)).toEqual([cursorId(0)]);
	});

	it("still reports a suffixed call that differs from the call it resembles", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(
			cursorBatch([
				{ id: "call_0", name: "read", arguments: { path: "a.ts" } },
				{ id: "call_0_2", name: "read", arguments: { path: "b.ts" } },
				{ id: "call_0_3", name: "bash", arguments: { path: "a.ts" } },
			]),
		);
		answer(sessionManager, "call_0", "read");

		expect(collectPendingToolCalls(sessionManager.getBranch()).map(call => call.toolCallId)).toEqual([
			"call_0_2",
			"call_0_3",
		]);
	});

	it("keeps the resume warning to one bounded line for a large batch", () => {
		const sessionManager = SessionManager.inMemory();
		const command = `printf '%s\\n' ${"x".repeat(500)}`;
		sessionManager.appendMessage(
			cursorBatch(
				Array.from({ length: 89 }, (_, index) => ({ id: cursorId(index), name: "bash", arguments: { command } })),
			),
		);

		const warning = describePendingToolCalls(sessionManager.getBranch());
		expect(warning).toStartWith("Previous session ended while 89 tool calls remained pending: bash ");
		expect(warning).toContain(", and 86 more.");
		expect(warning).not.toContain("\n");
		expect(warning).not.toContain(cursorId(3).split("\n")[0]);
		expect(warning!.length).toBeLessThan(700);
	});

	it("reconstructs an abnormal process-exit tail as one terminal aborted assistant message", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "partial result stays in history" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const recovered = createInterruptedTurnAbortMessage(sessionManager.getBranch());
		expect(recovered).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
		expect(recovered?.errorMessage).toContain("process exited");

		sessionManager.appendMessage(recovered!);
		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(part => part.type === "text" && part.text === "partial result stays in history"),
				),
		).toBe(true);
	});

	it("reconstructs a normal exit that reports pending tool calls", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("ignores malformed pending tool diagnostics on normal exits", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: "not an array",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an interrupted assistant tool-call tail", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("reconstructs tool-call content even when stopReason is stop", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("does not reconstruct a failed tool turn already closed by synthetic results", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "error" });
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution stopped after model failure." }],
			isError: true,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs a first user-message tail with selected model metadata", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(
			createInterruptedTurnAbortMessage(sessionManager.getBranch(), {
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
			}),
		).toMatchObject({
			role: "assistant",
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("does not reconstruct clean, completed, or superseded exits", () => {
		const normalExit = SessionManager.inMemory();
		normalExit.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		normalExit.appendMessage(pendingAssistant);
		normalExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const completedTurn = SessionManager.inMemory();
		completedTurn.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		completedTurn.appendMessage({
			...pendingAssistant,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		});
		completedTurn.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const supersededExit = SessionManager.inMemory();
		supersededExit.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
		supersededExit.appendMessage(pendingAssistant);
		supersededExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		supersededExit.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });

		expect(createInterruptedTurnAbortMessage(normalExit.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(completedTurn.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(supersededExit.getBranch())).toBeUndefined();
	});
});
