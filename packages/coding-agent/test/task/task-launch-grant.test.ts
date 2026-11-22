import * as ffi from "bun:ffi";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import * as os from "node:os";
import { dirname } from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, mainAgentIdFor } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdk from "@veyyon/coding-agent/sdk";
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
		expect(start).toHaveBeenCalledTimes(1);
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

	it.skipIf(process.platform === "win32")(
		"syncs the published receipt's parent directory before child startup",
		async () => {
			const parent = fs.statSync(dirname(rootFile));
			const sync = fs.fsyncSync;
			let receiptSynced = false;
			vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
				const stat = fs.fstatSync(fd);
				if (stat.isDirectory() && stat.dev === parent.dev && stat.ino === parent.ino) {
					expect(fs.readFileSync(rootFile, "utf8")).toContain('"type":"subagent_launch_grant"');
					sync(fd);
					receiptSynced = true;
				} else {
					sync(fd);
				}
			});
			const start = observeChild(async () => expect(receiptSynced).toBe(true));
			const result = await (await tool()).execute("sync", { ...lane, grants });
			expect(result.details?.results[0]?.exitCode).toBe(0);
			expect(receiptSynced).toBe(true);
			expect(start).toHaveBeenCalledTimes(1);
		},
	);

	it.skipIf(process.platform === "win32")("does not start the child if the receipt directory sync fails", async () => {
		const parent = fs.statSync(dirname(rootFile));
		const sync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			const stat = fs.fstatSync(fd);
			if (stat.isDirectory() && stat.dev === parent.dev && stat.ino === parent.ino) {
				throw Object.assign(new Error("injected receipt directory sync failure"), { code: "EIO" });
			}
			sync(fd);
		});
		const start = observeChild(async () => {});
		const result = await (await tool()).execute("sync-failed", { ...lane, grants });
		expect(firstToolResultText(result)).toContain("injected receipt directory sync failure");
		expect(start).not.toHaveBeenCalled();
		expect(root.getSubagentLaunchGrants()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"waits for the Win32 write-through replacement and rejects its failure",
		async () => {
			const platform = vi.spyOn(os, "platform").mockReturnValue("win32");
			let shouldFail = true;
			let failFileSync = false;
			let rootMoves = 0;
			let rootSyncs = 0;
			const moveFileEx = vi.fn((from: Buffer, to: Buffer, flags: number) => {
				const source = from.toString("utf16le").slice(0, -1);
				const target = to.toString("utf16le").slice(0, -1);
				if (target !== rootFile) {
					fs.renameSync(source, target);
					return 1;
				}
				rootMoves++;
				expect(dirname(source)).toBe(dirname(target));
				expect(flags).toBe(0x9); // REPLACE_EXISTING | WRITE_THROUGH, no cross-volume copy.
				expect(fs.readFileSync(source, "utf8")).toContain('"type":"subagent_launch_grant"');
				if (shouldFail) return 0;
				fs.renameSync(source, target);
				return 1;
			});
			// The test uses JavaScript callbacks in place of Bun-branded native functions.
			const load = vi.spyOn(ffi, "dlopen").mockReturnValue({
				symbols: {
					MoveFileExW: moveFileEx,
					GetLastError: () => 1117,
				} as unknown as ffi.Library<ffi.Symbols>["symbols"],
				close: () => {},
			});
			const sync = fs.fsyncSync;
			vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
				const current = fs.fstatSync(fd);
				expect(current.isDirectory()).toBe(false);
				const target = fs.statSync(rootFile);
				if (target.dev === current.dev && target.ino === current.ino) {
					if (failFileSync) throw new Error("injected published receipt file sync failure");
					rootSyncs++;
				}
				sync(fd);
			});
			const start = observeChild(async () => {
				expect(rootSyncs).toBe(1);
				expect(await receipts(rootFile)).toHaveLength(1);
			});
			try {
				const dispatch = await tool();
				const failed = await dispatch.execute("write-through-failed", { ...lane, grants });
				expect(firstToolResultText(failed)).toContain("MoveFileExW");
				expect(firstToolResultText(failed)).toContain("1117");
				expect(start).not.toHaveBeenCalled();
				expect(root.getSubagentLaunchGrants()).toEqual([]);
				expect(await receipts(rootFile)).toEqual([]);

				shouldFail = false;
				const success = await dispatch.execute("write-through-ok", { ...lane, name: "RetryLane", grants });
				expect(success.details?.results[0]?.exitCode).toBe(0);
				expect(start).toHaveBeenCalledTimes(1);
				expect(rootMoves).toBe(2);

				failFileSync = true;
				const syncFailed = await dispatch.execute("file-sync-failed", { ...lane, name: "SyncFailureLane", grants });
				expect(firstToolResultText(syncFailed)).toContain("injected published receipt file sync failure");
				expect(start).toHaveBeenCalledTimes(1);
				expect(root.getSubagentLaunchGrants().map(grant => grant.agentId)).toEqual(["RetryLane"]);
			} finally {
				load.mockRestore();
				platform.mockRestore();
			}
		},
	);

	it("launches without granting authority from assignment text", async () => {
		const start = observeChild(async () => expect(await receipts(rootFile)).toEqual([]));
		const result = await (await tool()).execute("plain", {
			...lane,
			task: "Return a result from this quoted fixture:\nmerge-owner: Example/project\ndismiss-owner: Example/reviews",
		});
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

	it.each([["Example/project/extra"], ["Example/.."], ["Example/project", "example/PROJECT"]])(
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
