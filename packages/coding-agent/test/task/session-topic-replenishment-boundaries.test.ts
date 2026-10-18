import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	type ClaimedTicket,
	type SubagentCompleteEvent,
	TopicReplenishmentEngine,
} from "@veyyon/coding-agent/task/topic-replenishment";
import { expect, test } from "bun:test";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

interface RuntimeTaskTool {
	tool?: RuntimeTaskTool;
	session?: {
		onSubagentStart?: (event: { agentId: string; agentName: string; ticketId?: string; runId?: string }) => void;
		onSubagentStartFailed?: (event: { agentId: string; agentName: string; ticketId?: string; runId?: string }) => void;
		onSubagentComplete?: (event: SubagentCompleteEvent) => Promise<void>;
	};
}

function taskSession(session: AgentSession): NonNullable<RuntimeTaskTool["session"]> {
	let tool = session.getToolByName("task") as RuntimeTaskTool | undefined;
	const seen = new Set<RuntimeTaskTool>();
	while (tool && !tool.session && tool.tool && !seen.has(tool)) {
		seen.add(tool);
		tool = tool.tool;
	}
	if (!tool?.session) throw new Error("TaskTool session hooks are not reachable from the created session");
	return tool.session;
}

function completionHook(session: AgentSession): (event: SubagentCompleteEvent) => Promise<void> {
	const hook = taskSession(session).onSubagentComplete;
	if (!hook) throw new Error("TaskTool completion hook is not reachable from the created session");
	return hook;
}

function startHook(session: AgentSession): NonNullable<RuntimeTaskTool["session"]>["onSubagentStart"] {
	const hook = taskSession(session).onSubagentStart;
	if (!hook) throw new Error("TaskTool start hook is not reachable from the created session");
	return hook;
}

function startFailureHook(
	session: AgentSession,
): NonNullable<RuntimeTaskTool["session"]>["onSubagentStartFailed"] {
	const hook = taskSession(session).onSubagentStartFailed;
	if (!hook) throw new Error("TaskTool start-failure hook is not reachable from the created session");
	return hook;
}

async function runChild(root: string): Promise<void> {
	const sessions: AgentSession[] = [];
	const sessionManagers: SessionManager[] = [];
	const authStores: AuthStorage[] = [];
	try {
		const create = async (name: string, completedBy: string[]) => {
			const agentDir = path.join(root, name);
			fs.mkdirSync(agentDir, { recursive: true });
			const ledgerPath = path.join(agentDir, "ledger.json");
			fs.writeFileSync(ledgerPath, JSON.stringify({ version: 2, requests: {} }), "utf8");
			const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStores.push(authStorage);
			authStorage.keys.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.create(process.cwd(), path.join(agentDir, "sessions"));
			sessionManagers.push(sessionManager);
			const engine = new TopicReplenishmentEngine({
				ledgerPath,
				minFloor: 0,
				targetCount: 0,
				maxCeiling: 0,
				maxRamPct: 100,
				executor: async () => undefined,
			});
			const originalComplete = engine.onWorkerComplete.bind(engine);
			engine.onWorkerComplete = async (event, currentRoster, cycleOptions) => {
				completedBy.push(event.agentId);
				return await originalComplete(event, currentRoster, cycleOptions);
			};
			const created = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				agentId: name,
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "async.enabled": false, "advisor.enabled": false }),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: process.cwd(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				replenishmentEngine: engine,
			});
			sessions.push(created.session);
			return {
				hook: completionHook(created.session),
				start: startHook(created.session)!,
				startFailed: startFailureHook(created.session)!,
				session: created.session,
				engine,
			};
		};

		const firstCompletions: string[] = [];
		const secondCompletions: string[] = [];
		const first = await create("top-level-a", firstCompletions);
		const second = await create("top-level-b", secondCompletions);
		const verifier = { agentId: "verifier-a", agentName: "qa-verifier" };
		first.start(verifier);
		assert.equal((await first.engine.replenish([])).status, "verification_blocked");
		first.startFailed(verifier);
		assert.equal((await first.engine.replenish([])).status, "floor_satisfied");

		first.start(verifier);
		first.start({ agentId: "task-worker", agentName: "task" });
		assert.equal((await first.engine.replenish([])).status, "verification_blocked");
		await first.hook({ ...verifier, task: "A", status: "completed" });
		assert.equal((await first.engine.replenish([])).status, "floor_satisfied");
		await second.hook({ agentId: "worker-b", agentName: "task", task: "B", status: "completed" });
		assert.deepEqual(firstCompletions, ["verifier-a"]);
		assert.deepEqual(secondCompletions, ["worker-b"]);
		const deniedAgentDir = path.join(root, "denied-task-session");
		fs.mkdirSync(deniedAgentDir, { recursive: true });
		const deniedAuth = await AuthStorage.create(path.join(deniedAgentDir, "auth.db"));
		authStores.push(deniedAuth);
		deniedAuth.keys.setRuntimeApiKey("openai", "test-key");
		const deniedRegistry = new ModelRegistry(deniedAuth);
		const deniedManager = SessionManager.create(process.cwd(), path.join(deniedAgentDir, "sessions"));
		sessionManagers.push(deniedManager);
		let productionExecutor: ((ticket: ClaimedTicket) => Promise<unknown>) | undefined;
		const originalRecovery = TopicReplenishmentEngine.prototype.onSessionRecovery;
		TopicReplenishmentEngine.prototype.onSessionRecovery = async function () {
			productionExecutor = this.executor;
			return { status: "no_eligible_work" } as never;
		};
		try {
			const denied = await createAgentSession({
				cwd: process.cwd(),
				agentDir: deniedAgentDir,
				agentId: "denied-task-session",
				sessionManager: deniedManager,
				authStorage: deniedAuth,
				modelRegistry: deniedRegistry,
				settings: Settings.isolated({
					"async.enabled": false,
					"advisor.enabled": false,
					"tools.approval": { task: "deny" },
				}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: process.cwd(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			sessions.push(denied.session);
		} finally {
			TopicReplenishmentEngine.prototype.onSessionRecovery = originalRecovery;
		}
		assert.ok(productionExecutor, "createAgentSession must bind the native TaskTool executor");
		await assert.rejects(
			productionExecutor({
				id: "denied-ticket",
				topic: "Workflow",
				prompt: "must not spawn",
				task: "must not spawn",
				state: "implementation",
				previousState: "pending",
				owner: "native-dispatch",
				role: "task",
				criteria: [],
				dependencies: [],
				authorization: "{}",
				claimedAt: new Date().toISOString(),
				runId: "denied-run",
			}),
			/blocked by user policy/,
		);
		await first.hook({ agentId: "worker-a", agentName: "task", task: "A", status: "completed" });
		assert.deepEqual(firstCompletions, ["verifier-a", "worker-a"]);
		assert.deepEqual(secondCompletions, ["worker-b"]);
	} finally {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const manager of sessionManagers.splice(0)) await manager.close();
		for (const auth of authStores.splice(0)) auth.close();
	}
}

const childRoot = process.env.VEYYON_REPLENISHMENT_BOUNDARY_CHILD;
if (childRoot) {
	runChild(childRoot).catch(error => {
		console.error(error);
		process.exit(1);
	});
} else {
	test("createAgentSession routes actual verifier spawn and completion events to its injected engine", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-session-replenishment-"));
		try {
			const output = execFileSync(process.execPath, [import.meta.path], {
				cwd: process.cwd(),
				env: { ...process.env, VEYYON_REPLENISHMENT_BOUNDARY_CHILD: root },
				encoding: "utf8",
			});
			expect(output.trim()).toBe("");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
