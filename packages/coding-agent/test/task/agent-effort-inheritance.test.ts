import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runEvalAgent } from "@veyyon/coding-agent/eval/agent-bridge";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import { AGENT_DEFAULT_EFFORT } from "@veyyon/coding-agent/task/agent-settings";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import { AgentOutputManager } from "@veyyon/coding-agent/task/output-manager";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const MODEL = "anthropic/claude-sonnet-4-5";
const agent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Execute the assignment.",
	source: "bundled",
};

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

describe("task agent effort inheritance", () => {
	let tempDir: TempDir;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("agent-effort-inherit-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	it("pins model, lane effort and child routing across a reload during dispatch", async () => {
		const file = tempDir.join("config.yml");
		const writeRouting = (model: string, effort: string) =>
			fs.writeFile(
				file,
				JSON.stringify({
					agent: { agents: { task: { model, thinkingLevel: effort } } },
					modelRoles: { worker: model },
				}),
			);
		await writeRouting("openai/old", "low");
		const settings = await Settings.loadReadOnly({
			agentDir: tempDir.path(),
			overrides: { "async.enabled": false, "agent.batch": true, "agent.isolation.mode": "none" },
		});
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const bindings: unknown[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (!bindings.length) {
				entered.resolve();
				await resume.promise;
			}
			// This is the real executor's destination-settings fork, after the
			// deterministic barrier where a reload can land.
			const child = await executorModule.createSubagentSettingsForCwd(options.settings!, tempDir.path());
			bindings.push([options.modelOverride, options.thinkingLevel, child.getModelRole("worker")]);
			return result(options);
		});
		const tool = await TaskTool.create(
			makeToolSession({
				cwd: tempDir.path(),
				hasUI: false,
				settings,
				getSessionFile: () => tempDir.join("parent.jsonl"),
				getSessionSpawns: () => "*",
				getModelString: () => MODEL,
			}),
		);
		const first = tool.execute("reload-first", {
			context: "Verify config reload generation isolation.",
			tasks: [{ name: "OldGeneration", task: "Inspect the requested behavior." }],
		});
		try {
			await Promise.race([
				entered.promise,
				first.then(output => {
					throw new Error(`No spawn: ${JSON.stringify(output.content)}`);
				}),
			]);
			await writeRouting("openai/new", "high");
			await settings.reloadConfig();
		} finally {
			resume.resolve();
			await first;
		}
		await tool.execute("reload-second", {
			context: "Verify config reload generation isolation.",
			tasks: [{ name: "NewGeneration", task: "Inspect the requested behavior." }],
		});
		expect(bindings).toEqual([
			[["openai/old"], "low", "openai/old"],
			[["openai/new"], "high", "openai/new"],
		]);
	}, 30000);

	it("pins eval model and effort before asynchronous output allocation", async () => {
		const file = tempDir.join("config.yml");
		await fs.writeFile(file, "agent:\n  agents:\n    task:\n      model: openai/old\n      thinkingLevel: low\n");
		const settings = await Settings.loadReadOnly({ agentDir: tempDir.path() });
		const manager = new AgentOutputManager(() => tempDir.path());
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const allocate = manager.allocate.bind(manager);
		let firstAllocation = true;
		vi.spyOn(manager, "allocate").mockImplementation(async name => {
			if (firstAllocation) {
				firstAllocation = false;
				entered.resolve();
				await resume.promise;
			}
			return allocate(name);
		});
		const bindings: unknown[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			bindings.push([options.modelOverride, options.thinkingLevel]);
			return result(options);
		});
		const session = makeToolSession({
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			agentOutputManager: manager,
			getSessionFile: () => tempDir.join("parent.jsonl"),
			getArtifactsDir: () => tempDir.path(),
			getSessionSpawns: () => "*",
		});
		const first = runEvalAgent({ agent: "task", prompt: "Inspect the requested behavior." }, { session });
		try {
			await Promise.race([
				entered.promise,
				first.then(() => {
					throw new Error("No eval allocation");
				}),
			]);
			await fs.writeFile(file, "agent:\n  agents:\n    task:\n      model: openai/new\n      thinkingLevel: high\n");
			await settings.reloadConfig();
		} finally {
			resume.resolve();
			await first;
		}
		await runEvalAgent({ agent: "task", prompt: "Inspect the requested behavior." }, { session });
		expect(bindings).toEqual([
			[["openai/old"], "low"],
			[["openai/new"], "high"],
		]);
	}, 30000);

	async function dispatch(agentSettings: Record<string, { thinkingLevel?: string }> = {}) {
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => result(options));
		const tool = await TaskTool.create(
			makeToolSession({
				cwd: tempDir.path(),
				hasUI: false,
				settings: Settings.isolated({
					"async.enabled": false,
					"agent.agents": agentSettings,
					"agent.batch": true,
					"agent.isolation.mode": "none",
				}),
				getSessionFile: () => tempDir.join("parent.jsonl"),
				getSessionSpawns: () => "*",
				// The bootstrap the resolver reads is the session's EXPLICIT model, not the one the
				// operator happens to be viewing: a spawn that followed the active model would move
				// every agent on a keystroke aimed at one.
				getModelString: () => MODEL,
				getActiveModelString: () => MODEL,
				getActiveThinkingLevel: () => ThinkingLevel.High,
			}),
		);
		const execution = await tool.execute("inherit-effort", {
			context: "Shared context",
			tasks: [{ name: "InheritedWorker", task: "Inspect the requested behavior." }],
		});
		const options = run.mock.calls[0]?.[0];
		if (!options) {
			throw new Error(`Expected one agent dispatch, received ${JSON.stringify(execution.content)}`);
		}
		return options;
	}

	/**
	 * With no row anywhere, a spawn runs at the documented default and on the session's model
	 * bootstrap, and the parent's own effort still crosses the boundary beside it: the executor
	 * needs it for the case where the resolved level is `inherit` or names nothing.
	 *
	 * The child does NOT follow the parent's live effort here. A parent on `high` spawning a worker
	 * that nobody configured runs that worker at the default, so a keystroke aimed at the main
	 * assistant does not silently reprice every agent it spawns afterwards.
	 */
	it("runs an unconfigured agent at the documented default, carrying the parent effort beside it", async () => {
		const options = await dispatch();

		expect(options.modelOverride).toEqual([MODEL]);
		expect(options.thinkingLevel).toBe(AGENT_DEFAULT_EFFORT);
		expect(options.thinkingLevel).not.toBe(ThinkingLevel.High);
		expect(options.parentThinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * A per-agent `thinkingLevel` row is the highest-precedence effort layer, so it
	 * crosses the boundary as the child's own effort instead of the parent's. The
	 * parent's effort still travels beside it, because the executor needs a fallback
	 * for the case where the resolved level names nothing.
	 */
	it("sends a per-agent effort row as the child's own effort, and still carries the parent's", async () => {
		const options = await dispatch({ task: { thinkingLevel: ThinkingLevel.Low } });

		expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(options.parentThinkingLevel).toBe(ThinkingLevel.High);
	});

	/**
	 * `auto` is a level an operator can choose, not an absent row: it means the model
	 * routes its own effort. It must reach the executor as `auto` rather than as
	 * `undefined`, since `undefined` is what makes the child inherit the parent, and
	 * the two decisions are not the same one.
	 */
	it("keeps an explicit auto row distinct from no row at all", async () => {
		const options = await dispatch({ task: { thinkingLevel: AUTO_THINKING } });

		expect(options.thinkingLevel).toBe(AUTO_THINKING);
		expect(options.parentThinkingLevel).toBe(ThinkingLevel.High);
	});
});
