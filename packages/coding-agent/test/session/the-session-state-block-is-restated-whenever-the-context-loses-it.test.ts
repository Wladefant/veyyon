/**
 * The date and working directory reach the model in a hidden `session-state` block, stated once and
 * restated only when they change. The model holds them only while that block is in its context.
 *
 * WHY THIS SUITE EXISTS. The block was deduplicated against a record of what had been sent, kept in a
 * field and re-read from the messages only on `/new`, a fork or a session switch. Anything else that
 * took the block out of the context left the record saying it was there:
 *
 *  - a compaction summarized it away, so every request after the first compaction carried no date and
 *    no working directory, for the rest of the session (measured on the shipped binary: a tool loop that
 *    compacts sent the block in its first two requests and in none of the ten after);
 *  - a prompt built the block and then never sent it (the provider call failed, a newer prompt
 *    superseded it), and the record marked it delivered anyway.
 *
 * The compaction also summarized the block: a history holding nothing but it cost a summary request
 * that produced nothing.
 *
 * THE CLASS. A delivered-once block whose dedupe reads anything other than the context the next
 * request sends. Each case removes the block a different way and asserts what the model receives next.
 * Recalled memories are the other member, and their suite is
 * `a-recalled-memory-block-reaches-the-model-once-per-transcript`.
 *
 * WHAT IT DOES NOT CATCH. The restatement after a compaction is an append at the end of the context;
 * where the summary model is told to put the facts is not checked. The aside path a run polls between
 * calls is deliberately not used: an aside polled at the stop boundary forces another model turn.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SESSION_STATE_MESSAGE_TYPE } from "@veyyon/coding-agent/session/nudges";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const dir of dirs.splice(0)) dir.removeSync();
});

async function createSession(settings: Record<string, unknown> = {}): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");
	const dir = TempDir.createSync("@session-state-restated-");
	dirs.push(dir);
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"compaction.strategy": "summary",
			...settings,
		}),
		modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
	});
	sessions.push(session);
	return session;
}

/** Put a message where a real run puts it: the live context and the session file. */
function land(session: AgentSession, message: AgentMessage): void {
	session.agent.appendMessage(message);
	if (message.role === "custom") {
		session.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution,
		);
	} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
		throw new Error(`a prompt never hands the model a ${message.role}`);
	} else {
		session.sessionManager.appendMessage(message);
	}
}

/**
 * Send one prompt through the real session with only the provider call replaced. The replacement
 * lands what it was handed and an answer, the way the agent loop does, or fails before landing
 * anything. Returns the session-state blocks the prompt handed to the model.
 */
async function promptBlocks(session: AgentSession, text: string, outcome: "answer" | "fail" = "answer") {
	const handed: AgentMessage[] = [];
	const spy = vi.spyOn(session.agent, "prompt").mockImplementation(async input => {
		const incoming = Array.isArray(input) ? input : [input as AgentMessage];
		handed.push(...incoming);
		if (outcome === "fail") throw new Error("provider unreachable");
		for (const message of incoming) land(session, message);
		land(session, createAssistantMessage(`answer to ${text}`));
	});
	if (outcome === "fail") await expect(session.prompt(text)).rejects.toThrow("provider unreachable");
	else await session.prompt(text);
	spy.mockRestore();
	return stateBlocks(handed);
}

function stateBlocks(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message =>
		message.role === "custom" &&
		message.customType === SESSION_STATE_MESSAGE_TYPE &&
		typeof message.content === "string"
			? [message.content]
			: [],
	);
}

/** Take every session-state block out of the live context, as a rewind or a rewrite can. */
function dropStateBlocks(session: AgentSession): void {
	session.agent.replaceMessages(
		session.agent.state.messages.filter(
			message => message.role !== "custom" || message.customType !== SESSION_STATE_MESSAGE_TYPE,
		),
	);
}

describe("the session-state block", () => {
	it("is stated once while the context carries it", async () => {
		const session = await createSession();
		const first = await promptBlocks(session, "one");
		expect(first).toHaveLength(1);
		expect(first[0]).toContain("The current working directory is");
		expect(await promptBlocks(session, "two")).toEqual([]);
		expect(stateBlocks(session.agent.state.messages)).toEqual(first);
	});

	it("is stated again by the next prompt after a rewrite took it out of the context", async () => {
		const session = await createSession();
		const [block] = await promptBlocks(session, "one");
		dropStateBlocks(session);
		expect(await promptBlocks(session, "two")).toEqual([block!]);
	});

	it("is stated again after a prompt that built it never sent it", async () => {
		const session = await createSession();
		const failed = await promptBlocks(session, "one", "fail");
		expect(failed).toHaveLength(1);
		expect(stateBlocks(session.agent.state.messages)).toEqual([]);
		expect(await promptBlocks(session, "two")).toEqual(failed);
	});

	it("reaches the model once when the prompt that states it first compacts the context", async () => {
		// The prompt's own size trips the pre-prompt compaction, which restates the block. A prompt
		// that built the block before compacting would send it a second time beside the restatement.
		const session = await createSession({ "compaction.enabled": true, "compaction.threshold": "1000" });
		const [block] = await promptBlocks(session, "one");
		await promptBlocks(session, "two");
		dropStateBlocks(session);
		const summarized = spyOnSummaries();

		expect(await promptBlocks(session, "large ".repeat(2_000))).toEqual([]);
		expect(summarized).toEqual([{ history: ["one", "answer to one"], turnPrefix: ["two"] }]);
		expect(stateBlocks(session.agent.state.messages)).toEqual([block!]);
	});

	it("goes back into the context and the session file when a compaction summarizes it, and is never summarized", async () => {
		const session = await createSession();
		const [block] = await promptBlocks(session, "one");
		await promptBlocks(session, "two");
		await promptBlocks(session, "three");

		const summarized = spyOnSummaries();
		await session.compact();

		expect(summarized).toEqual([
			{ history: ["one", "answer to one", "two", "answer to two"], turnPrefix: ["three"] },
		]);
		expect(stateBlocks(session.agent.state.messages)).toEqual([block!]);
		expect(stateBlocks(session.buildDisplaySessionContext().messages)).toEqual([block!]);
		expect(await promptBlocks(session, "four")).toEqual([]);
	});

	it("leaves the history summary nothing to read when it is the whole history before the cut", async () => {
		// An empty history is what lets the summarizer skip the history request and send only the
		// cut turn's prefix; handing it the block alone cost a request that summarized nothing.
		const session = await createSession();
		const [block] = await promptBlocks(session, "only");

		const summarized = spyOnSummaries();
		await session.compact();

		expect(summarized).toEqual([{ history: [], turnPrefix: ["only"] }]);
		expect(stateBlocks(session.agent.state.messages)).toEqual([block!]);
	});

	it("leaves a compaction with nothing new after it, so the next one reports it is already compacted", async () => {
		// The restated block is the newest entry of the session file after a compaction. It is not
		// history, so a second pass straight after must not summarize the kept tail again.
		const session = await createSession();
		await promptBlocks(session, "one");
		await promptBlocks(session, "two");
		const summarized = spyOnSummaries();
		await session.compact();

		await expect(session.compact()).rejects.toThrow("Already compacted");
		expect(summarized).toHaveLength(1);
	});
});

interface Summarized {
	history: string[];
	turnPrefix: string[];
}

/** Record what each compaction hands its summary requests, answering without a model. */
function spyOnSummaries(): Summarized[] {
	const summarized: Summarized[] = [];
	vi.spyOn(compactionModule, "compact").mockImplementation(async prepared => {
		summarized.push({ history: texts(prepared.messagesToSummarize), turnPrefix: texts(prepared.turnPrefixMessages) });
		return {
			summary: "summary",
			firstKeptEntryId: prepared.firstKeptEntryId,
			tokensBefore: prepared.tokensBefore,
			details: {},
		};
	});
	return summarized;
}

/** The text of each message in order; a hidden block shows as its type so a leak is visible. */
function texts(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		if (message.role === "custom") return message.customType;
		if (!("content" in message) || typeof message.content === "string") return String(message.role);
		const first = message.content[0];
		return first && first.type === "text" ? first.text : message.role;
	});
}
