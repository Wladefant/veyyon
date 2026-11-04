// WHY: a scheduled continuation (`#scheduleAgentContinue`) checks the session, then awaits the
// fallback-primary restore, then calls `agent.continue()`. A second start that lands in that gap,
// another continuation scheduled at the same settle or a queued-message drain, begins a run first,
// and the continuation's `agent.continue()` throws `AgentBusyError`, logged as "agent.continue
// failed after scheduling" after every user interrupt that left a queued message and at the
// settle a retry shares with a follow-up drain.
//
// Class closed: every continuation the session schedules, whatever scheduled it, yields to a run
// that already started instead of calling `agent.continue()` on a busy agent. The run that started
// reads the state the continuation was scheduled for and polls the same queues, so the suite also
// asserts that nothing is lost: each queued message reaches a provider call and the session settles
// idle.
//
// Not caught: a direct `agent.continue()` outside `#scheduleAgentContinue` (the TTSR resume and the
// loop guard), which handle the busy refusal at their own call site.
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
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const originalSchedulerWait = scheduler.wait.bind(scheduler);

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

/** What the stub provider does on its first call: stay open until aborted, or fail. */
type FirstCall = "stream-until-aborted" | "fail";

function failedTurn(): AssistantMessage {
	return { ...createAssistantMessage(""), stopReason: "error", errorMessage: "400 invalid request" };
}

describe("a scheduled continuation yields to a run another start began", () => {
	let session: AgentSession;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	/** One entry per provider call: the messages that call was given. */
	let providerCalls: Message[][];
	let firstCall: FirstCall;
	/** `logger.warn` lines as `message: error`, so a failure shows which refusal it was. */
	let warnings: string[];
	/** Every logged verdict of a scheduled continuation: skipped (debug) or refused (warn). */
	let continueVerdicts: string[];
	/** While set, provider calls after the first stay open until it resolves. */
	let laterCallsHeld: PromiseWithResolvers<void> | undefined;

	beforeEach(async () => {
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
		warnings = [];
		continueVerdicts = [];
		laterCallsHeld = undefined;
		const warn = logger.warn.bind(logger);
		vi.spyOn(logger, "warn").mockImplementation((message: string, context?: Record<string, unknown>) => {
			warnings.push(`${message}: ${String(context?.error ?? "")}`);
			if (message === "agent.continue failed after scheduling") continueVerdicts.push(message);
			warn(message, context);
		});
		const debug = logger.debug.bind(logger);
		vi.spyOn(logger, "debug").mockImplementation((message: string, context?: Record<string, unknown>) => {
			if (message === "agent.continue skipped after scheduling") continueVerdicts.push(message);
			debug(message, context);
		});
		tempDir = await TempDir.create("veyyon-continuation-race");
		providerCalls = [];
		firstCall = "stream-until-aborted";

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context, options) => {
				providerCalls.push([...context.messages]);
				const call = providerCalls.length;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (call > 1) {
						const done = () =>
							stream.push({ type: "done", reason: "stop", message: createAssistantMessage(`Reply ${call}`) });
						if (laterCallsHeld) void laterCallsHeld.promise.then(done);
						else done();
					} else if (firstCall === "fail") {
						stream.push({ type: "error", reason: "error", error: failedTurn() });
					} else {
						signal?.addEventListener(
							"abort",
							() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
							{ once: true },
						);
					}
				});
				return stream;
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/** Every provider call after the first, by the text of the newest user message it was given. */
	function laterCallPrompts(): string[] {
		return providerCalls.slice(1).map(messages => messageText(messages.findLast(m => m.role === "user")!));
	}

	function refusedContinues(): string[] {
		return warnings.filter(line => line.startsWith("agent.continue failed after scheduling"));
	}

	it("delivers a steer queued before a user interrupt without a refused continue", async () => {
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming && providerCalls.length === 1);
		await session.steer("Queued while streaming");

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await firstPrompt;
		await waitFor(() => providerCalls.length === 2);
		// Waits out every scheduled continuation, including one that lost the race.
		await session.waitForIdle();

		expect(refusedContinues()).toEqual([]);
		expect(laterCallPrompts()).toEqual(["Queued while streaming"]);
		expect(session.isStreaming).toBe(false);
		expect(messageText(session.messages.at(-1)!)).toBe("Reply 2");
	});

	it("runs a retry and a steer drain scheduled together as one run", async () => {
		firstCall = "fail";
		await session.prompt("First message");
		await session.waitForIdle();
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });

		// Both schedule a continuation before either starts: the retry drops the failed turn and waits
		// out its delay, and the steer's drain starts a run inside that delay. That run stays open until
		// the retry's continuation has logged a verdict, so the retry finds the agent busy.
		laterCallsHeld = Promise.withResolvers<void>();
		expect(await session.retry()).toBe(true);
		await session.steer("Steer after the failure");
		await waitFor(() => providerCalls.length === 2 && continueVerdicts.length > 0);
		laterCallsHeld.resolve();
		await session.waitForIdle();

		expect(refusedContinues()).toEqual([]);
		// One run re-attempts the dropped turn with the steer injected: no call is made twice.
		expect(laterCallPrompts()).toEqual(["Steer after the failure"]);
		expect(providerCalls[1]!.filter(m => m.role === "user").map(messageText)).toEqual([
			"First message",
			"Steer after the failure",
		]);
		expect(session.isStreaming).toBe(false);
		expect(messageText(session.messages.at(-1)!)).toBe("Reply 2");
	});
});
