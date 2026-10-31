// WHY: a steer or follow-up waits on the agent's queues until a run polls them. Three things can
// deliver it: the turn that is streaming, an auto-retry's next attempt, or the one turn the session
// starts on a resting queue (`QueuedMessages.scheduleDrain`). Each queued message must reach exactly
// one of them. A drain started beside a run that will poll the queue anyway races it, and one held
// back when nothing else will run leaves the message sitting in the queue chip until the next manual
// prompt. Mutation testing of `session/runtime/queued-messages.ts` found these branches unpinned:
// lifting the user-interrupt hold on a queued user message, draining a hidden developer follow-up,
// resuming a follow-up behind a tool result, standing down while a turn streams or a retry backs off,
// and counting a prompt that waits for the agent to go idle or a hidden next-turn message.
//
// Class closed: every way a message enters the queues on a resting session (user steer, user
// follow-up, hidden developer follow-up) is delivered by one turn the session starts, every way a
// run is already coming (a streaming turn, a retry backoff) delivers it without a second start, and
// every turn still coming counts in `queuedMessageCount`. The suite drives the real `AgentSession`
// over a stub provider and asserts on the provider calls and on the continuation verdicts the
// session logs, so a drain that starts beside a coming run, or never starts, turns it red.
//
// Not caught: which tails a follow-up may resume from beyond assistant and tool result (the
// advisor-card and IRC cases are pinned in agent-session-advisor-suppression.test.ts), and the
// order of the steers inside one turn, which is the agent loop's.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Message } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { QueuedMessages } from "@veyyon/coding-agent/session/runtime/queued-messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const originalSchedulerWait = scheduler.wait.bind(scheduler);

/** A retry backoff long enough to tell apart from the short waits the session schedules. */
const RETRY_BASE_DELAY_MS = 4_000;
/** Below the backoff after its downward jitter, above every other wait the session schedules. */
const BACKOFF_FLOOR_MS = 1_000;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await originalSchedulerWait(1);
	}
	throw new Error("Timed out waiting for condition");
}

function messageText(message: AgentMessage | Message): string {
	if (!("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** What the stub provider does on one call: answer, stay open until released or aborted, or fail retryably. */
type CallPlan = "reply" | "hold" | "until-aborted" | "overloaded";

function overloadedTurn(): AssistantMessage {
	return { ...createAssistantMessage(""), stopReason: "error", errorMessage: "503 service unavailable" };
}

function toolCallTurn(): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "notes.md" } }],
		stopReason: "toolUse",
	};
}

describe("a queued message starts a turn only when no run will deliver it", () => {
	let session: AgentSession;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	/** One entry per provider call: the messages that call was given. */
	let providerCalls: Message[][];
	/** The stub's plan for each call by index; a call past the end replies. */
	let plans: CallPlan[];
	/** Released to answer every call planned as `hold`. */
	let heldCalls: PromiseWithResolvers<void>;
	/** While set, a wait of the retry backoff's length stays open until it resolves. */
	let backoffHeld: PromiseWithResolvers<void> | undefined;
	/** Every logged verdict of a scheduled continuation that did not run: skipped (debug) or refused (warn). */
	let continueVerdicts: string[];

	beforeEach(async () => {
		providerCalls = [];
		plans = [];
		heldCalls = Promise.withResolvers<void>();
		backoffHeld = undefined;
		continueVerdicts = [];
		vi.spyOn(scheduler, "wait").mockImplementation((delayMs, options) => {
			if (backoffHeld && delayMs !== undefined && delayMs >= BACKOFF_FLOOR_MS) return backoffHeld.promise;
			return originalSchedulerWait(0, options);
		});
		const warn = logger.warn.bind(logger);
		vi.spyOn(logger, "warn").mockImplementation((message: string, context?: Record<string, unknown>) => {
			if (message === "agent.continue failed after scheduling") {
				continueVerdicts.push(`${message}: ${String(context?.error ?? "")}`);
			}
			warn(message, context);
		});
		const debug = logger.debug.bind(logger);
		vi.spyOn(logger, "debug").mockImplementation((message: string, context?: Record<string, unknown>) => {
			if (message === "agent.continue skipped after scheduling") {
				continueVerdicts.push(`${message}: ${String(context?.reason ?? "")}`);
			}
			debug(message, context);
		});
		tempDir = await TempDir.create("veyyon-queued-message-drain");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		heldCalls.resolve();
		backoffHeld?.resolve();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	function createSession(options: { messages?: AgentMessage[]; settings?: Record<string, unknown> } = {}): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: options.messages ?? [] },
			convertToLlm,
			streamFn: (_model, context, streamOptions) => {
				providerCalls.push([...context.messages]);
				const call = providerCalls.length;
				const plan = plans[call - 1] ?? "reply";
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const done = () =>
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage(`Reply ${call}`) });
					if (plan === "reply") done();
					else if (plan === "hold") void heldCalls.promise.then(done);
					else if (plan === "overloaded") stream.push({ type: "error", reason: "error", error: overloadedTurn() });
					else {
						streamOptions?.signal?.addEventListener(
							"abort",
							() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
							{ once: true },
						);
					}
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "retry.enabled": false, ...options.settings }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
	}

	/** A session resting after one answered exchange. */
	function createRestingSession(): void {
		createSession({
			messages: [
				{ role: "user", content: "Earlier question", timestamp: Date.now() },
				createAssistantMessage("Done"),
			],
		});
	}

	/** The newest user message of each provider call, by its text. */
	function newestUserPrompts(): string[] {
		return providerCalls.map(messages => messageText(messages.findLast(m => m.role === "user")!));
	}

	it("starts one turn for a burst of steers on a resting session and delivers each", async () => {
		createRestingSession();

		await Promise.all([session.steer("First steer"), session.steer("Second steer"), session.steer("Third steer")]);
		await waitFor(() => providerCalls.length > 0);
		await session.waitForIdle();

		// Every steer after the first finds the drained turn already coming: none schedules a start
		// that would then find the agent busy.
		expect(continueVerdicts).toEqual([]);
		const delivered = providerCalls
			.at(-1)!
			.filter(m => m.role === "user")
			.map(messageText);
		expect(delivered.slice(-3)).toEqual(["First steer", "Second steer", "Third steer"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(session.isStreaming).toBe(false);
	});

	it("leaves a steer queued while a turn streams to that turn", async () => {
		createSession();
		plans = ["hold"];
		const firstPrompt = session.prompt("First message");
		await waitFor(() => providerCalls.length === 1);

		await session.steer("Steer mid-turn");
		heldCalls.resolve();
		await firstPrompt;
		await session.waitForIdle();

		expect(continueVerdicts).toEqual([]);
		expect(newestUserPrompts()).toEqual(["First message", "Steer mid-turn"]);
		expect(session.isStreaming).toBe(false);
	});

	// A prompted turn keeps the session streaming through its retry; a turn the session started on a
	// queued message settles first and leaves only the retry coming.
	it.each([
		{ start: "a prompt", begin: (s: AgentSession) => s.prompt("First message") },
		{ start: "a queued steer", begin: (s: AgentSession) => s.steer("First message") },
	])(
		"leaves a steer queued during the auto-retry backoff of a turn $start started to the retry",
		async ({ begin }) => {
			createSession({
				messages: [
					{ role: "user", content: "Earlier question", timestamp: Date.now() },
					createAssistantMessage("Done"),
				],
				settings: { "retry.enabled": true, "retry.baseDelayMs": RETRY_BASE_DELAY_MS },
			});
			plans = ["overloaded"];
			backoffHeld = Promise.withResolvers<void>();
			const started = begin(session);
			await waitFor(() => session.isRetrying);

			await session.steer("Steer during the backoff");
			// Bound: a drain started beside the retry makes its provider call inside this window.
			await originalSchedulerWait(50);
			expect(providerCalls).toHaveLength(1);

			backoffHeld.resolve();
			await started;
			await waitFor(() => providerCalls.length === 2);
			await session.waitForIdle();

			expect(continueVerdicts).toEqual([]);
			// The retry re-attempts the failed turn with the steer injected; no call is made twice.
			expect(providerCalls).toHaveLength(2);
			expect(providerCalls[1]!.filter(m => m.role === "user").map(messageText)).toEqual([
				"Earlier question",
				"First message",
				"Steer during the backoff",
			]);
			expect(session.isStreaming).toBe(false);
		},
	);

	it("starts a turn for a follow-up queued behind a tool result", async () => {
		createSession({
			messages: [
				{ role: "user", content: "Read the notes", timestamp: Date.now() },
				toolCallTurn(),
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "Interrupted" }],
					isError: true,
					timestamp: Date.now(),
				},
			],
		});

		await session.followUp("Then summarize them");
		await waitFor(() => providerCalls.length > 0);
		await session.waitForIdle();

		expect(continueVerdicts).toEqual([]);
		expect(newestUserPrompts().at(-1)).toBe("Then summarize them");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	it("starts a turn for a hidden developer follow-up on a resting session", async () => {
		createRestingSession();

		await session.followUp("Carry out the approved plan", undefined, { synthetic: true });
		await waitFor(() => providerCalls.length > 0);
		await session.waitForIdle();

		expect(continueVerdicts).toEqual([]);
		expect(providerCalls).toHaveLength(1);
		expect(messageText(providerCalls[0]!.at(-1)!)).toContain("Carry out the approved plan");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("starts a turn for a user follow-up sent after an interrupt", async () => {
		createSession();
		plans = ["until-aborted"];
		const firstPrompt = session.prompt("First message");
		await waitFor(() => providerCalls.length === 1);
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await firstPrompt;

		// The interrupt holds back follow-ups the agent queued; one the user sends is a deliberate resume.
		await session.followUp("Resume with this");
		await waitFor(() => providerCalls.length === 2);
		await session.waitForIdle();

		expect(newestUserPrompts()).toEqual(["First message", "Resume with this"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(session.isStreaming).toBe(false);
	});

	it("counts a hidden next-turn message as queued work", async () => {
		createSession();
		plans = ["hold"];
		const firstPrompt = session.prompt("First message");
		await waitFor(() => providerCalls.length === 1);

		await session.sendCustomMessage(
			{ customType: "build-reminder", content: "Check the build", display: false, attribution: "agent" },
			{ deliverAs: "nextTurn" },
		);

		expect(session.queuedMessageCount).toBe(1);
		heldCalls.resolve();
		await firstPrompt;
	});

	it("counts a turn waiting for the agent to go idle as queued work", async () => {
		createSession();
		plans = ["hold"];
		const firstPrompt = session.prompt("First message");
		await waitFor(() => providerCalls.length === 1);
		let idleWaits = 0;
		const waitOnIdle = QueuedMessages.prototype.whileWaitingOnIdle;
		vi.spyOn(QueuedMessages.prototype, "whileWaitingOnIdle").mockImplementation(function (
			this: QueuedMessages,
			wait: () => Promise<void>,
		) {
			idleWaits += 1;
			return waitOnIdle.call(this, wait);
		});

		// The requested turn leases its message off the next-turn queue and waits for the busy agent.
		await session.sendCustomMessage(
			{ customType: "build-reminder", content: "Check the build", display: false, attribution: "agent" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		await waitFor(() => idleWaits === 1);

		expect(session.queuedMessageCount).toBe(1);
		heldCalls.resolve();
		await firstPrompt;
		await waitFor(() => providerCalls.length === 2);
		await session.waitForIdle();
		expect(session.queuedMessageCount).toBe(0);
		expect(messageText(providerCalls[1]!.at(-1)!)).toContain("Check the build");
	});
});
