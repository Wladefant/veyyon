import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { requireBundledModel } from "../../../agent/test/helpers";

/**
 * WHY. A turn stopped by `session.abort()` was re-sent by the auto-retry ladder as if the provider
 * had dropped it.
 *
 * The agent loop finalizes a turn its signal stopped as an empty `aborted` turn flagged as an abort,
 * which is the same shape as a provider that drops the stream on its own, and the retry ladder
 * re-sends that shape. It told the two apart by asking the session, at settle time, whether an
 * abort was in progress. `abort()` clears that flag once the agent loop is idle, and the settle runs
 * after the loop is idle (agent-core dispatches `agent_end` fire-and-forget, and the settle waits
 * for the message's persistence first), so by the time the ladder asked, the answer was already
 * "no". The subagent soft request budget aborts the free-running turn to force a final `yield`; the
 * retry re-sent the turn instead, the forced yield never ran, and the hard budget killed the agent a
 * few requests later.
 *
 * The class closed here is "a deliberate abort read from session state that no longer holds when
 * the settle reads it". Deliberateness is recorded against the turn when it ends, so the answer
 * cannot change between the stop and the settle. Every option shape `abort()` accepts is swept,
 * at every point of a turn an abort lands on: while the provider streams, inside the `message_end`
 * of a tool-use reply before its tools run (where the run monitor's budget stop fires, from a
 * session event listener), and while a tool runs. A user interrupt was settled before this fix by
 * its own `UserInterrupt` error id and stays in the sweep so the contract holds whichever mark
 * protects it; the other shapes go red without the fix in every phase.
 *
 * Not caught: an abort issued after the turn's `message_end` and finished before its settle. That
 * abort arrives after the turn already ended, so it did not cause the failure the ladder would
 * retry, and the ladder still reads the live flag for it.
 */

interface AbortShape {
	readonly name: string;
	readonly options: { readonly reason?: string; readonly preserveCompaction?: boolean } | undefined;
}

const ABORT_SHAPES: readonly AbortShape[] = [
	{ name: "a reasonless abort (the soft request budget, a run monitor)", options: undefined },
	{ name: "an abort with a lifecycle reason", options: { reason: "session switching" } },
	{ name: "a user interrupt", options: { reason: USER_INTERRUPT_LABEL } },
	{ name: "a manual-compaction startup abort", options: { preserveCompaction: true } },
];

/** Where in the turn the abort lands. */
type AbortPhase = "while the provider streams" | "at the end of a tool-use reply" | "while a tool runs";

const ABORT_PHASES: readonly AbortPhase[] = [
	"while the provider streams",
	"at the end of a tool-use reply",
	"while a tool runs",
];

const TOOL_NAME = "probe";

function emptyTurn(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("a deliberate session abort", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-deliberate-abort-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * A session whose first request either streams until it is aborted and then ends the way a
	 * provider client ends an aborted request (an empty turn with the generic sentence), or answers
	 * with a call to a tool that runs until it is aborted. Any later request on a live signal answers
	 * with text, so a retry is visible both as a second live request and as a recovered turn. A
	 * request opened on a signal that is already aborted re-sends nothing and is not counted.
	 */
	function startSession(phase: AbortPhase, abortOptions: AbortShape["options"]) {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const abortPoint = Promise.withResolvers<void>();
		let liveRequests = 0;
		const tool: AgentTool = {
			name: TOOL_NAME,
			label: TOOL_NAME,
			description: TOOL_NAME,
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				const aborted = Promise.withResolvers<void>();
				if (signal?.aborted) aborted.resolve();
				else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				abortPoint.resolve();
				await aborted.promise;
				return { content: [{ type: "text", text: "stopped" }] };
			},
		};
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			convertToLlm,
			streamFn: (requestedModel, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const partial = emptyTurn(requestedModel);
				if (options?.signal?.aborted) {
					queueMicrotask(() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" },
						});
					});
					return stream;
				}
				liveRequests += 1;
				if (liveRequests > 1) {
					queueMicrotask(() => {
						const text = { type: "text" as const, text: "retried after the abort" };
						stream.push({ type: "start", partial });
						stream.push({ type: "done", reason: "stop", message: { ...partial, content: [text] } });
					});
					return stream;
				}
				if (phase !== "while the provider streams") {
					queueMicrotask(() => {
						const call = { type: "toolCall" as const, id: "call-1", name: TOOL_NAME, arguments: {} };
						stream.push({ type: "start", partial });
						stream.push({
							type: "done",
							reason: "toolUse",
							message: { ...partial, content: [call], stopReason: "toolUse" },
						});
					});
					return stream;
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					const finish = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" },
						});
					};
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
					abortPoint.resolve();
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 3,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map([[TOOL_NAME, tool]]),
		});
		session = created;
		const retryStarts: Extract<AgentSessionEvent, { type: "auto_retry_start" }>[] = [];
		let aborting: Promise<void> | undefined;
		// Settles when the tool-use reply's `message_end` issues the abort, and fails when the run
		// ends without one. A fixed count of event-loop ticks expired before `message_end` on a loaded
		// runner, so the wait is on the event itself, bounded by the run's own end.
		const abortIssued = Promise.withResolvers<void>();
		created.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			// The run monitor's budget stop: issued from inside the tool-use reply's `message_end`
			// dispatch, while the loop is already handing that reply's calls to the tool batch.
			if (
				phase === "at the end of a tool-use reply" &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "toolUse"
			) {
				aborting ??= created.abort(abortOptions);
				abortIssued.resolve();
			}
			if (phase === "at the end of a tool-use reply" && event.type === "agent_end" && !aborting) {
				abortIssued.reject(new Error("The tool-use reply never reached its message_end"));
			}
		});
		const abort = async (): Promise<void> => {
			if (phase === "at the end of a tool-use reply") {
				await abortIssued.promise;
				await aborting;
				return;
			}
			await abortPoint.promise;
			await created.abort(abortOptions);
		};
		return { session: created, abort, liveRequests: () => liveRequests, retryStarts };
	}

	for (const phase of ABORT_PHASES) {
		for (const shape of ABORT_SHAPES) {
			it(`settles the turn stopped by ${shape.name} ${phase} instead of re-sending it`, async () => {
				const run = startSession(phase, shape.options);
				const prompted = run.session.prompt("Work until stopped");

				await run.abort();
				await prompted;
				await run.session.waitForIdle();
				// Let a retry the settle scheduled after idle reach the provider before reading the count.
				for (let tick = 0; tick < 20; tick++) await new Promise<void>(resolve => setImmediate(resolve));

				expect(run.retryStarts).toHaveLength(0);
				expect(run.liveRequests()).toBe(1);
				const last = run.session.agent.state.messages.at(-1) as AssistantMessage;
				expect(last.role).toBe("assistant");
				expect(last.stopReason).toBe("aborted");
				expect(last.content).toHaveLength(0);
			});
		}
	}
});
