/**
 * WHY: a classifier refusal that arrives after the model streamed a tool call is not written to the
 * session log, but the agent loop still answers each of its calls with a never-ran placeholder
 * result, and those placeholders were written. The live context drops the refused turn together
 * with its placeholders, so the session that ran it stayed clean; the log kept a tool result with
 * no call. A resume rebuilt the context from that log, and `transformMessages` folds an unpaired
 * result into a user note, so the refusal text ("Refusal (cyber): ...") reached the model on every
 * later request of the resumed session.
 *
 * The class this closes: a never-ran placeholder that answers no call, on both sides of the log.
 * The writer side drives the real `AgentSession` and `Agent` against a file-backed
 * `SessionManager`, reopens the file, and replays it into a second agent; the reader side builds
 * the context of a log that already holds such a placeholder, as logs written before the fix do.
 *
 * What it does not catch: an unpaired result whose tool ran. That one keeps its fold into a user
 * note, because its output is real, and the reader case below pins that it is kept.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Context } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { buildSessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

const REFUSAL_TEXT = "Refusal (cyber): Classifier declined this turn.";
const REFUSED_CALL_ID = "toolu_refused_eval";

/** Call ids a message list answers with a result but never asks for. */
function unpairedResultIds(messages: readonly AgentMessage[]): string[] {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") callIds.add(block.id);
		}
	}
	return messages.flatMap(message =>
		message.role === "toolResult" && !callIds.has(message.toolCallId) ? [message.toolCallId] : [],
	);
}

/** Whether a provider request carries the refusal text anywhere in its messages. */
function replaysRefusal(context: Context): boolean {
	return JSON.stringify(context.messages).includes("Classifier declined this turn.");
}

describe("a classifier refusal with a streamed tool call", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-refused-turn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function startSession(sessionManager: SessionManager, agent: Agent): AgentSession {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);
		return session;
	}

	it("leaves no placeholder result in the log, so a resumed session never replays the refusal", async () => {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const replayedLive: boolean[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: REFUSED_CALL_ID, name: "eval", arguments: { code: "1 + 1" } }],
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
					errorMessage: REFUSAL_TEXT,
				},
				context => {
					replayedLive.push(replaysRefusal(context));
					return { content: ["answered"] };
				},
			],
		});
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const session = startSession(
			sessionManager,
			new Agent({
				getApiKey: () => "anthropic-test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
			}),
		);
		const placeholders: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				placeholders.push(event.message.toolCallId);
			}
		});

		await session.prompt("Run the check");
		await session.waitForIdle();
		await session.prompt("Try again");
		await session.waitForIdle();
		await sessionManager.flush();

		// The loop did answer the refused call: the defect's precondition holds, and the live
		// context of the running session was already clean.
		expect(placeholders).toEqual([REFUSED_CALL_ID]);
		expect(replayedLive).toEqual([false]);

		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a file-backed session");
		const reopened = await SessionManager.open(file, sessionDir);
		const logged = reopened
			.getEntries()
			.flatMap(entry => (entry.type === "message" ? [entry.message as AgentMessage] : []));
		expect(unpairedResultIds(logged)).toEqual([]);
		expect(JSON.stringify(logged)).not.toContain(REFUSAL_TEXT);

		const resumed = reopened.buildSessionContext().messages;
		const replayedAfterResume: boolean[] = [];
		const resumeMock = createMockModel({
			handler: context => {
				replayedAfterResume.push(replaysRefusal(context));
				return { content: ["resumed"] };
			},
		});
		const resumedSession = startSession(
			reopened,
			new Agent({
				getApiKey: () => "anthropic-test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: resumed },
				streamFn: (streamModel, context, options) => resumeMock.stream(streamModel, context, options),
			}),
		);
		await resumedSession.prompt("Continue");
		await resumedSession.waitForIdle();
		expect(replayedAfterResume).toEqual([false]);
	});
});

describe("the context rebuilt from a log that already holds an unpaired result", () => {
	const at = "2026-01-01T00:00:00Z";

	function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
		return { type: "message", id, parentId, timestamp: at, message };
	}

	function assistantCalling(callIds: string[], timestamp: number): AssistantMessage {
		return {
			role: "assistant",
			content: callIds.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
			stopReason: "toolUse",
			timestamp,
		};
	}

	function result(callId: string, timestamp: number, details: unknown, text: string): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text }],
			details,
			isError: details !== undefined,
			timestamp,
		};
	}

	const neverRan = { __synthetic: true, source: "assistant_stop_error", executed: false, upstreamError: REFUSAL_TEXT };
	const entries: SessionEntry[] = [
		entry("u1", null, { role: "user", content: "start", timestamp: 1 }),
		// The refused turn itself was never written; only its placeholder was.
		entry("orphan-never-ran", "u1", result("toolu_refused", 2, neverRan, `not executed: ${REFUSAL_TEXT}`)),
		// An interrupt reached this call after its tool was entered: the side effects are real.
		entry(
			"orphan-entered",
			"orphan-never-ran",
			result("toolu_entered", 3, { __skipped: true, source: "steering", entered: true }, "partial output"),
		),
		// An unpaired result with no placeholder details is a result whose tool ran.
		entry("orphan-ran", "orphan-entered", result("toolu_ran", 4, undefined, "file contents")),
		// A placeholder and a result that ran, under one id no call declares: only the placeholder goes.
		entry("twice-never-ran", "orphan-ran", result("toolu_twice", 5, neverRan, "not executed")),
		entry("twice-ran", "twice-never-ran", result("toolu_twice", 6, undefined, "ran after all")),
		entry(
			"a1",
			"twice-ran",
			assistantCalling(["toolu_paired_1", "toolu_paired_2", "toolu_late_1", "toolu_late_2"], 7),
		),
		// Never-ran placeholders that answer calls on the path are the turn's own pairing.
		entry("paired-1", "a1", result("toolu_paired_1", 8, neverRan, "not executed")),
		entry("paired-2", "paired-1", result("toolu_paired_2", 9, neverRan, "not executed")),
		entry("a2", "paired-2", assistantCalling(["toolu_next"], 10)),
		entry("next", "a2", result("toolu_next", 11, undefined, "next output")),
		// Placeholders written behind a later turn still answer their calls on the earlier one.
		entry("late-1", "next", result("toolu_late_1", 12, neverRan, "not executed")),
		entry("late-2", "late-1", result("toolu_late_2", 13, neverRan, "not executed")),
		entry("u2", "late-2", { role: "user", content: "next", timestamp: 14 }),
	];

	function resultIds(messages: readonly AgentMessage[]): string[] {
		return messages.flatMap(message =>
			message.role === "toolResult" ? [`${message.toolCallId}:${toolResultText(message)}`] : [],
		);
	}

	function toolResultText(message: AgentMessage): string {
		if (message.role !== "toolResult") return "";
		const block = message.content[0];
		return block?.type === "text" ? block.text : "";
	}

	it("drops a never-ran placeholder that answers no call, and keeps every result whose tool ran", () => {
		const { messages } = buildSessionContext(entries);
		expect(resultIds(messages)).toEqual([
			"toolu_entered:partial output",
			"toolu_ran:file contents",
			"toolu_twice:ran after all",
			"toolu_paired_1:not executed",
			"toolu_paired_2:not executed",
			"toolu_next:next output",
			"toolu_late_1:not executed",
			"toolu_late_2:not executed",
		]);
	});

	it("keeps the placeholder in the display transcript, which shows what the log holds", () => {
		const { messages } = buildSessionContext(entries, undefined, undefined, { transcript: true });
		expect(resultIds(messages)).toEqual([
			`toolu_refused:not executed: ${REFUSAL_TEXT}`,
			"toolu_entered:partial output",
			"toolu_ran:file contents",
			"toolu_twice:not executed",
			"toolu_twice:ran after all",
			"toolu_paired_1:not executed",
			"toolu_paired_2:not executed",
			"toolu_next:next output",
			"toolu_late_1:not executed",
			"toolu_late_2:not executed",
		]);
	});
});
