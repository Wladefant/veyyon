/**
 * WHY THIS SUITE EXISTS. Hidden context queued for the next turn (a reminder, a parked advisor
 * concern, an extension's `deliverAs: "nextTurn"` message) leaves the queue when a prompt starts
 * building its input, which is before the slow steps of that build: file mentions, memories, the
 * `before_agent_start` hooks, auto thinking and pre-prompt compaction. A prompt that never reached the
 * agent, because the user interrupted it there or a step threw, dropped the queue it took, and the
 * next turn ran without the context nobody had seen yet.
 *
 * THE CLASS. Every way a prompt holding the queue ends without handing it to the agent: an interrupt
 * (the generation bail-out after the take), a throw, and a requested turn that is interrupted while
 * its own input is built or while it waits for a busy agent. In each the queued context reaches the
 * next turn once, the message a requested turn was started on is dropped with the interrupt, an
 * interrupt's own handling of the queue (an advisor concern made visible) still reaches what the
 * prompt holds, and a session started fresh in the meantime keeps none of the old session's queue.
 * A turn the agent took, a prompt's or a requested one, carries the context once and never again.
 *
 * WHAT IT DOES NOT CATCH. A turn the agent accepted and then failed: its input is in the transcript
 * and is not queued again. The hold is the file-mention read, standing in for every awaited step
 * between the take and the agent; a step that clears the queue on its own is not exercised.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockHandler, type MockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type CustomMessage, USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { QueuedMessages } from "@veyyon/coding-agent/session/runtime/queued-messages";
import * as fileMentions from "@veyyon/coding-agent/utils/file-mentions";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";

const NOTE = "NOTE-FOR-THE-NEXT-TURN";
const CONTINUATION = "CONTINUATION-THE-INTERRUPT-CANCELS";
const ADVICE = "ADVICE-PARKED-FOR-THE-NEXT-TURN";

interface Harness {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly mock: MockModel;
}

let tempDir: TempDir;
let session: AgentSession | undefined;
const authStorages: AuthStorage[] = [];
/** The first turn is streaming; see {@link heldFirstTurn}. */
let streaming = Promise.withResolvers<void>();
/** Lets the first turn finish. */
let release = Promise.withResolvers<void>();

beforeEach(() => {
	tempDir = TempDir.createSync("@next-turn-survives-");
	streaming = Promise.withResolvers<void>();
	release = Promise.withResolvers<void>();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	await tempDir.remove();
});

async function openSession(responses: MockHandler[]): Promise<Harness> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
	const mock = createMockModel({ responses, handler: { content: ["later"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory();
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
	});
	return { session, sessionManager, mock };
}

/**
 * Run one turn and, while it streams, queue `queue` for the next turn; the turn then ends normally,
 * leaving the queue waiting for whatever prompt comes next.
 */
async function queueWhileStreaming(target: AgentSession, queue: (target: AgentSession) => Promise<void>) {
	const turn = target.prompt("first");
	await streaming.promise;
	await queue(target);
	release.resolve();
	await turn;
	await target.waitForIdle();
}

/** The first model call: holds the turn open until the test has queued what it needs. */
const heldFirstTurn: MockHandler = async () => {
	streaming.resolve();
	await release.promise;
	return { content: ["first answer"] };
};

function queueNote(target: AgentSession): Promise<void> {
	return target
		.sendCustomMessage({ customType: "deferred-note", content: NOTE, display: false }, { deliverAs: "nextTurn" })
		.then(() => undefined);
}

/** A hidden message that requests a turn of its own, as a `session_stop` hook or a nudge queues one. */
function continuation(suffix = ""): CustomMessage {
	return {
		role: "custom",
		customType: "deferred-continuation",
		content: `${CONTINUATION} ${suffix}`.trim(),
		display: false,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

/**
 * Hold the next prompt's input build at its file-mention read, which runs after the prompt took the
 * queue. Resolves `reached` once the prompt is held there.
 */
function holdAtFileMentions(outcome: "resolve" | "reject" = "resolve") {
	const reached = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	spyOn(fileMentions, "generateFileMentionMessages").mockImplementation(async () => {
		reached.resolve();
		await held.promise;
		if (outcome === "reject") throw new Error("the file-mention read failed");
		return [];
	});
	return { reached: reached.promise, let: () => held.resolve() };
}

/**
 * How many messages of the agent's transcript carry `marker`: the input every turn took. The bare
 * agent here sends only user and assistant turns to the model, so the model calls cannot show it.
 */
function inInput(target: AgentSession, marker: string): number {
	return target.agent.state.messages.filter(message => JSON.stringify(message).includes(marker)).length;
}

function isAdvisorCard(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === "advisor";
}

describe("context queued for the next turn", () => {
	it("reaches the next turn once when the user interrupts the prompt that took it", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, queueNote);

		const hold = holdAtFileMentions();
		const interrupted = session.prompt("look at @notes.md");
		await hold.reached;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		hold.let();
		await interrupted;
		await session.waitForIdle();
		vi.restoreAllMocks();

		await session.prompt("third");
		await session.prompt("fourth");

		expect(mock.calls).toHaveLength(3);
		expect(inInput(session, NOTE)).toBe(1);
	});

	it("reaches one turn when a requested turn the agent took starts on it", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, queueNote);

		session.queueDeferredMessage(continuation());
		await session.waitForIdle();
		await session.prompt("third");

		expect(mock.calls).toHaveLength(3);
		expect(inInput(session, NOTE)).toBe(1);
		expect(inInput(session, CONTINUATION)).toBe(1);
	});

	it("reaches the next turn once when a requested turn waiting on a busy agent is interrupted", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		const first = session.prompt("first");
		await streaming.promise;
		await queueNote(session);
		// Lands while the first turn still runs, so it waits for the agent to go idle.
		const waiting = Promise.withResolvers<void>();
		const waitOnIdle = QueuedMessages.prototype.whileWaitingOnIdle;
		spyOn(QueuedMessages.prototype, "whileWaitingOnIdle").mockImplementation(function (
			this: QueuedMessages,
			wait: () => Promise<void>,
		) {
			waiting.resolve();
			return waitOnIdle.call(this, wait);
		});
		session.queueDeferredMessage(continuation());
		await waiting.promise;
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		release.resolve();
		await aborting;
		await first;
		await session.waitForIdle();

		await session.prompt("third");

		expect(mock.calls).toHaveLength(2);
		expect(inInput(session, NOTE)).toBe(1);
		expect(inInput(session, CONTINUATION)).toBe(0);
	});

	it("reaches the next turn once when building the prompt that took it throws", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, queueNote);

		const hold = holdAtFileMentions("reject");
		const failing = session.prompt("look at @notes.md");
		await hold.reached;
		hold.let();
		await expect(failing).rejects.toThrow("the file-mention read failed");
		vi.restoreAllMocks();

		await session.prompt("third");

		expect(mock.calls).toHaveLength(2);
		expect(inInput(session, NOTE)).toBe(1);
	});

	it("reaches the next turn once, without the continuation, when a requested turn is interrupted", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, queueNote);

		const hold = holdAtFileMentions();
		session.queueDeferredMessage(continuation("read @notes.md"));
		await hold.reached;
		// An interrupt waits for a requested turn it cannot cancel, so the hold is let go behind it.
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		hold.let();
		await aborting;
		await session.waitForIdle();
		vi.restoreAllMocks();

		await session.prompt("third");

		expect(mock.calls).toHaveLength(2);
		expect(inInput(session, NOTE)).toBe(1);
		expect(inInput(session, CONTINUATION)).toBe(0);
	});

	it("still turns a parked advisor concern into visible advice, once, when the user interrupts", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, async target => {
			await target.sendCustomMessage(
				{ customType: "advisor", content: ADVICE, display: true, attribution: "agent" },
				{ deliverAs: "nextTurn" },
			);
		});

		const hold = holdAtFileMentions();
		const interrupted = session.prompt("look at @notes.md");
		await hold.reached;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		hold.let();
		await interrupted;
		await session.waitForIdle();
		vi.restoreAllMocks();

		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);

		await session.prompt("third");

		expect(mock.calls).toHaveLength(2);
		expect(inInput(session, ADVICE)).toBe(1);
	});

	it("is not carried into a session started fresh while the prompt that took it was held", async () => {
		const { session, mock } = await openSession([heldFirstTurn]);
		await queueWhileStreaming(session, queueNote);

		const hold = holdAtFileMentions();
		const interrupted = session.prompt("look at @notes.md");
		await hold.reached;
		const fresh = session.newSession();
		hold.let();
		await interrupted;
		expect(await fresh).toBe(true);
		await session.waitForIdle();
		vi.restoreAllMocks();

		await session.prompt("third");

		expect(mock.calls).toHaveLength(2);
		expect(inInput(session, NOTE)).toBe(0);
	});
});
