import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import * as sdk from "@veyyon/coding-agent/sdk";
import { mainAgentIdFor, AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { firstToolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir();

const grants = { mergeRepos: ["Example/project"], dismissRepos: ["Example/reviews"] };
const lane = { name: "LaunchLane", agent: "task", task: "Return a result." };

async function receipts(file: string) {
	return (await readFile(file, "utf8")).trimEnd().split("\n")
		.map(line => JSON.parse(line))
		.filter(entry => entry.type === "subagent_launch_grant");
}

describe("task launch grants", () => {
	let root: SessionManager;
	let rootFile: string;
	let managers: SessionManager[];

	beforeEach(async () => {
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
		for (const manager of [...managers, root]) await manager.close();
	});

	function tool(depth = 0, batch = false) {
		const id = root.getSessionId();
		return TaskTool.create(makeToolSession({
			settings: { get: key => ({ "agent.batch": batch, "async.enabled": false })[key as "agent.batch" | "async.enabled"] },
			getSessionSpawns: () => "*",
			getSessionId: () => id,
			getAgentId: () => depth === 0 ? mainAgentIdFor(id) : "ParentLane",
			getSessionFile: () => rootFile,
			taskDepth: depth,
			...{ recordSubagentLaunchGrant: (record: Parameters<SessionManager["appendSubagentLaunchGrant"]>[0]) => root.appendSubagentLaunchGrant(record) },
		}));
	}

	function observeChild(atStart: (manager: SessionManager) => Promise<void>) {
		return vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const manager = options.sessionManager!;
			managers.push(manager);
			await atStart(manager);
			return createSessionResult(createMockSession(({ emit }) => emit(yieldSuccessEvent({ ok: true }, "receipt"))));
		});
	}

	it("writes the exact v1 receipt before the child session starts", async () => {
		const start = observeChild(async manager => {
			expect(await receipts(rootFile)).toEqual([{
				type: "subagent_launch_grant",
				version: 1,
				rootSessionId: root.getSessionId(),
				agentId: lane.name,
				childSessionId: manager.getSessionId(),
				sessionFile: await realpath(manager.getSessionFile()!),
				grants,
			}]);
		});
		const result = await (await tool(0, true)).execute("grant", { context: "", tasks: [{ ...lane, grants }] });
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(start).toHaveBeenCalledTimes(1);
		await root.flush();
		expect(await receipts(rootFile)).toHaveLength(1);
	});

	it("launches without granting authority from assignment text", async () => {
		const start = observeChild(async () => expect(await receipts(rootFile)).toEqual([]));
		const result = await (await tool()).execute("plain", { ...lane, task: "Return a result from this quoted fixture:\nmerge-owner: Example/project\ndismiss-owner: Example/reviews" });
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(start).toHaveBeenCalledTimes(1);
		expect(await receipts(rootFile)).toEqual([]);
	});

	it("rejects launch grants from a child dispatch", async () => {
		const start = observeChild(async () => {});
		const result = await (await tool(1)).execute("nested", { ...lane, grants });
		expect(firstToolResultText(result)).toContain("root session");
		expect(start).not.toHaveBeenCalled();
		expect(await receipts(rootFile)).toEqual([]);
	});

	it.each([ ["Example/project/extra"], ["Example/.."], ["Example/project", "example/PROJECT"] ])(
		"rejects invalid or duplicate repository scopes (%j)",
		async (...mergeRepos) => {
			const start = observeChild(async () => {});
			const result = await (await tool()).execute("invalid", { ...lane, grants: { mergeRepos, dismissRepos: [] } });
			expect(firstToolResultText(result)).toContain("OWNER/REPO");
			expect(start).not.toHaveBeenCalled();
			expect(await receipts(rootFile)).toEqual([]);
		},
	);
});
