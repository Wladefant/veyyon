import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import { type AssistantMessage, z } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: agent-core ends a run that throws (a credential lookup that fails, a provider call that
 * rejects before it streams) by appending the failure as an assistant message and emitting
 * `agent_end`, with no `message_end` for it. The settle routed the last reply that had a
 * `message_end`, so a run that failed after one or more tool steps settled on the earlier tool-use
 * reply: a transient failure was never retried, and `session_stop` never fired, because the reply
 * the settle read still carried tool calls.
 *
 * CLASS CLOSED: the settle acts on the reply the run ended on, wherever the run failed and however
 * many completed tool steps came before the failure. Swept over three failure sites (the credential
 * lookup, the provider call, the stream dying after it started) by zero, one and two prior tool
 * steps, with retry on (the failure is retried and the run recovers) and with retry off
 * (`session_stop` reports the failure as the last assistant message). Zero prior steps is the
 * control: there no earlier reply exists to be read in its place.
 *
 * NOT CAUGHT: whether the failure is written to the session log. agent-core emits no `message_end`
 * for a thrown run, and the log records what `message_end` delivers.
 */

const FAILURE = "503 Service Unavailable: upstream connect error";

type FailureSite = "the credential lookup" | "the provider call" | "the stream after it started";
const FAILURE_SITES: readonly FailureSite[] = [
	"the credential lookup",
	"the provider call",
	"the stream after it started",
];
const PRIOR_STEPS = [0, 1, 2] as const;

const recordSchema = z.object({ value: z.string() });
const recordTool: AgentTool<typeof recordSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: `recorded:${params.value}` }], details: { value: params.value } };
	},
};

function recordCall(step: number): MockResponse {
	return {
		content: [{ type: "toolCall", id: `call-${step}`, name: "record", arguments: { value: `step-${step}` } }],
		stopReason: "toolUse",
	};
}

describe("a run that fails after its tool steps", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	/**
	 * A session whose provider answers `priorSteps` tool calls, fails once at `site`, then answers
	 * with text; `session_stop` payloads are collected by an extension.
	 */
	async function startSession(site: FailureSite, priorSteps: number, retry: boolean) {
		tempDir = TempDir.createSync("@pi-failed-run-settle-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const responses: MockResponse[] = [];
		for (let step = 0; step < priorSteps; step++) responses.push(recordCall(step));
		responses.push({ content: ["recovered"] });
		const mock = createMockModel({ responses });

		const stops: Array<AgentMessage | undefined> = [];
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_stop", async event => {
					stops.push(event.last_assistant_message);
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"session-stop-recorder",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(authStorage, path.join(tempDir.path(), "extension-models.yml")),
		);

		let requests = 0;
		let failed = false;
		const failsNow = (at: FailureSite): boolean => {
			if (failed || site !== at || requests !== priorSteps) return false;
			failed = true;
			return true;
		};
		const tools = [recordTool as AgentTool];
		const agent = new Agent({
			getApiKey: () => {
				if (failsNow("the credential lookup")) throw new Error(FAILURE);
				return "test-key";
			},
			initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: (model, context, options) => {
				if (failsNow("the provider call")) throw new Error(FAILURE);
				if (failsNow("the stream after it started")) {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({
							type: "start",
							partial: {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
								timestamp: Date.now(),
							},
						});
						stream.fail(new Error(FAILURE));
					});
					return stream;
				}
				requests++;
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": retry,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
		});
		settings.setDefaultModel(`${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner,
		});
		return { session, stops, failedOnce: () => failed };
	}

	async function runToIdle(target: AgentSession): Promise<void> {
		await target.prompt("Record the steps, then answer");
		await target.waitForIdle();
		// A retry the settle scheduled reaches the provider after the first idle.
		for (let tick = 0; tick < 20; tick++) await new Promise<void>(resolve => setImmediate(resolve));
		await target.waitForIdle();
	}

	for (const site of FAILURE_SITES) {
		for (const priorSteps of PRIOR_STEPS) {
			const after = priorSteps === 0 ? "with no step before it" : `after ${priorSteps} tool step(s)`;

			it(`retries a transient failure at ${site} ${after}`, async () => {
				const run = await startSession(site, priorSteps, true);
				await runToIdle(run.session);

				expect(run.failedOnce()).toBe(true);
				const last = run.session.agent.state.messages.at(-1) as AssistantMessage;
				expect(last.role).toBe("assistant");
				expect(last.stopReason).toBe("stop");
				expect(last.content).toEqual([{ type: "text", text: "recovered" }]);
			});

			it(`reports a failure at ${site} ${after} to session_stop when retry is off`, async () => {
				const run = await startSession(site, priorSteps, false);
				await runToIdle(run.session);

				expect(run.failedOnce()).toBe(true);
				expect(
					run.stops.map(stop => (stop?.role === "assistant" ? [stop.stopReason, stop.errorMessage] : stop?.role)),
				).toEqual([["error", FAILURE]]);
			});
		}
	}
});
