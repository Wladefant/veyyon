/**
 * WHY: the bundled `deep` agent carried no model, so it ran the default model role, and picking a
 * model interactively rewrites that role. Deep's model therefore moved on every model pick, as a side
 * effect of a role nobody chose for it, while its effort stayed on its own default.
 *
 * The class closed: an agent runs the spawning session's live model and effort exactly when its
 * deciding layer says `inherit`. The bundled roster is swept through the real spawn path, and the set
 * of agents that follow the session is pinned by exact equality, so a bundled agent that starts or
 * stops inheriting turns the suite red. A lane naming a model outranks a definition that inherits,
 * and a lane naming `inherit` makes any agent follow the session.
 *
 * Not caught: how the executor fits the inherited effort to the child's model; that is
 * `an-inherited-effort-is-fitted-to-the-agents-model.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { SingleResult } from "@veyyon/coding-agent/task/types";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** What the default model role resolves to. */
const DEFAULT_ROLE_MODEL = "anthropic/claude-sonnet-4-5";
/** What the session is running right now: a different model, so the two cannot be confused. */
const SESSION_MODEL = "openai/gpt-5";
const LANE_MODEL = "anthropic/claude-opus-4-1";

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

describe("an agent that inherits runs the session's model and effort", () => {
	let tempDir: TempDir;
	const bundled = loadBundledAgents();

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("deep-inherits-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: bundled, projectAgentsDir: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	async function dispatchAgent(
		agent: string,
		lanes: Record<string, Record<string, unknown>> = {},
		sessionModel: () => string = () => SESSION_MODEL,
	): Promise<executorModule.ExecutorOptions> {
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => result(options));
		const enabled = Object.fromEntries(bundled.map(definition => [definition.name, { enabled: true }]));
		for (const [name, lane] of Object.entries(lanes)) enabled[name] = { ...enabled[name], ...lane };
		const tool = await TaskTool.create(
			makeToolSession({
				cwd: tempDir.path(),
				hasUI: false,
				settings: Settings.isolated({
					"async.enabled": false,
					"agent.agents": enabled,
					"agent.isolation.mode": "none",
				}),
				getSessionFile: () => tempDir.join("parent.jsonl"),
				getSessionSpawns: () => "*",
				getModelString: () => DEFAULT_ROLE_MODEL,
				getActiveModelString: sessionModel,
				getActiveThinkingLevel: () => ThinkingLevel.High,
			}),
		);
		const execution = await tool.execute(`spawn-${agent}`, { agent, name: "Worker", task: "Do the work." });
		const options = run.mock.calls.at(-1)?.[0];
		run.mockRestore();
		if (!options) throw new Error(`${agent} did not spawn: ${JSON.stringify(execution.content)}`);
		return options;
	}

	it("makes deep, and only deep, of the bundled agents follow the session", async () => {
		const following: string[] = [];
		for (const { name } of bundled) {
			const options = await dispatchAgent(name);
			const model = options.modelOverride;
			if (model?.[0] === SESSION_MODEL) {
				following.push(name);
				expect(options.thinkingLevel, name).toBe(ThinkingLevel.Inherit);
				expect(options.parentThinkingLevel, name).toBe(ThinkingLevel.High);
			} else {
				expect(model, name).toEqual([DEFAULT_ROLE_MODEL]);
			}
		}
		expect(following).toEqual(["deep"]);
	});

	it("follows the session's model as it changes between spawns", async () => {
		let live = SESSION_MODEL;
		const first = await dispatchAgent("deep", {}, () => live);
		live = LANE_MODEL;
		const second = await dispatchAgent("deep", {}, () => live);
		expect(first.modelOverride).toEqual([SESSION_MODEL]);
		expect(second.modelOverride).toEqual([LANE_MODEL]);
	});

	it("runs a model named on deep's lane instead of the session's", async () => {
		const options = await dispatchAgent("deep", { deep: { model: LANE_MODEL } });
		expect(options.modelOverride).toEqual([LANE_MODEL]);
	});

	it("makes any agent follow the session when its lane names inherit", async () => {
		const other = bundled.find(definition => definition.name !== "deep");
		if (!other) throw new Error("no bundled agent besides deep");
		const inheriting = await dispatchAgent(other.name, { [other.name]: { model: "inherit" } });
		expect(inheriting.modelOverride).toEqual([SESSION_MODEL]);
	});
});
