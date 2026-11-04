// WHY: a child mistook ancestor-handed dirty files for a competing writer.
// Drive TaskTool through its real spawn boundary; the external child process is controlled.
// This proves runtime scope and context delivery, not a model's decision to follow the context.
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import * as executor from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import { makeToolSession } from "../helpers/tool-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();
const roots: string[] = [];
const agent: AgentDefinition = { name: "task", description: "Task", systemPrompt: "Task", source: "bundled" };
beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
});
afterEach(async () => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "lease-contract-"));
	roots.push(root);
	await writeFile(join(root, "owned.txt"), "ancestor's uncommitted work");
	const artifacts = join(root, "artifacts");
	const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => ({
		index: 0, id: options.id, agent: "task", agentSource: "bundled", task: options.task,
		assignment: "Continue the handed-off edit", exitCode: 0, output: "done", stderr: "",
		truncated: false, durationMs: 0, tokens: 0, requests: 1,
	} as SingleResult));
	const tool = await TaskTool.create(makeToolSession({ cwd: root, hasUI: false, getAgentId: () => "Parent", getSessionFile: () => join(root, "artifacts.jsonl"), getArtifactsDir: () => artifacts, getSessionSpawns: () => "*",
		settings: Settings.isolated({ "async.enabled": false, "agent.batch": false }), }));
	return { root, artifacts, run, tool };
}

test("an ancestor hands a dirty path to its child with a durable runtime receipt", async () => {
	const { root, artifacts, run, tool } = await fixture();
	const expiresAt = new Date(Date.now() + 60_000).toISOString();
	await tool.execute("lease-valid", {
		agent: "task", name: "Child", task: "Continue the handed-off edit",
		ownershipLease: { paths: ["owned.txt"], expiresAt },
	});
	const prompt = run.mock.calls[0]?.[0]?.task ?? "";
	expect(prompt).toContain("Runtime ownership lease");
	expect(prompt).toContain(expiresAt);
	expect(prompt).toContain("owned.txt");
	expect(prompt).toContain("Parent");
	const receipts = (await readdir(artifacts)).filter(name => name.endsWith(".ownership-lease.json"));
	expect(receipts).toHaveLength(1);
	const lease = JSON.parse(await readFile(join(artifacts, receipts[0]!), "utf8"));
	expect(lease).toMatchObject({ version: 1, grantor: "Parent", owner: run.mock.calls[0]![0]!.id, worktree: root, paths: [join(root, "owned.txt")], expiresAt });
});

for (const [name, paths, expiry] of [
	["expired", ["owned.txt"], "2000-01-01T00:00:00.000Z"],
	["out-of-scope", ["../other-writer.txt"], "2099-01-01T00:00:00.000Z"],
	["empty", [], "2099-01-01T00:00:00.000Z"],
	["invalid-expiry", ["owned.txt"], "not-a-date"],
] as const) {
	test(`a ${name} lease cannot authorize a child`, async () => {
		const { run, tool } = await fixture();
		const result = await tool.execute(`lease-${name}`, {
			agent: "task", name: "Child", task: "Continue",
			ownershipLease: { paths: [...paths], expiresAt: expiry },
		});
		expect(run).not.toHaveBeenCalled();
		expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("ownership-lease") })]));
	});
}

test("a spawn without a lease keeps the unknown-writer guard", async () => {
	const { artifacts, run, tool } = await fixture();
	await tool.execute("lease-none", { agent: "task", name: "Child", task: "Inspect only" });
	expect(run.mock.calls[0]?.[0]?.task).toContain("Delegation does not establish exclusive write ownership");
	expect((await readdir(artifacts)).filter(name => name.endsWith(".ownership-lease.json"))).toEqual([]);
});
