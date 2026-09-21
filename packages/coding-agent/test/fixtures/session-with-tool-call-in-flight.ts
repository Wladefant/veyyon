#!/usr/bin/env bun
/**
 * Test fixture: a real `AgentSession` that enters a tool call and then waits to
 * be killed, so its death can be an unrecorded one.
 *
 * The defect this serves (veyyon#73) is a process terminated BELOW JavaScript:
 * no exit record, no error line, nothing in the log naming what it was doing.
 * That cannot be faked in-process — a caller that merely refrains from clearing
 * the marker would prove nothing about the real start/end wiring — so the test
 * spawns this, kills it, and reads what the next launch says.
 *
 * `argv[2]` selects the arm:
 *
 * - `abandon`     enter the tool call, print `ready`, hang. The parent kills it.
 * - `complete`    enter the tool call, leave it, print `ready`, hang. Killed too,
 *                 but the call had returned, so nothing is abandoned.
 * - `clean-exit`  enter the tool call and dispose normally. The exit record is
 *                 the account of this one; no crash may be reported for it.
 * - `report`      construct a session, which sweeps markers into the log, and exit.
 *
 * `argv[3]` is the directory for the session's auth database.
 */
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const mode = process.argv[2];
const stateDir = process.argv[3];

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "toolu_inflight", name: "bash", arguments: { command: "ssh host true" } }],
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

async function run(): Promise<void> {
	const authStorage = await AuthStorage.create(path.join(stateDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const sessionManager = SessionManager.inMemory(stateDir);
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});

	if (mode === "report") {
		await session.dispose();
		process.stdout.write("done\n");
		// Recovery must already be on disk even when no event-loop turn can drain the logger.
		process.exit(0);
	}

	agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
	await Promise.resolve();
	agent.emitExternalEvent({
		type: "tool_execution_start",
		toolCallId: "toolu_inflight",
		toolName: "bash",
		args: { command: "ssh host true" },
	});
	await Promise.resolve();

	if (mode === "cross-session") {
		const otherAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const otherSession = new AgentSession({
			agent: otherAgent,
			sessionManager: SessionManager.inMemory(stateDir),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		otherAgent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		otherAgent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_inflight",
			toolName: "bash",
			args: {},
		});
		await Promise.resolve();
		await otherSession.dispose();
	}

	if (mode === "concurrent") {
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_short",
			toolName: "read",
			args: {},
		});
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "toolu_short",
			toolName: "read",
			result: { content: [{ type: "text", text: "" }] },
		});
		await Promise.resolve();
	}

	if (mode === "change-id-complete" || mode === "change-id-dispose") {
		const previousId = sessionManager.getSessionId();
		await sessionManager.newSession();
		if (sessionManager.getSessionId() === previousId) throw new Error("Expected a new session identity");
	}

	if (mode === "complete" || mode === "change-id-complete") {
		agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "toolu_inflight",
			toolName: "bash",
			result: { content: [{ type: "text", text: "" }] },
		});
		await Promise.resolve();
	}

	if (mode === "clean-exit" || mode === "change-id-dispose") {
		await session.dispose();
		process.stdout.write("done\n");
		return;
	}

	process.stdout.write(`ready ${sessionManager.getSessionId()}\n`);
	// Hold the process open for the parent's kill. An interval rather than a long
	// timer so the event loop has work on every platform's scheduler.
	setInterval(() => {}, 1000);
}

await run();
