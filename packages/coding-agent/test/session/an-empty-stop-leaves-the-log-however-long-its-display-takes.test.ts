import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
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
 * WHY: the settle of a turn edits the session branch for the reply that ended it. The empty-stop
 * pass moves the branch leaf off an empty reply so it does not replay on reload, and that move is a
 * no-op when the reply has no entry yet. The reply's entry is written only after its `message_end`
 * display finishes, and an extension that awaits in its `message_end` handler holds that display
 * while the settle runs. A settle that did not wait for the reply's write moved nothing, the entry
 * landed afterwards, and the discarded empty turn stayed on the branch.
 *
 * CLASS CLOSED: the settle acts on the branch only after the reply's queued write finished,
 * whichever shape of empty reply ended the turn (an empty `stop`, a whitespace-only `stop`, a
 * `toolUse` stop with no tool call) and whether or not an extension holds its display. The write
 * trails the settle even with no extension, because the display event is awaited before the write;
 * the held arms widen that window from a few microtasks to many event-loop turns.
 *
 * NOT CAUGHT: a write that fails. The branch then has no entry to move and the drop is a no-op by
 * contract; the write failure is reported where the write ran.
 */

// Stamped a second in the past: the retry the empty-stop pass schedules answers within the same
// millisecond on a fast run, and two replies sharing a timestamp, route and stop reason are one
// turn to the branch lookup.
const EMPTY_REPLIES: ReadonlyArray<{ name: string; reply: (model: Model) => AssistantMessage }> = [
	{ name: "an empty stop", reply: model => assistantReply(model, "stop", [], Date.now() - 1_000) },
	{
		name: "a whitespace-only stop",
		reply: model => assistantReply(model, "stop", [{ type: "text", text: " \n" }], Date.now() - 1_000),
	},
	{
		name: "a tool-use stop with no tool call",
		reply: model => assistantReply(model, "toolUse", [], Date.now() - 1_000),
	},
];

function assistantReply(
	model: Model,
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"],
	timestamp = Date.now(),
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

async function ticks(count: number): Promise<void> {
	for (let tick = 0; tick < count; tick++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("an empty stop", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-empty-stop-slow-display-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * A session whose extension holds the display of the empty reply until `release` resolves, and
	 * whose provider answers the retry the empty-stop pass schedules with text.
	 */
	async function startSession(holdDisplay: boolean) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const release = Promise.withResolvers<void>();
		const displayHeld = Promise.withResolvers<void>();
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async event => {
					const { message } = event;
					if (!holdDisplay || message.role !== "assistant") return;
					// Only the empty reply is held; the retry's text answer displays at once.
					if (message.content.some(block => block.type !== "text" || /\S/.test(block.text))) return;
					displayHeld.resolve();
					await release.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"held-message-end",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(authStorage, path.join(tempDir.path(), "extension-models.yml")),
		);
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: requestedModel => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantReply(requestedModel, "stop", []);
					stream.push({ type: "start", partial });
					stream.push({
						type: "done",
						reason: "stop",
						message: { ...partial, content: [{ type: "text", text: "answered on the retry" }] },
					});
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		const created = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			extensionRunner,
		});
		session = created;
		return { model, session: created, sessionManager, release, displayHeld };
	}

	for (const { name, reply } of EMPTY_REPLIES) {
		for (const holdDisplay of [false, true]) {
			it(`leaves the branch as ${name}${holdDisplay ? " whose display is held" : ""}`, async () => {
				const run = await startSession(holdDisplay);
				const question = { role: "user" as const, content: "Answer the question", timestamp: Date.now() - 2_000 };
				run.session.agent.emitExternalEvent({ type: "message_end", message: question });
				await run.session.waitForIdle();
				const empty = reply(run.model);

				run.session.agent.emitExternalEvent({ type: "message_end", message: empty });
				run.session.agent.emitExternalEvent({ type: "agent_end", messages: [empty] });
				if (holdDisplay) {
					await run.displayHeld.promise;
					// Room for a settle that does not wait for the write to reach its branch edit.
					await ticks(20);
					run.release.resolve();
				}
				await run.session.waitForIdle();
				await ticks(20);
				await run.session.waitForIdle();

				const branchAssistants = run.sessionManager
					.getBranch()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
					);
				expect(branchAssistants.some(message => message.timestamp === empty.timestamp)).toBe(false);
				expect(
					run.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user"),
				).toBe(true);
			});
		}
	}
});
