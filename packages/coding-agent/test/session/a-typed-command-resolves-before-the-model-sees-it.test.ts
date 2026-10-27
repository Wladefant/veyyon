/**
 * A `/` command typed into a session resolves before the model sees it: an extension command runs
 * in its place, a custom command or MCP prompt replaces it with the prompt it returns and grants the
 * agents it declares for that turn, a file-based command or prompt template expands into the text
 * the model receives, and a steer or follow-up expands the same templates.
 *
 * WHY: the command registries and the resolution order moved out of `AgentSession` into the
 * `PromptCommands` collaborator (`session/runtime/prompt-commands.ts`). A mutation sweep of that
 * move found the session-level resolution unpinned: the existing suites drive the helpers in
 * `agent-session-commands.ts` directly and the unknown-command refusal, so dropping the template
 * expansion, the file-based commands, the `/name:args` rewrite, the MCP prompts, the extension
 * command's short-circuit, the custom command's prompt, the turn grant and its release, or the
 * queued-text expansion left every suite green. Each case below fails on one of them.
 *
 * Driven through a real `AgentSession` and `Agent`. Only the provider stream is faked, recording the
 * user text of each request. The extension runner is a real one with no extension loaded, its command
 * lookup answering from the commands a case registers.
 *
 * NOT CAUGHT: `setSlashCommands` copies the caller's array, not the commands in it, so an edit to a
 * command object after the call reaches the session; nothing here pins either way. The
 * unknown-command refusal and its synthetic exemption are pinned by
 * `an-unknown-command-is-refused-not-sent-to-the-model.test.ts`, the listener containment by
 * `failclosedguardhunt-agent-session-listener-rejections.test.ts`, and
 * the task tool reading a grant by `task/disabled-agent-means-disabled.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Api, Message, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import type { PromptTemplate } from "@veyyon/coding-agent/config/prompt-templates";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomCommand, LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import {
	type ExtensionCommandContext,
	ExtensionRunner,
	type RegisteredCommand,
} from "@veyyon/coding-agent/extensibility/extensions";
import type { ExtensionRuntime } from "@veyyon/coding-agent/extensibility/extensions/types";
import type { FileSlashCommand } from "@veyyon/coding-agent/extensibility/slash-commands";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** The fake provider: what each request carried, and a response it may hold back. */
interface FakeProvider {
	/** The text of the last user message of each request, in request order. */
	received: string[];
	/** Whether `reviewer` was granted for the turn when each request started. */
	reviewerGrantedAtRequest: boolean[];
	/** When set, the next response waits for `release`; `requested` resolves once that request starts. */
	hold: { requested: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
}

interface Harness {
	session: AgentSession;
	provider: FakeProvider;
}

interface HarnessOptions {
	promptTemplates?: PromptTemplate[];
	slashCommands?: FileSlashCommand[];
	customCommands?: LoadedCustomCommand[];
	/** Commands an extension registered; given, the session runs with a real, empty extension runner. */
	extensionCommands?: RegisteredCommand[];
}

function template(name: string, content: string): PromptTemplate {
	return { name, description: "", content, source: "(project)" };
}

function fileCommand(name: string, content: string): FileSlashCommand {
	return { name, description: "", content, source: "via test (Project)" };
}

function loaded(command: CustomCommand): LoadedCustomCommand {
	return { path: `${command.name}.ts`, resolvedPath: `/repo/${command.name}.ts`, source: "project", command };
}

/**
 * A real `ExtensionRunner` with no extension loaded, its command lookup answering from `commands`, so
 * a turn the session starts through it runs the production event paths.
 */
function runnerWith(
	commands: RegisteredCommand[],
	cwd: string,
	sessionManager: SessionManager,
	modelRegistry: ModelRegistry,
): ExtensionRunner {
	const runner = new ExtensionRunner([], {} as ExtensionRuntime, cwd, sessionManager, modelRegistry);
	const byName = new Map(commands.map(command => [command.name, command]));
	spyOn(runner, "getCommand").mockImplementation(name => byName.get(name));
	spyOn(runner, "createCommandContext").mockImplementation(() => ({}) as ExtensionCommandContext);
	return runner;
}

function lastUserText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

function bundled(provider: "anthropic", id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled test model ${provider}/${id} to exist`);
	return model;
}

describe("a typed command resolves before the model sees it", () => {
	let tempDir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-prompt-commands-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const provider: FakeProvider = { received: [], reviewerGrantedAtRequest: [], hold: undefined };
		let session: AgentSession | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				provider.received.push(lastUserText(context.messages));
				provider.reviewerGrantedAtRequest.push(session?.agentGrantedThisTurn("reviewer") ?? false);
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				const respond = () => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				};
				const hold = provider.hold;
				provider.hold = undefined;
				if (hold) {
					hold.requested.resolve();
					void hold.release.promise.then(respond);
				} else {
					queueMicrotask(respond);
				}
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			modelRegistry,
			promptTemplates: options.promptTemplates,
			slashCommands: options.slashCommands,
			customCommands: options.customCommands,
			extensionRunner: options.extensionCommands
				? runnerWith(options.extensionCommands, tempDir.path(), sessionManager, modelRegistry)
				: undefined,
		});
		const created = session;
		cleanups.push(
			() => authStorage.close(),
			() => created.dispose(),
		);
		return { session: created, provider };
	}

	async function send(harness: Harness, text: string): Promise<boolean> {
		const forwarded = await harness.session.prompt(text);
		await harness.session.waitForIdle();
		return forwarded;
	}

	/**
	 * Run `body` while the session streams a held turn, then release the turn and let the session
	 * settle. A message queued meanwhile waits on the agent's queues instead of starting its own turn.
	 */
	async function whileStreaming(harness: Harness, body: () => Promise<void>): Promise<void> {
		const hold = { requested: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		harness.provider.hold = hold;
		const turn = harness.session.prompt("first");
		await hold.requested.promise;
		try {
			await body();
		} finally {
			hold.release.resolve();
			await turn;
			await harness.session.waitForIdle();
		}
	}

	describe("a prompt", () => {
		it("expands a prompt template, and the model receives the expansion", async () => {
			const h = await createHarness({ promptTemplates: [template("greet", "Hello $1")] });
			expect(await send(h, "/greet Ada")).toBe(true);
			expect(h.provider.received).toEqual(["Hello Ada"]);
		});

		it("is sent as typed, running no command, when template expansion is off", async () => {
			let ran = false;
			const h = await createHarness({
				promptTemplates: [template("greet", "Hello $1")],
				customCommands: [
					loaded({
						name: "greet",
						description: "",
						execute: () => {
							ran = true;
							return "from the command";
						},
					}),
				],
			});
			await h.session.prompt("/greet Ada", { expandPromptTemplates: false });
			await h.session.waitForIdle();
			expect(h.provider.received).toEqual(["/greet Ada"]);
			expect(ran).toBe(false);
		});

		it("expands a file-based command with its arguments", async () => {
			const h = await createHarness({ slashCommands: [fileCommand("fix", "Fix: $ARGUMENTS")] });
			await send(h, "/fix the bug");
			expect(h.provider.received).toEqual(["Fix: the bug"]);
		});

		it("reaches a prompt template through the `/name:args` form", async () => {
			const h = await createHarness({ promptTemplates: [template("review", "Review for $1")] });
			await send(h, "/review:security");
			expect(h.provider.received).toEqual(["Review for security"]);
		});

		it("takes file-based commands from the last setSlashCommands, which the caller's later edits do not reach", async () => {
			const h = await createHarness();
			const commands = [fileCommand("fix", "Fix: $ARGUMENTS")];
			h.session.setSlashCommands(commands);
			commands.length = 0;
			await send(h, "/fix it");
			expect(h.provider.received).toEqual(["Fix: it"]);
		});
	});

	describe("an extension command", () => {
		it("runs in place of the prompt, before a custom command of the same name, and sends nothing", async () => {
			const handled: string[] = [];
			let customRan = false;
			const h = await createHarness({
				extensionCommands: [{ name: "deploy", handler: async args => void handled.push(args) }],
				customCommands: [
					loaded({
						name: "deploy",
						description: "",
						execute: () => {
							customRan = true;
							return "deploy from the custom command";
						},
					}),
				],
			});
			expect(await send(h, "/deploy prod")).toBe(false);
			expect(handled).toEqual(["prod"]);
			expect(customRan).toBe(false);
			expect(h.provider.received).toEqual([]);
		});

		it("cannot be queued as a steer or a follow-up, and nothing is queued", async () => {
			const h = await createHarness({
				extensionCommands: [{ name: "deploy", handler: async () => {} }],
			});
			const refusal = 'Extension command "/deploy" cannot be queued.';
			await whileStreaming(h, async () => {
				await expect(h.session.steer("/deploy prod")).rejects.toThrow(refusal);
				await expect(h.session.followUp("/deploy prod")).rejects.toThrow(refusal);
				expect(h.session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			});
		});
	});

	describe("a custom command", () => {
		it("sends the prompt it returns and grants its declared agents for that turn alone", async () => {
			const h = await createHarness({
				customCommands: [
					loaded({ name: "audit", description: "", spawnsAgents: ["reviewer"], execute: () => "Audit it" }),
				],
			});
			expect(h.session.agentGrantedThisTurn("reviewer")).toBe(false);
			await send(h, "/audit");
			expect(h.provider.received).toEqual(["Audit it"]);
			expect(h.provider.reviewerGrantedAtRequest).toEqual([true]);
			expect(h.session.agentGrantedThisTurn("reviewer")).toBe(false);
			await send(h, "next");
			expect(h.provider.reviewerGrantedAtRequest).toEqual([true, false]);
		});

		it("includes the MCP prompts once they load, behind a TypeScript command of the same name", async () => {
			const h = await createHarness({
				customCommands: [loaded({ name: "dup", description: "", execute: () => "from typescript" })],
			});
			h.session.setMCPPromptCommands([
				loaded({ name: "dup", description: "", execute: () => "from mcp" }),
				loaded({ name: "only", description: "", execute: () => "from mcp only" }),
			]);
			await send(h, "/dup");
			await send(h, "/only");
			expect(h.provider.received).toEqual(["from typescript", "from mcp only"]);
			expect(h.session.customCommands.map(command => command.command.name)).toEqual(["dup", "dup", "only"]);
			expect(h.session.mcpPromptCommands.map(command => command.command.name)).toEqual(["dup", "only"]);
		});
	});

	describe("a queued message", () => {
		it("expands a template as a steer, and as a follow-up unless told not to", async () => {
			const h = await createHarness({ promptTemplates: [template("greet", "Hello $1")] });
			await whileStreaming(h, async () => {
				await h.session.steer("/greet Ada");
				await h.session.followUp("/greet Bo");
				await h.session.followUp("/greet Cy", undefined, { expandPromptTemplates: false });
				expect(h.session.getQueuedMessages()).toEqual({
					steering: ["Hello Ada"],
					followUp: ["Hello Bo", "/greet Cy"],
				});
			});
		});
	});

	describe("the command-metadata listeners", () => {
		it("each hear an MCP prompt reload, including one after a listener that unsubscribes itself", async () => {
			const h = await createHarness();
			const heard: string[] = [];
			const unsubscribeFirst = h.session.subscribeCommandMetadataChanged(() => {
				heard.push("first");
				unsubscribeFirst();
			});
			h.session.subscribeCommandMetadataChanged(() => {
				heard.push("second");
			});
			h.session.setMCPPromptCommands([]);
			h.session.setMCPPromptCommands([]);
			expect(heard).toEqual(["first", "second", "second"]);
		});
	});
});
