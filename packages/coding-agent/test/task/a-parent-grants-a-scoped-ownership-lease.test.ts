// WHY: a child mistook ancestor-handed dirty files for a competing writer.
// Drive TaskTool through its real spawn boundary; the external child process is controlled.
// This proves runtime scope and context delivery, not a model's decision to follow the context.
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import * as executor from "@veyyon/coding-agent/task/executor";
import * as isolationOwnership from "@veyyon/coding-agent/task/isolation-ownership";
import { type AgentDefinition, getTaskSchema, type SingleResult } from "@veyyon/coding-agent/task/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

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

async function fixture(options: { batch?: boolean; isolation?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "lease-contract-"));
	roots.push(root);
	await writeFile(join(root, "owned.txt"), "ancestor's uncommitted work");
	const artifacts = join(root, "artifacts");
	const run = vi.spyOn(executor, "runSubprocess").mockImplementation(
		async options =>
			({
				index: 0,
				id: options.id,
				agent: "task",
				agentSource: "bundled",
				task: options.task,
				assignment: "Continue the handed-off edit",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 1,
			}) as SingleResult,
	);
	const tool = await TaskTool.create(
		makeToolSession({
			cwd: root,
			hasUI: false,
			getAgentId: () => "Parent",
			getSessionFile: () => join(root, "artifacts.jsonl"),
			getArtifactsDir: () => artifacts,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"async.enabled": false,
				"agent.batch": options.batch ?? false,
				"agent.isolation.mode": options.isolation ? "worktree" : "none",
			}),
		}),
	);
	return { root, artifacts, run, tool };
}

test("an ancestor hands a dirty path to its child with a durable runtime receipt", async () => {
	const { root, artifacts, run, tool } = await fixture();
	for (const args of [
		["init", "-q"],
		["add", "owned.txt"],
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			`core.hooksPath=${join(root, "no-hooks")}`,
			"commit",
			"-qm",
			"baseline",
		],
	])
		execFileSync("git", args, { cwd: root, timeout: 10_000, windowsHide: true });
	await writeFile(join(root, "owned.txt"), "ancestor's handed-off edit");
	expect(
		execFileSync("git", ["diff", "--name-only"], { cwd: root, timeout: 10_000, windowsHide: true }).toString().trim(),
	).toBe("owned.txt");
	const expiresAt = new Date(Date.now() + 60_000).toISOString();
	await tool.execute("lease-valid", {
		agent: "task",
		name: "Child",
		task: "Continue the handed-off edit",
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
	const canonicalRoot = process.platform === "win32" ? root.toLowerCase() : root;
	expect(lease).toMatchObject({
		version: 1,
		grantor: "Parent",
		owner: run.mock.calls[0]![0]!.id,
		worktree: canonicalRoot,
		paths: [join(canonicalRoot, "owned.txt")],
		expiresAt,
	});
	const contextLease = prompt.split("\n").find(line => line.startsWith("{")) ?? "";
	expect(JSON.parse(contextLease)).toEqual(lease);
});

for (const [name, paths, expiry] of [
	["expired", ["owned.txt"], "2000-01-01T00:00:00.000Z"],
	["out-of-scope", ["../other-writer.txt"], "2099-01-01T00:00:00.000Z"],
	["empty", [], "2099-01-01T00:00:00.000Z"],
	["blank-path", ["   "], "2099-01-01T00:00:00.000Z"],
	["invalid-expiry", ["owned.txt"], "not-a-date"],
] as const) {
	test(`a ${name} lease cannot authorize a child`, async () => {
		const { run, tool } = await fixture();
		const result = await tool.execute(`lease-${name}`, {
			agent: "task",
			name: "Child",
			task: "Continue",
			ownershipLease: { paths: [...paths], expiresAt: expiry },
		});
		expect(run).not.toHaveBeenCalled();
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("ownership-lease") }),
			]),
		);
	});
}

test("a spawn without a lease keeps the unknown-writer guard", async () => {
	const { artifacts, run, tool } = await fixture();
	await tool.execute("lease-none", { agent: "task", name: "Child", task: "Inspect only" });
	expect(run.mock.calls[0]?.[0]?.task).toContain("Delegation does not establish exclusive write ownership");
	expect((await readdir(artifacts)).filter(name => name.endsWith(".ownership-lease.json"))).toEqual([]);
});

test("a symlink cannot carry a lease outside the child's worktree", async () => {
	const { root, run, tool } = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "lease-outside-"));
	roots.push(outside);
	await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
	const result = await tool.execute("lease-symlink", {
		agent: "task",
		name: "Child",
		task: "Continue",
		ownershipLease: { paths: ["escape/new.txt"], expiresAt: "2099-01-01T00:00:00.000Z" },
	});
	expect(run).not.toHaveBeenCalled();
	expect(result.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("outside") })]),
	);
});

test("an isolated spawn cannot inherit an ancestor's dirty-path lease", async () => {
	const { run, tool } = await fixture({ isolation: true });
	const result = await tool.execute("lease-isolated", {
		agent: "task",
		name: "Child",
		task: "Continue",
		isolated: true,
		ownershipLease: { paths: ["owned.txt"], expiresAt: "2099-01-01T00:00:00.000Z" },
	});
	expect(run).not.toHaveBeenCalled();
	expect(result.content).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "text", text: expect.stringContaining("ownership-lease") }),
		]),
	);
});

test("a batch writes one runtime-bound lease receipt per child", async () => {
	const { artifacts, run, tool } = await fixture({ batch: true });
	const expiresAt = "2099-01-01T00:00:00.000Z";
	await tool.execute("lease-batch", {
		context: "Continue separate handed-off paths",
		tasks: [
			{ agent: "task", name: "First", task: "First path", ownershipLease: { paths: ["first.txt"], expiresAt } },
			{ agent: "task", name: "Second", task: "Second path", ownershipLease: { paths: ["second.txt"], expiresAt } },
		],
	});
	expect(run).toHaveBeenCalledTimes(2);
	const names = (await readdir(artifacts)).filter(name => name.endsWith(".ownership-lease.json"));
	expect(names).toHaveLength(2);
	const leases = await Promise.all(names.map(async name => JSON.parse(await readFile(join(artifacts, name), "utf8"))));
	expect(leases.map(lease => lease.owner).sort()).toEqual(run.mock.calls.map(([options]) => options.id).sort());
	expect(leases.every(lease => lease.grantor === "Parent" && lease.expiresAt === expiresAt)).toBe(true);
});

for (const batchEnabled of [false, true]) {
	for (const isolationEnabled of [false, true]) {
		for (const dynamic of [false, true]) {
			test(`the ${batchEnabled ? "batch" : "flat"} lease wire shape survives isolation=${isolationEnabled}, dynamic=${dynamic}`, () => {
				const schema = getTaskSchema({
					batchEnabled,
					isolationEnabled,
					...(dynamic ? { defaultAgent: "task", enabledAgentNames: ["task"] } : {}),
				});
				const lease = { paths: ["owned.txt"], expiresAt: "2099-01-01T00:00:00.000Z" };
				const item = {
					agent: "task",
					task: "Continue",
					ownershipLease: {
						...lease,
						grantor: "forged",
						owner: "forged",
						worktree: "/forged",
					},
				};
				const parsed = schema.assert(batchEnabled ? { context: "Context", tasks: [item] } : item);
				const expected = { agent: "task", task: "Continue", ownershipLease: lease };
				expect(parsed).toEqual(batchEnabled ? { context: "Context", tasks: [expected] } : expected);
			});
		}
	}
}

test("a lease that expires during path resolution cannot start its child", async () => {
	const { run, tool } = await fixture();
	let clock = Date.now();
	const expiry = clock + 60_000;
	const canonicalPath = isolationOwnership.canonicalIsolationPath;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	vi.spyOn(isolationOwnership, "canonicalIsolationPath").mockImplementation(async target => {
		const resolved = await canonicalPath(target);
		if (target.endsWith("owned.txt")) clock = expiry + 1;
		return resolved;
	});
	const result = await tool.execute("lease-during-resolution", {
		agent: "task",
		name: "Child",
		task: "Continue",
		ownershipLease: { paths: ["owned.txt"], expiresAt: new Date(expiry).toISOString() },
	});
	expect(run).not.toHaveBeenCalled();
	expect(result.content).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "text", text: expect.stringContaining("expired") }),
		]),
	);
});

test("a stale receipt cannot authorize a spawn or be overwritten", async () => {
	const { root, artifacts, run, tool } = await fixture();
	await mkdir(artifacts, { recursive: true });
	const receipt = join(artifacts, "Child.ownership-lease.json");
	const stale = {
		version: 0,
		owner: "Child",
		worktree: root,
		paths: [],
		expiresAt: "2000-01-01T00:00:00.000Z",
	};
	await writeFile(receipt, JSON.stringify(stale));
	const result = await tool.execute("lease-stale", {
		agent: "task",
		name: "Child",
		task: "Continue",
		ownershipLease: { paths: ["owned.txt"], expiresAt: "2099-01-01T00:00:00.000Z" },
	});
	expect(run).not.toHaveBeenCalled();
	expect(result.isError).toBe(true);
	expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(stale);
});

test("a lease that expires while its receipt is persisted cannot start its child", async () => {
	const { run, tool } = await fixture();
	let clock = Date.now();
	const expiry = clock + 60_000;
	const persist = fs.writeFile;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
		await persist(file, data, options);
		if (String(file).endsWith(".ownership-lease.json")) clock = expiry + 1;
	});
	const result = await tool.execute("lease-during-persistence", {
		agent: "task",
		name: "Child",
		task: "Continue",
		ownershipLease: { paths: ["owned.txt"], expiresAt: new Date(expiry).toISOString() },
	});
	expect(run).not.toHaveBeenCalled();
	expect(result.isError).toBe(true);
});
