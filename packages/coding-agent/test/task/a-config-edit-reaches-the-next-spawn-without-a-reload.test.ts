/**
 * WHY: an operator edited `config.yml` to move an agent to another model, and the next spawn still
 * ran on the old one, because every dispatcher read routing from the settings snapshot taken at
 * startup and only `/reload-config` refreshed it (https://github.com/Wladefant/veyyon/issues/110).
 *
 * The class: a spawn surface that resolves an agent's model from settings without first applying
 * config-file edits. The suite drives each dispatcher that starts an agent — the `task` tool, the
 * eval `agent()` bridge and a vibe worker — through its real entry point against a store loaded
 * from a real `config.yml`, edits the file between two spawns, and asserts the second spawn carries
 * the edited pin. It also pins that a malformed edit neither fails the spawn nor replaces the
 * active routing, and that the fixed file then applies without a second edit.
 *
 * Gap: the dispatchers are listed by hand, since nothing in the product enumerates spawn surfaces.
 * A new surface that forgets `reloadConfigIfChanged()` is not caught here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runEvalAgent } from "@veyyon/coding-agent/eval/agent-bridge";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { VibeSessionRegistry } from "@veyyon/coding-agent/session/vibe-runtime";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const MODEL = "anthropic/claude-sonnet-4-5";

function definition(name: string): AgentDefinition {
	return { name, description: `${name} agent`, systemPrompt: "Execute the assignment.", source: "bundled" };
}

function result(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment ?? options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

/** A worker session a vibe turn can settle against: idle, no stream, one assistant reply. */
const idleWorker = {
	isStreaming: false,
	model: undefined,
	subscribe: () => () => {},
	prompt: async () => true,
	steer: async () => {},
	waitForIdle: async () => {},
	getLastAssistantMessage: () => ({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
	abort: async () => {},
	dispose: async () => {},
} as unknown as AgentSession;

interface Dispatcher {
	/** The agent this dispatcher starts, whose `agent.agents.<name>.model` row the test edits. */
	agent: string;
	/** Start one agent through the dispatcher's real entry point and wait for it to finish. */
	start(session: ToolSession, turn: number): Promise<void>;
}

const managers: AsyncJobManager[] = [];

const DISPATCHERS: Record<string, Dispatcher> = {
	"task tool": {
		agent: "task",
		async start(session, turn) {
			const tool = await TaskTool.create(session);
			await tool.execute(`turn-${turn}`, {
				context: "Verify the spawn reads the edited config.",
				tasks: [{ name: `Turn${turn}`, task: "Inspect the requested behavior." }],
			});
		},
	},
	"eval agent()": {
		agent: "task",
		async start(session) {
			await runEvalAgent({ agent: "task", prompt: "Inspect the requested behavior." }, { session });
		},
	},
	"vibe worker": {
		agent: "sonic",
		async start(session, turn) {
			const { jobId } = await VibeSessionRegistry.global().spawn(session, {
				cli: "fast",
				name: `Vibe${turn}`,
				prompt: "Inspect the requested behavior.",
			});
			await session.asyncJobManager?.getJob(jobId)?.promise;
		},
	},
};

describe("a config.yml edit reaches the next spawn without /reload-config", () => {
	let tempDir: TempDir;
	let models: unknown[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("config-edit-spawn-");
		models = [];
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [definition("task"), definition("sonic")],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			models.push(options.modelOverride);
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: idleWorker,
				status: "idle",
			});
			return result(options);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	async function writeConfig(agent: string, model: string): Promise<void> {
		await fs.writeFile(
			tempDir.join("config.yml"),
			`agent:\n  batch: true\n  isolation:\n    mode: none\n  agents:\n    ${agent}:\n      enabled: true\n      model: ${model}\n`,
		);
	}

	async function openSession(): Promise<ToolSession> {
		const settings = await Settings.loadReadOnly({
			agentDir: tempDir.path(),
			overrides: { "async.enabled": false },
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return makeToolSession({
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			asyncJobManager: manager,
			getSessionFile: () => tempDir.join("parent.jsonl"),
			getArtifactsDir: () => tempDir.path(),
			getSessionSpawns: () => "*",
			getModelString: () => MODEL,
		});
	}

	for (const [name, dispatcher] of Object.entries(DISPATCHERS)) {
		it(`${name}: the spawn after an edit runs on the edited model`, async () => {
			await writeConfig(dispatcher.agent, "openai/before-edit");
			const session = await openSession();
			await dispatcher.start(session, 1);
			await writeConfig(dispatcher.agent, "openai/after-edit");
			await dispatcher.start(session, 2);
			expect(models).toEqual([["openai/before-edit"], ["openai/after-edit"]]);
		}, 30000);
	}

	it("a malformed edit keeps the active routing, and fixing the file applies it", async () => {
		const dispatcher = DISPATCHERS["task tool"]!;
		await writeConfig(dispatcher.agent, "openai/before-edit");
		const session = await openSession();
		await dispatcher.start(session, 1);
		await fs.writeFile(tempDir.join("config.yml"), "agent: [unterminated\n");
		await dispatcher.start(session, 2);
		await writeConfig(dispatcher.agent, "openai/after-fix");
		await dispatcher.start(session, 3);
		expect(models).toEqual([["openai/before-edit"], ["openai/before-edit"], ["openai/after-fix"]]);
	}, 30000);
});
