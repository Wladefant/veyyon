/**
 * WHY: successors previously lost predecessor state, accepted drift, and started outside their slice.
 * This suite drives TaskTool's real scheduler, durable claims, checkpoint reader and writer; it closes their
 * observable contracts for inline/background batches, every task/agent workflow input, refusal ordering, and bounds.
 * It does not prove real crashes, cross-process coordination, exact-once external actions, or model behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import * as executor from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import * as atomicWriter from "@veyyon/utils/atomic-write";
import { TempDir } from "@veyyon/utils";
import { makeToolSession, type ToolSessionOverrides } from "../helpers/tool-session";

const assignment = "Continue the same slice.";
const agent: AgentDefinition = { name: "task", description: "Work", systemPrompt: "Work", source: "bundled" };
const writeAtomicJson = atomicWriter.atomicWriteJson;

function result(options: executor.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 0,
		output: `Completed safe result from ${options.id}`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
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
			"async.enabled": false,
			"agent.batch": false,
			"agent.isolation.mode": "none",
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

	async function tool(overrides: ToolSessionOverrides = {}) {
		return TaskTool.create(
			makeToolSession({
				cwd: dir.path(),
				hasUI: false,
				settings,
				getSessionFile: () => dir.join("parent.jsonl"),
				getSessionSpawns: () => "*",
				getModelString: () => "openai/gpt-5",
				getActiveModelString: () => "openai/gpt-5",
				...overrides,
			}),
		);
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

	it("fails closed for missing checkpoints and path-like IDs", async () => {
		for (const predecessor of ["Missing", "../escape", path.resolve(dir.path(), "escape")]) {
			const refused = await dispatch("Invalid", predecessor);
			expect(refused.isError).toBe(true);
		}
		expect(executed).toHaveLength(0);
	});

	it("rejects corrupt and unknown-version checkpoints", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		const directory = dir.join("parent");
		const file = (await fs.readdir(directory)).find(name => name.endsWith(".checkpoint.json"));
		if (!file) throw new Error("No durable checkpoint");
		const checkpointPath = path.join(directory, file);
		const original = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
		for (const bytes of ["{", JSON.stringify({ ...original, version: 3 })]) {
			await fs.writeFile(checkpointPath, bytes);
			const refused = await dispatch("Invalid", predecessor);
			expect(refused.isError).toBe(true);
			expect(executed).toHaveLength(1);
		}
	});

	it("rechecks current agent permission before claiming the checkpoint", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		settings.override("agent.agents", { task: { enabled: false } });
		expect(settings.get("agent.agents")?.task?.enabled).toBe(false);
		const refused = await dispatch("Denied", predecessor);
		expect(refused.isError).toBe(true);
		expect(executed).toHaveLength(1);
		settings.override("agent.agents", { task: { enabled: true } });
		await dispatch("Allowed", predecessor);
		expect(executed).toHaveLength(2);
		expect(executed[1].task).toContain(`Completed safe result from ${predecessor}`);
	});
	it("aggregates a refused successor inside an inline batch", async () => {
		settings.override("agent.batch", true);
		const original = await (await tool()).execute("Original", {
			context: "Shared task context",
			tasks: [{ agent: "task", name: "Original", task: assignment }],
		} as TaskParams);
		const predecessor = original.details?.results[0]?.id;
		if (!predecessor) throw new Error("No original batch result");
		await (await tool()).execute("First", {
			context: "Shared task context",
			tasks: [{ agent: "task", name: "First", task: assignment, successorOf: predecessor }],
		} as TaskParams);
		const refusal = await (await tool()).execute("Batch", {
			context: "Shared task context",
			tasks: [
				{ agent: "task", name: "Accepted", task: "Continue independently." },
				{ agent: "task", name: "Refused", task: assignment, successorOf: predecessor },
			],
		} as TaskParams);
		expect(refusal.isError).toBe(true);
		expect(JSON.stringify(refusal.content)).toContain("successor-claimed");
		expect(executed).toHaveLength(3);
	});

	it("preserves refusal text in a failed background successor job", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		await dispatch("Original");
		const predecessor = executed[0].id;
		await dispatch("First", predecessor);
		settings.override("async.enabled", true);
		const started = await (await tool({ asyncJobManager: manager })).execute("Background refusal", {
			agent: "task",
			name: "Background refusal",
			task: assignment,
			successorOf: predecessor,
		} as TaskParams);
		expect(started.isError).not.toBe(true);
		await manager.waitForAll();
		const job = manager.getAllJobs()[0];
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toContain("successor-claimed");
		await manager.dispose();
	});

	it("pins batch task, shared context, output schema and resolved cwd", async () => {
		settings.override("agent.batch", true);
		const originalSchema = { type: "object", properties: { value: { type: "string" } } };
		const first = await (await tool({ outputSchema: originalSchema })).execute("Original", {
			context: "Shared task context",
			tasks: [{ agent: "task", name: "Original", task: assignment }],
		} as TaskParams);
		const predecessor = first.details?.results[0]?.id;
		if (!predecessor) throw new Error("No original batch result");
		await fs.mkdir(dir.join("elsewhere"), { recursive: true });
		const variants: Array<{ context: string; task: string; cwd?: string; outputSchema?: unknown }> = [
			{ context: "Changed shared context", task: assignment, outputSchema: originalSchema },
			{ context: "Shared task context", task: `${assignment} Changed`, outputSchema: originalSchema },
			{ context: "Shared task context", task: assignment, cwd: dir.join("elsewhere"), outputSchema: originalSchema },
			{
				context: "Shared task context",
				task: assignment,
				outputSchema: { type: "object", properties: { other: { type: "number" } } },
			},
		];
		for (const [index, variant] of variants.entries()) {
			const refused = await (await tool({ outputSchema: variant.outputSchema })).execute(`Drift${index}`, {
				context: variant.context,
				tasks: [{ agent: "task", name: `Drift${index}`, task: variant.task, cwd: variant.cwd, successorOf: predecessor }],
			} as TaskParams);
			expect(refused.isError).toBe(true);
			expect(JSON.stringify(refused.content)).toContain("successor-workflow-changed");
		}
		expect(executed).toHaveLength(1);
	});

	const agentFieldChanges = {
		name: { value: "renamed", pinned: true },
		description: { value: "Changed description", pinned: false },
		systemPrompt: { value: "Changed system prompt", pinned: true },
		tools: { value: ["read"], pinned: true },
		spawns: { value: ["task"], pinned: true },
		model: { value: ["openai/gpt-4.1"], pinned: true },
		thinkingLevel: { value: "high", pinned: true },
		output: { value: { type: "object", properties: { value: { type: "string" } } }, pinned: true },
		blocking: { value: true, pinned: true },
		autoloadSkills: { value: ["different-work"], pinned: true },
		contextVariant: { value: "lane", pinned: true },
		skillList: { value: ["different-skill"], pinned: true },
		readSummarize: { value: false, pinned: true },
		source: { value: "project", pinned: false },
		filePath: { value: "/repo/.agents/task.md", pinned: false },
	} satisfies Record<keyof AgentDefinition, { value: unknown; pinned: boolean }>;

	it.each(Object.entries(agentFieldChanges))("decides %s drift before claiming the predecessor", async (field, change) => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		const changedDefinition = { ...agent, [field]: change.value } as AgentDefinition;
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [changedDefinition], projectAgentsDir: null });
		if (field === "name") settings.override("agent.agents", { task: { enabled: true }, renamed: { enabled: true } });
		const changed = await (await tool()).execute("Changed", {
			agent: changedDefinition.name, name: "Changed", task: assignment, successorOf: predecessor,
		} as TaskParams);
		if (!change.pinned) {
			expect(changed.isError).not.toBe(true);
			expect(executed).toHaveLength(2);
			return;
		}
		expect(changed.isError).toBe(true);
		expect(JSON.stringify(changed.content)).toContain("successor-workflow-changed");
		expect(executed).toHaveLength(1);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const restored = await dispatch("Restored", predecessor);
		expect(restored.isError).not.toBe(true);
		expect(executed).toHaveLength(2);
		expect(executed[1].task).toContain(`Completed safe result from ${predecessor}`);
	}, 2_000);

	it("rejects missing and non-directory cwd before consuming the claim", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		const notDirectory = dir.join("not-directory");
		await fs.writeFile(notDirectory, "plain file");
		for (const cwd of [dir.join("missing"), notDirectory]) {
			const refused = await (await tool()).execute("Bad cwd", {
				agent: "task",
				name: "Bad cwd",
				task: assignment,
				cwd,
				successorOf: predecessor,
			} as TaskParams);
			expect(refused.isError).toBe(true);
		}
		await dispatch("Valid cwd", predecessor);
		expect(executed).toHaveLength(2);
	});

	it.each([undefined, "", " ", "inherit", "  inherit  "])(
		"validates effective inherited cwd %j before consuming the claim",
		async cwd => {
			// Keep the durable session outside the cwd so deleting the cwd cannot hide the checkpoint.
			const parentCwd = dir.join("work");
			await fs.mkdir(parentCwd);
			const taskTool = await tool({ cwd: parentCwd });
			const original = await taskTool.execute("Original", {
				agent: "task", name: "Original", task: assignment,
			} as TaskParams);
			expect(original.isError).not.toBe(true);
			const predecessor = executed[0].id;
			await fs.rm(parentCwd, { recursive: true });
			for (const state of ["missing", "file"]) {
				if (state === "file") await fs.writeFile(parentCwd, "plain file");
				const refused = await taskTool.execute("Invalid inherited cwd", {
					agent: "task", name: "Invalid inherited cwd", task: assignment, cwd, successorOf: predecessor,
				} as TaskParams);
				expect(refused.isError).toBe(true);
				expect(JSON.stringify(refused.content)).toContain(
					state === "missing" ? "task cwd does not exist" : "task cwd is not a directory",
				);
				expect(executed).toHaveLength(1);
				expect((await fs.readdir(dir.join("parent"))).filter(name => name.endsWith(".claim"))).toEqual([]);
			}
			await fs.rm(parentCwd);
			await fs.mkdir(parentCwd);
			const retry = await taskTool.execute("Restored inherited cwd", {
				agent: "task", name: "Restored inherited cwd", task: assignment, cwd, successorOf: predecessor,
			} as TaskParams);
			expect(retry.isError).not.toBe(true);
			expect(executed).toHaveLength(2);
			expect(executed[1].cwd).toBe(parentCwd);
			expect(executed[1].task).toContain(`Completed safe result from ${predecessor}`);
		},
		2_000,
	);

	it("confines checkpoint lookup to the session directory without changing outside files", async () => {
		await dispatch("Original");
		const directory = dir.join("parent");
		const checkpointName = (await fs.readdir(directory)).find(name => name.endsWith(".checkpoint.json"));
		if (!checkpointName) throw new Error("No durable checkpoint");
		const checkpoint = JSON.parse(await fs.readFile(path.join(directory, checkpointName), "utf8"));
		const traversalCheckpoint = dir.join("escape.checkpoint.json");
		const traversalId = "../escape";
		const absoluteId = dir.join("absolute");
		const absoluteCheckpoint = `${absoluteId}.checkpoint.json`;
		await fs.writeFile(traversalCheckpoint, JSON.stringify({ ...checkpoint, agentId: traversalId }));
		await fs.writeFile(absoluteCheckpoint, JSON.stringify({ ...checkpoint, agentId: absoluteId }));
		const traversalBefore = await fs.readFile(traversalCheckpoint, "utf8");
		const absoluteBefore = await fs.readFile(absoluteCheckpoint, "utf8");
		for (const predecessor of [traversalId, absoluteId]) {
			const refused = await dispatch("Traversal", predecessor);
			expect(refused.isError).toBe(true);
		}
		expect(await fs.readFile(traversalCheckpoint, "utf8")).toBe(traversalBefore);
		expect(await fs.readFile(absoluteCheckpoint, "utf8")).toBe(absoluteBefore);
		expect(executed).toHaveLength(1);
	});

	it("waits for checkpoint persistence before returning the task result", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(atomicWriter, "atomicWriteJson").mockImplementation(async (file, value, options) => {
			if (String(file).endsWith(".checkpoint.json")) {
				entered.resolve();
				await gate.promise;
			}
			return writeAtomicJson(file, value, options);
		});
		let delivered = false;
		const pending = dispatch("Pending").then(value => {
			delivered = true;
			return value;
		});
		await entered.promise;
		try {
			await setImmediate();
			expect(delivered).toBe(false);
		} finally {
			gate.resolve();
		}
		expect((await pending).isError).not.toBe(true);
	}, 2_000);

	it("surfaces checkpoint writer failures instead of returning a clean lane result", async () => {
		vi.spyOn(atomicWriter, "atomicWriteJson").mockImplementation(async (file, value, options) => {
			if (String(file).endsWith(".checkpoint.json")) throw new Error("checkpoint disk failure");
			return writeAtomicJson(file, value, options);
		});
		const failed = await dispatch("Write failure");
		expect(failed.isError).toBe(true);
		expect(JSON.stringify(failed.details)).toContain("successor-checkpoint-write-failed");
		expect(JSON.stringify(failed.details)).toContain("checkpoint disk failure");
	});

	it("rejects wrong checkpoint identity, required shape and stale version one", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		const directory = dir.join("parent");
		const file = (await fs.readdir(directory)).find(name => name.endsWith(".checkpoint.json"));
		if (!file) throw new Error("No durable checkpoint");
		const checkpointPath = path.join(directory, file);
		const original = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
		const invalidCheckpoints: Array<[string, unknown]> = [
			["wrong agent ID", { ...original, agentId: "Wrong identity" }],
			["missing required results", { ...original, results: undefined }],
			["stale version one", { ...original, version: 1 }],
		];
		for (const [caseName, invalid] of invalidCheckpoints) {
			await fs.writeFile(checkpointPath, JSON.stringify(invalid));
			const refused = await dispatch("Invalid shape", predecessor);
			expect(refused.isError, caseName).toBe(true);
			expect(JSON.stringify(refused.content)).toContain("successor-checkpoint-unavailable");
			expect(executed).toHaveLength(1);
		}
	});

	it("completes concurrent claims and the third-successor refusal within a deadline", async () => {
		await dispatch("Original");
		const predecessor = executed[0].id;
		await Promise.all([dispatch("One", predecessor), dispatch("Two", predecessor)]);
		expect(executed).toHaveLength(2);
		await dispatch("Second", executed[1].id);
		const third = await dispatch("Third", executed[2].id);
		expect(third.isError).toBe(true);
		expect(JSON.stringify(third.content)).toContain("successor-limit");
	}, 2_000);

	it("refuses workflow drift instead of silently resuming different topology", async () => {
		await dispatch("Original");
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [{ ...agent, systemPrompt: "Different workflow" }],
			projectAgentsDir: null,
		});
		const refused = await dispatch("Changed", executed[0].id);
		expect(executed).toHaveLength(1);
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("successor-workflow-changed");
	});
});
