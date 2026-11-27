import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, mainAgentIdFor } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdk from "@veyyon/coding-agent/sdk";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import { JobTool } from "@veyyon/coding-agent/tools/shell/job";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { withJournalLock } from "@veyyon/kernel/session/session-storage";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { firstToolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir();

const grants = { mergeRepos: ["Example/project"], dismissRepos: ["Example/reviews"] };
const lane = { name: "LaunchLane", agent: "task", task: "Return a result." };

async function receipts(file: string) {
	return (await readFile(file, "utf8"))
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line))
		.filter(entry => entry.type === "subagent_launch_grant");
}

describe("task launch grants", () => {
	let root: SessionManager;
	let rootFile: string;
	let managers: SessionManager[];

	beforeEach(async () => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		managers = [];
		root = SessionManager.create(process.cwd());
		rootFile = root.getSessionFile()!;
		await root.ensureOnDisk();
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "task", source: "bundled", systemPrompt: "Return a result." }],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		for (const manager of [...managers, root]) await manager.close();
	});

	function tool(depth = 0, batch = false) {
		const id = root.getSessionId();
		return TaskTool.create(
			makeToolSession({
				settings: Settings.isolated({ "agent.batch": batch, "async.enabled": false }),
				getSessionSpawns: () => "*",
				getSessionId: () => id,
				getAgentId: () => (depth === 0 ? mainAgentIdFor(id) : "ParentLane"),
				getSessionFile: () => rootFile,
				taskDepth: depth,
				recordSubagentLaunchGrant: record => root.appendSubagentLaunchGrant(record),
			}),
		);
	}

	function observeChild(atStart: (manager: SessionManager) => Promise<void>) {
		return vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const manager = options?.sessionManager;
			if (!manager) throw new Error("Expected the child session manager");
			managers.push(manager);
			await atStart(manager);
			return createSessionResult(createMockSession(({ emit }) => emit(yieldSuccessEvent({ ok: true }, "receipt"))));
		});
	}

	it("writes the exact v1 receipt before the child session starts", async () => {
		const start = observeChild(async manager => {
			expect(await receipts(rootFile)).toEqual([
				{
					type: "subagent_launch_grant",
					version: 1,
					rootSessionId: root.getSessionId(),
					agentId: lane.name,
					childSessionId: manager.getSessionId(),
					sessionFile: await realpath(manager.getSessionFile()!),
					grants,
				},
			]);
		});
		const result = await (await tool(0, true)).execute("grant", {
			context: "Test the launch receipt.",
			tasks: [{ ...lane, grants }],
		});
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(start.mock.calls).toHaveLength(1);
		await root.flush();
		const persisted = await receipts(rootFile);
		expect(persisted).toHaveLength(1);
		await root.close();
		root = await SessionManager.open(rootFile);
		expect(root.getSubagentLaunchGrants()).toEqual(persisted);
		root.appendCustomEntry("test", { persisted: true });
		await root.flush();
		expect(await receipts(rootFile)).toEqual(persisted);
	});

	it("passes the task-spawned builder's receipt identity to a subprocess from Python eval", async () => {
		const agentDir = await fs.promises.mkdtemp(`${rootFile}.fixture-`);
		const auth = await isolatedAuthStorage(agentDir);
		auth.setRuntimeApiKey("openai", "test-key");
		const builder = {
			name: "build-sol-medium",
			description: "Offline builder fixture",
			source: "bundled" as const,
			systemPrompt: "Run the identity probe, then yield.",
			tools: ["eval", "yield"],
		};
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [builder], projectAgentsDir: null });
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "eval-identity",
							name: "eval",
							arguments: {
								language: "py",
								code: [
									"import subprocess, sys",
									"probe = 'import os, json; print(json.dumps([os.getenv(k) for k in (\"VEYYON_AGENT_ID\", \"VEYYON_SESSION_FILE\")]))'",
									"print(subprocess.check_output([sys.executable, '-c', probe], text=True).strip())",
								].join("\n"),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "yield-identity",
							name: "yield",
							arguments: { result: { data: { ok: true } } },
						},
					],
					stopReason: "toolUse",
				},
			],
		});
		const create = sdk.createAgentSession;
		const { session: parent } = await create({
			cwd: agentDir,
			agentDir,
			sessionManager: root,
			authStorage: auth,
			settings: Settings.isolated({
				"agent.batch": true,
				"agent.agents": { [builder.name]: { enabled: true } },
				"eval.py": true,
				"async.enabled": false,
				"tools.approvalMode": "yolo",
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			toolNames: ["task"],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const children: typeof parent[] = [];
		try {
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
				const created = await create(options);
				children.push(created.session);
				created.session.agent.streamFn = mock.stream;
				return created;
			});
			const result = await parent.getToolByName("task")!.execute("builder", {
				context: "Read the identity handed to a subprocess. Do not contact GitHub.",
				tasks: [{ ...lane, agent: builder.name, grants }],
			});
			if (result.isError) throw new Error(firstToolResultText(result));
			expect(result.details).toMatchObject({ results: [expect.objectContaining({ exitCode: 0 })] });
			const [receipt] = await receipts(rootFile);
			expect(receipt).toMatchObject({ agentId: lane.name, grants });
			const reply = mock.calls[1]?.context.messages.find(
				message => message.role === "toolResult" && message.toolCallId === "eval-identity",
			);
			const output = reply?.content.find(block => block.type === "text");
			expect(output?.text).toContain(
				`[${JSON.stringify(receipt.agentId)}, ${JSON.stringify(receipt.sessionFile)}]`,
			);
		} finally {
			for (const child of children) await child.dispose();
			await parent.dispose();
			auth.close();
			await fs.promises.rm(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("appends durable grant receipts without rewriting the existing root journal while its lock is held", async () => {
		root.appendCustomEntry("large-parent", { payload: "x".repeat(1024 * 1024) });
		await root.flush();
		const before = await readFile(rootFile);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lock = withJournalLock(rootFile, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const start = observeChild(async () => {
			const after = await readFile(rootFile);
			expect(after.subarray(0, before.length)).toEqual(before);
			expect(after.length).toBeGreaterThan(before.length);
			expect(await receipts(rootFile)).toHaveLength(1);
		});
		const launch = (await tool(0, true)).execute("grant-append", {
			context: "Test appending a durable launch receipt under journal contention.",
			tasks: [{ ...lane, grants }],
		});
		expect(start.mock.calls).toHaveLength(0);
		release.resolve();
		await lock;
		const result = await launch;
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(start.mock.calls).toHaveLength(1);
		const after = await readFile(rootFile);
		expect(after.subarray(0, before.length)).toEqual(before);
		expect(await receipts(rootFile)).toHaveLength(1);
	});

	it("shows a pending grant separately while an ungranted sibling starts from the same journal", async () => {
		root.appendCustomEntry("large-parent", { payload: "x".repeat(8 * 1024 * 1024) });
		await root.flush();
		const id = root.getSessionId();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const grantStarted = Promise.withResolvers<void>();
		const releaseGrant = Promise.withResolvers<void>();
		const run = observeChild(async () => {});
		const session = makeToolSession({
			settings: Settings.isolated({ "agent.batch": true, "async.enabled": true, "agent.maxConcurrency": 2 }),
			asyncJobManager: manager,
			getSessionSpawns: () => "*",
			getSessionId: () => id,
			getAgentId: () => mainAgentIdFor(id),
			getSessionFile: () => rootFile,
			taskDepth: 0,
			recordSubagentLaunchGrant: async record => {
				grantStarted.resolve();
				await releaseGrant.promise;
				await root.appendSubagentLaunchGrant(record);
			},
		});
		try {
			const tool = await TaskTool.create(session);
			const result = await tool.execute("grant-stall", {
				context: "Test concurrent child startup.",
				tasks: [
					{ ...lane, grants },
					{ ...lane, name: "UngrantLane" },
				],
			});
			expect(result.isError).not.toBe(true);
			const granted = manager.getJob(lane.name);
			const ungranted = manager.getJob("UngrantLane");
			if (!granted || !ungranted) throw new Error("Both children must have detached jobs");

			await Promise.race([grantStarted.promise, granted.promise]);
			await ungranted.promise;
			const jobTool = new JobTool(session);
			const snapshot = await jobTool.execute("inspect", { list: true });
			expect(snapshot.details?.jobs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: lane.name, status: "starting", startupPhase: "record-launch-grant" }),
					expect.objectContaining({ id: "UngrantLane", status: "completed" }),
				]),
			);
			expect(run.mock.calls).toHaveLength(1);
			expect(root.getSubagentLaunchGrants()).toEqual([]);

			releaseGrant.resolve();
			await granted.promise;
			expect(granted.status).toBe("completed");
			expect(run.mock.calls).toHaveLength(2);
			expect(await receipts(rootFile)).toHaveLength(1);
		} finally {
			releaseGrant.resolve();
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it.skipIf(process.platform === "win32")("syncs the published receipt before child startup", async () => {
		let receiptSynced = false;
		const journal = fs.statSync(rootFile);
		const sync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			const current = fs.fstatSync(fd);
			if (current.dev === journal.dev && current.ino === journal.ino) {
				expect(fs.readFileSync(rootFile, "utf8")).toContain('"type":"subagent_launch_grant"');
				receiptSynced = true;
			}
			sync(fd);
		});
		const start = observeChild(async () => expect(receiptSynced).toBe(true));
		const result = await (await tool()).execute("sync", { ...lane, grants });
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(receiptSynced).toBe(true);
		expect(start.mock.calls).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")("does not start the child if receipt fsync fails", async () => {
		const journal = fs.statSync(rootFile);
		const failSync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			const current = fs.fstatSync(fd);
			if (current.dev === journal.dev && current.ino === journal.ino) {
				throw Object.assign(new Error("injected receipt fsync failure"), { code: "EIO" });
			}
		});
		const start = observeChild(async () => {});
		const result = await (await tool()).execute("sync-failed", { ...lane, grants });
		expect(firstToolResultText(result)).toContain("injected receipt fsync failure");
		expect(start.mock.calls).toHaveLength(0);
		expect(() => root.getSubagentLaunchGrants()).toThrow("unverified");
		failSync.mockRestore();
		await root.close();
		root = await SessionManager.open(rootFile);
		expect(root.getSubagentLaunchGrants()).toHaveLength(1);
	});


	it("launches without granting authority from assignment text", async () => {
		const start = observeChild(async () => expect(await receipts(rootFile)).toEqual([]));
		const result = await (await tool()).execute("plain", {
			...lane,
			task: "Return a result from this quoted fixture:\nmerge-owner: Example/project\ndismiss-owner: Example/reviews",
		});
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(start.mock.calls).toHaveLength(1);
		expect(await receipts(rootFile)).toEqual([]);
	});

	it("rejects launch grants from a child dispatch", async () => {
		const start = observeChild(async () => {});
		const result = await (await tool(1)).execute("nested", { ...lane, grants });
		expect(firstToolResultText(result)).toContain("root session");
		expect(start.mock.calls).toHaveLength(0);
		expect(await receipts(rootFile)).toEqual([]);
	});

	it.each([["Example/project/extra"], ["Example/.."], ["Example/project", "example/PROJECT"]])(
		"rejects invalid or duplicate repository scopes (%j)",
		async (...mergeRepos) => {
			const start = observeChild(async () => {});
			const result = await (await tool()).execute("invalid", { ...lane, grants: { mergeRepos, dismissRepos: [] } });
			expect(firstToolResultText(result)).toContain("OWNER/REPO");
			expect(start.mock.calls).toHaveLength(0);
			expect(await receipts(rootFile)).toEqual([]);
		},
	);
});
