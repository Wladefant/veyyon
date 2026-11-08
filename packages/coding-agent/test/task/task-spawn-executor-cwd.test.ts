import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, TaskParams } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { useTempDirs } from "../helpers/temp-dirs";
import { firstToolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir();

const makeTempDir = useTempDirs();
const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const realRunSubprocess = executorModule.runSubprocess;
const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
const modelRegistry = {
	authStorage: {},
	refresh: async () => {},
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "test-key",
} as unknown as ModelRegistry;

function createParentSession(cwd: string): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "agent.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	});
}

describe("task spawn executor cwd routing", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("creates each spawned session in its routed cwd, including nested relative and inherited paths", async () => {
		const createdCwds: string[] = [];
		const sdkSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options?.sessionManager) {
				throw new Error("Expected a session manager for each spawned session");
			}
			const cwd = options.sessionManager.getCwd();
			createdCwds.push(cwd);
			return createSessionResult(
				createMockSession(({ emit }) => {
					emit(yieldSuccessEvent({ ok: true }, `yield-${createdCwds.length}`));
				}),
			);
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options =>
			realRunSubprocess({
				...options,
				modelRegistry,
				modelOverride: [`${model.provider}/${model.id}`],
				enableLsp: false,
			}),
		);

		const parentCwd = makeTempDir("@pi-task-spawn-parent-");
		const explicitCwd = makeTempDir("@pi-task-spawn-explicit-");
		const nestedCwd = path.join(explicitCwd, "nested");
		fs.mkdirSync(nestedCwd);
		const first = await TaskTool.create(createParentSession(parentCwd));
		const firstResult = await first.execute("tc-explicit-cwd", {
			context: "Route to the explicit working directory.",
			tasks: [
				{
					agent: "task",
					name: "ExplicitCwd",
					task: "Work in the explicit directory.",
					cwd: explicitCwd,
				},
			],
		} as TaskParams);
		expect(firstResult.details?.results[0]?.stderr).toBe("");
		expect(firstResult.details?.results[0]?.exitCode).toBe(0);
		expect(createdCwds).toHaveLength(1);

		// Use the cwd observed on the real executor-created SessionManager as the
		// parent of a second TaskTool, then exercise both relative resolution and
		// omission through the same TaskTool -> runSubprocess -> session path.
		const child = await TaskTool.create(createParentSession(createdCwds[0]!));
		await child.execute("tc-relative-cwd", {
			context: "Route to the nested directory.",
			tasks: [
				{
					agent: "task",
					name: "RelativeCwd",
					task: "Work in a nested directory.",
					cwd: "nested",
				},
			],
		} as TaskParams);
		await child.execute("tc-inherited-cwd", {
			context: "Inherit the current working directory.",
			tasks: [
				{
					agent: "task",
					name: "InheritedCwd",
					task: "Stay in the parent directory.",
				},
			],
		} as TaskParams);
		const invalid = await child.execute("tc-invalid-cwd", {
			context: "Reject missing working directories.",
			tasks: [
				{
					agent: "task",
					name: "InvalidCwd",
					task: "Do not start a session for a missing directory.",
					cwd: "missing",
				},
			],
		} as TaskParams);
		expect(invalid.isError).toBe(true);
		expect(firstToolResultText(invalid)).toMatch(/task cwd does not exist/);

		expect(sdkSpy).toHaveBeenCalledTimes(3);
		expect(createdCwds).toEqual([explicitCwd, nestedCwd, explicitCwd]);
		expect(
			sdkSpy.mock.calls.map(([options]) => {
				if (!options) {
					throw new Error("Expected options for each spawned session");
				}
				return options.cwd;
			}),
		).toEqual(createdCwds);
		expect(
			sdkSpy.mock.calls.map(([options]) => {
				if (!options?.sessionManager) {
					throw new Error("Expected a session manager for each spawned session");
				}
				return options.sessionManager.getCwd();
			}),
		).toEqual(createdCwds);
	});
});
