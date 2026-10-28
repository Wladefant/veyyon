/**
 * WHY: a replacement lane used to start without durable predecessor state or a slice bound.
 * These tests drive TaskTool through restart, competing claims and a two-successor chain.
 * The model executor is the external boundary; no model or external-action replay safety is claimed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import * as executor from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const assignment = "Continue the same slice.";
const agent: AgentDefinition = { name: "task", description: "Work", systemPrompt: "Work", source: "bundled" };

function result(options: executor.ExecutorOptions): SingleResult {
	return {
		index: options.index, id: options.id, agent: options.agent.name, agentSource: options.agent.source,
		task: options.task, assignment: options.assignment, exitCode: 0,
		output: `Completed safe result from ${options.id}`, stderr: "", truncated: false,
		durationMs: 1, tokens: 0, requests: 1,
	};
}

describe("explicit bounded lane successors", () => {
	let dir: TempDir;
	let executed: executor.ExecutorOptions[];
	let settings: Settings;

	beforeEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		dir = TempDir.createSync("successor-");
		executed = [];
		settings = Settings.isolated({
			"async.enabled": false, "agent.batch": false, "agent.isolation.mode": "none",
			"agent.agents": { task: { enabled: true } },
		});
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			executed.push(options);
			return result(options);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		dir[Symbol.dispose]();
	});

	async function tool() {
		return TaskTool.create(makeToolSession({
			cwd: dir.path(), hasUI: false, settings,
			getSessionFile: () => dir.join("parent.jsonl"), getSessionSpawns: () => "*",
			getModelString: () => "openai/gpt-5", getActiveModelString: () => "openai/gpt-5",
		}));
	}

	async function dispatch(name: string, successorOf?: string) {
		return (await tool()).execute(name, { agent: "task", name, task: assignment, successorOf } as TaskParams);
	}

	it("reads the predecessor checkpoint after all process-local state is lost", async () => {
		await dispatch("Original");
		const original = executed[0].id;
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await dispatch("Replacement", original);
		expect(executed).toHaveLength(2);
		expect(executed[1].task).toContain(`Completed safe result from ${original}`);
		expect(executed[1].task).toContain(original);
		const files = await fs.readdir(dir.join("parent"));
		expect(files.some(file => file.endsWith(".checkpoint.json"))).toBe(true);
	});

	it("permits two successors but refuses the third before starting work", async () => {
		await dispatch("Original");
		await dispatch("First", executed[0].id);
		await dispatch("Second", executed[1].id);
		const refused = await dispatch("Third", executed[2].id);
		expect(executed).toHaveLength(3);
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("successor-limit");
	});

	it("allows exactly one claim, including after a restart", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		await Promise.all([dispatch("One", predecessor), dispatch("Two", predecessor)]);
		expect(executed).toHaveLength(2);
		AgentRegistry.resetGlobalForTests();
		const refused = await dispatch("Again", predecessor);
		expect(executed).toHaveLength(2);
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("successor-claimed");
	});

	it("fails closed for missing or corrupt checkpoints and path-like IDs", async () => {
		for (const predecessor of ["Missing", "../escape", path.resolve(dir.path(), "escape")]) {
			const refused = await dispatch("Invalid", predecessor);
			expect(refused.isError).toBe(true);
		}
		expect(executed).toHaveLength(0);
	});

	it("refuses workflow drift instead of silently resuming different topology", async () => {
		await dispatch("Original");
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [{ ...agent, systemPrompt: "Different workflow" }], projectAgentsDir: null,
		});
		const refused = await dispatch("Changed", executed[0].id);
		expect(executed).toHaveLength(1);
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("successor-workflow-changed");
	});
});
