/**
 * WHY: an agent with no model of its own ran the default model role, and one with no effort ran a
 * fixed default. Picking a model interactively rewrites that role, so an unconfigured agent's model
 * moved on every pick as a side effect of a role nobody chose for it, while its effort stayed on a
 * level nobody chose either. Bundled definitions also pinned efforts (`medium`, `minimal`) that
 * outranked the session's.
 *
 * The class closed: an agent whose lane and definition name no model runs the spawning session's
 * live model, and one naming no effort runs the session's live effort. The bundled roster is swept
 * through the real spawn path and the set that follows the session is pinned to the whole roster
 * read off the loader, so a bundled agent that starts pinning a model turns the suite red. A lane
 * naming a model or effort outranks the session, a definition naming one outranks the session, and
 * a lane naming `inherit` overrides a definition's model.
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
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** What the default model role resolves to: a model no unconfigured agent may land on. */
const DEFAULT_ROLE_MODEL = "anthropic/claude-sonnet-4-5";
/** What the session is running right now: a different model, so the two cannot be confused. */
const SESSION_MODEL = "openai/gpt-5";
const LANE_MODEL = "anthropic/claude-opus-4-1";
const DEFINITION_MODEL = "google/gemini-2.5-pro";

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

describe("an agent nobody configured runs the session's model and effort", () => {
	let tempDir: TempDir;
	const bundled = loadBundledAgents();
	/** A user-written definition that names its own model and effort. */
	const pinned: AgentDefinition = {
		name: "pinned",
		description: "Names its own model and effort.",
		systemPrompt: "Work.",
		model: [DEFINITION_MODEL],
		thinkingLevel: ThinkingLevel.Low,
		source: "project",
	};
	const agents = [...bundled, pinned];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("agent-inherits-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
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
		const enabled = Object.fromEntries(agents.map(definition => [definition.name, { enabled: true }]));
		for (const [name, lane] of Object.entries(lanes)) enabled[name] = { ...enabled[name], ...lane };
		const settings = Settings.isolated({
			"async.enabled": false,
			"agent.agents": enabled,
			"agent.isolation.mode": "none",
		});
		settings.setModelRole("default", DEFAULT_ROLE_MODEL);
		const tool = await TaskTool.create(
			makeToolSession({
				cwd: tempDir.path(),
				hasUI: false,
				settings,
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

	it("makes every bundled agent follow the session's model and effort", async () => {
		const following: string[] = [];
		for (const { name } of bundled) {
			const options = await dispatchAgent(name);
			expect(options.modelOverride, name).not.toEqual([DEFAULT_ROLE_MODEL]);
			if (options.modelOverride?.[0] !== SESSION_MODEL) continue;
			following.push(name);
			expect(options.thinkingLevel, name).toBe(ThinkingLevel.Inherit);
			expect(options.parentThinkingLevel, name).toBe(ThinkingLevel.High);
		}
		expect(following).toEqual(bundled.map(definition => definition.name));
	});

	it("follows the session's model as it changes between spawns", async () => {
		let live = SESSION_MODEL;
		const first = await dispatchAgent("scout", {}, () => live);
		live = LANE_MODEL;
		const second = await dispatchAgent("scout", {}, () => live);
		expect(first.modelOverride).toEqual([SESSION_MODEL]);
		expect(second.modelOverride).toEqual([LANE_MODEL]);
	});

	it("runs a model and effort named on the lane instead of the session's", async () => {
		const options = await dispatchAgent("scout", { scout: { model: LANE_MODEL, thinkingLevel: ThinkingLevel.Low } });
		expect(options.modelOverride).toEqual([LANE_MODEL]);
		expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("runs the model and effort a definition names when its lane names none", async () => {
		const options = await dispatchAgent("pinned");
		expect(options.modelOverride).toEqual([DEFINITION_MODEL]);
		expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("overrides a definition's model with the session's when the lane names inherit", async () => {
		const options = await dispatchAgent("pinned", { pinned: { model: "inherit" } });
		expect(options.modelOverride).toEqual([SESSION_MODEL]);
	});
});
