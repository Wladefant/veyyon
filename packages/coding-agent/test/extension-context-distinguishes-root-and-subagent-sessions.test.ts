/**
 * WHY: Extensions such as background channel bridges (e.g. Telegram) must be able to prove
 * whether they are attached to the root interactive session or to a delegated task subagent.
 * Relying solely on `hasUI: false` is fragile if a child session inherits UI or runs in custom harnesses.
 * This suite proves that `ExtensionContext` exposes stable runtime identity (`isSubagent`, `taskDepth`,
 * `agentId`, `parentTaskPrefix`) across real root, subagent, and headless sessions, and that root
 * approval cards remain unattributed while child approval cards are attributed to the child.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionRuntime,
	ExtensionUIContext,
} from "@veyyon/coding-agent/extensibility/extensions";
import { ExtensionRunner, ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

interface ObservedContextState {
	isSubagent?: boolean;
	taskDepth?: number;
	agentId?: string;
	parentTaskPrefix?: string;
	hasUI: boolean;
	isRootEligible: boolean;
}

describe("ExtensionContext distinguishes root and subagent sessions", () => {
	const tempDirs: string[] = [];
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function createProjectWithExtension(): {
		cwd: string;
		agentDir: string;
		extensionPath: string;
		getObservations: () => ObservedContextState[];
	} {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-ext-identity-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });

		const observationsFile = path.join(tempDir, "observations.jsonl");
		const extensionPath = path.join(cwd, "identity-probe-extension.ts");

		const extensionSource = `
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent";

function evaluateRootEligibility(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	if (ctx.isSubagent) return false;
	if ((ctx.taskDepth ?? 0) > 0) return false;
	if (Boolean(ctx.parentTaskPrefix)) return false;
	return true;
}

export default function probeExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const record = {
			isSubagent: ctx.isSubagent,
			taskDepth: ctx.taskDepth,
			agentId: ctx.agentId,
			parentTaskPrefix: ctx.parentTaskPrefix,
			hasUI: ctx.hasUI,
			isRootEligible: evaluateRootEligibility(ctx),
		};
		fs.appendFileSync(${JSON.stringify(observationsFile)}, JSON.stringify(record) + "\\n", "utf8");
	});
}
`;
		fs.writeFileSync(extensionPath, extensionSource, "utf8");

		const getObservations = (): ObservedContextState[] => {
			if (!fs.existsSync(observationsFile)) return [];
			return fs
				.readFileSync(observationsFile, "utf8")
				.trim()
				.split("\n")
				.filter(line => line.length > 0)
				.map(line => JSON.parse(line) as ObservedContextState);
		};

		return {
			cwd,
			agentDir: path.join(tempDir, "agent"),
			extensionPath,
			getObservations,
		};
	}

	it("populates root identity for interactive root session (agentId undefined) and permits root-only gating", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: true,
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const rootObs = observations[0];
		expect(rootObs.isSubagent).toBe(false);
		expect(rootObs.taskDepth).toBe(0);
		expect(rootObs.agentId).toBeUndefined();
		expect(rootObs.parentTaskPrefix).toBeUndefined();
		expect(rootObs.hasUI).toBe(true);
		expect(rootObs.isRootEligible).toBe(true);
	});

	it("populates subagent identity for task child and refuses root-only gating", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			taskDepth: 1,
			parentTaskPrefix: "task_1",
			agentId: "task_1",
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const subObs = observations[0];
		expect(subObs.isSubagent).toBe(true);
		expect(subObs.taskDepth).toBe(1);
		expect(subObs.agentId).toBe("task_1");
		expect(subObs.parentTaskPrefix).toBe("task_1");
		expect(subObs.hasUI).toBe(false);
		expect(subObs.isRootEligible).toBe(false);
	});

	it("subagent with depth-only (no parentTaskPrefix) is still detected as subagent", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			taskDepth: 1,
			agentId: "depth_only_agent",
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const subObs = observations[0];
		expect(subObs.isSubagent).toBe(true);
		expect(subObs.taskDepth).toBe(1);
		expect(subObs.agentId).toBe("depth_only_agent");
		expect(subObs.parentTaskPrefix).toBeUndefined();
		expect(subObs.isRootEligible).toBe(false);
	});

	it("subagent with prefix-only (taskDepth unset) is still detected as subagent", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			parentTaskPrefix: "prefix_only_task",
			agentId: "prefix_only_task",
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const subObs = observations[0];
		expect(subObs.isSubagent).toBe(true);
		expect(subObs.taskDepth).toBe(0);
		expect(subObs.agentId).toBe("prefix_only_task");
		expect(subObs.parentTaskPrefix).toBe("prefix_only_task");
		expect(subObs.isRootEligible).toBe(false);
	});

	it("subagent with inherited hasUI=true is still detected as subagent and refused by root-only gate", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: true,
			taskDepth: 1,
			parentTaskPrefix: "hostile_child",
			agentId: "hostile_child",
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const subObs = observations[0];
		expect(subObs.hasUI).toBe(true);
		expect(subObs.isSubagent).toBe(true);
		expect(subObs.taskDepth).toBe(1);
		expect(subObs.agentId).toBe("hostile_child");
		expect(subObs.parentTaskPrefix).toBe("hostile_child");
		expect(subObs.isRootEligible).toBe(false);
	});

	it("headless root session reports isSubagent=false and taskDepth=0 while hasUI=false (agentId undefined)", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const headlessObs = observations[0];
		expect(headlessObs.isSubagent).toBe(false);
		expect(headlessObs.taskDepth).toBe(0);
		expect(headlessObs.agentId).toBeUndefined();
		expect(headlessObs.hasUI).toBe(false);
		expect(headlessObs.isRootEligible).toBe(false);
	});

	it("deeply nested subagent reports taskDepth=2 and isSubagent=true", async () => {
		const fixture = createProjectWithExtension();

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			taskDepth: 2,
			parentTaskPrefix: "nested_child_2",
			agentId: "nested_child_2",
			enableMCP: false,
			enableLsp: false,
		});

		const runner = session.extensionRunner;
		expect(runner).toBeDefined();
		if (runner) {
			await runner.emit({ type: "session_start" });
		}

		const observations = fixture.getObservations();
		expect(observations.length).toBe(1);
		const nestedObs = observations[0];
		expect(nestedObs.isSubagent).toBe(true);
		expect(nestedObs.taskDepth).toBe(2);
		expect(nestedObs.agentId).toBe("nested_child_2");
		expect(nestedObs.parentTaskPrefix).toBe("nested_child_2");
		expect(nestedObs.isRootEligible).toBe(false);
	});

	it("contradictory isSubagent:false cannot override structural child evidence in ExtensionRunner", () => {
		const depthRunner = new ExtensionRunner(
			[],
			{} as unknown as ExtensionRuntime,
			"/tmp",
			SessionManager.inMemory("/tmp"),
			sharedModelRegistry,
			undefined,
			undefined,
			undefined,
			{ isSubagent: false, taskDepth: 1, agentId: "depth_child" },
		);
		expect(depthRunner.isSubagent).toBe(true);
		expect(depthRunner.taskDepth).toBe(1);
		expect(depthRunner.agentId).toBe("depth_child");

		const prefixRunner = new ExtensionRunner(
			[],
			{} as unknown as ExtensionRuntime,
			"/tmp",
			SessionManager.inMemory("/tmp"),
			sharedModelRegistry,
			undefined,
			undefined,
			undefined,
			{ isSubagent: false, parentTaskPrefix: "task_prefix", agentId: "prefix_child" },
		);
		expect(prefixRunner.isSubagent).toBe(true);
		expect(prefixRunner.parentTaskPrefix).toBe("task_prefix");
		expect(prefixRunner.agentId).toBe("prefix_child");
	});

	it("exposes consistent identity in command context and tool execution context", async () => {
		const fixture = createProjectWithExtension();

		const { session: rootSession } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: true,
			enableMCP: false,
			enableLsp: false,
		});

		const rootRunner = rootSession.extensionRunner;
		expect(rootRunner).toBeDefined();
		if (rootRunner) {
			const cmdCtx = rootRunner.createCommandContext();
			expect(cmdCtx.isSubagent).toBe(false);
			expect(cmdCtx.taskDepth).toBe(0);
			expect(cmdCtx.agentId).toBeUndefined();

			const toolCtx = rootRunner.createContext();
			expect(toolCtx.isSubagent).toBe(false);
			expect(toolCtx.taskDepth).toBe(0);
			expect(toolCtx.agentId).toBeUndefined();
		}

		const { session: subSession } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: false,
			taskDepth: 1,
			agentId: "SubWorker",
			parentTaskPrefix: "SubWorker",
			enableMCP: false,
			enableLsp: false,
		});

		const subRunner = subSession.extensionRunner;
		expect(subRunner).toBeDefined();
		if (subRunner) {
			const subCmdCtx = subRunner.createCommandContext();
			expect(subCmdCtx.isSubagent).toBe(true);
			expect(subCmdCtx.taskDepth).toBe(1);
			expect(subCmdCtx.agentId).toBe("SubWorker");

			const subToolCtx = subRunner.createContext();
			expect(subToolCtx.isSubagent).toBe(true);
			expect(subToolCtx.taskDepth).toBe(1);
			expect(subToolCtx.agentId).toBe("SubWorker");
		}
	});

	it("createAgentSession regression: leaves root approval card unattributed and attributes child approval card", async () => {
		const fixture = createProjectWithExtension();

		const rootCards: Array<{ title?: string; body: string }> = [];
		const mockRootUI = {
			select: async (title: string) => {
				rootCards.push({ body: title });
				return "allow-session";
			},
		} as unknown as ExtensionUIContext;

		const dummyTool = {
			name: "bash",
			description: "Run bash command",
			parameters: { type: "object", properties: { command: { type: "string" } } },
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		} as unknown as AgentTool;

		// 1. Root session created via createAgentSession
		const { session: rootSession } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: true,
			enableMCP: false,
			enableLsp: false,
		});

		const rootRunner = rootSession.extensionRunner;
		expect(rootRunner).toBeDefined();
		if (rootRunner) {
			rootRunner.initialize({} as ExtensionActions, {} as ExtensionContextActions, undefined, mockRootUI);

			const wrappedRootTool = new ExtensionToolWrapper(dummyTool, rootRunner);
			const rootToolCtx = {
				settings: Settings.isolated({ "tools.approvalMode": "ask" }),
				sessionManager: { getCwd: () => fixture.cwd, getSessionId: () => "root-session-id" },
			} as unknown as AgentToolContext;
			await wrappedRootTool.execute("call-root-1", { command: "ls" }, undefined, undefined, rootToolCtx);

			expect(rootCards.length).toBe(1);
			expect(rootCards[0].body).not.toContain("Requested by");
		}

		// 2. Child subagent session created via createAgentSession
		const childCards: Array<{ title?: string; body: string }> = [];
		const mockChildUI = {
			select: async (title: string) => {
				childCards.push({ body: title });
				return "allow-session";
			},
		} as unknown as ExtensionUIContext;

		const { session: childSession } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
			sessionManager: SessionManager.inMemory(fixture.cwd),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [fixture.extensionPath],
			hasUI: true,
			taskDepth: 1,
			agentId: "ChildTaskWorker",
			parentTaskPrefix: "ChildTaskWorker",
			enableMCP: false,
			enableLsp: false,
		});

		const childRunner = childSession.extensionRunner;
		expect(childRunner).toBeDefined();
		if (childRunner) {
			childRunner.initialize({} as ExtensionActions, {} as ExtensionContextActions, undefined, mockChildUI);

			const wrappedChildTool = new ExtensionToolWrapper(dummyTool, childRunner);
			const childToolCtx = {
				settings: Settings.isolated({ "tools.approvalMode": "ask" }),
				sessionManager: { getCwd: () => fixture.cwd, getSessionId: () => "child-session-id" },
			} as unknown as AgentToolContext;
			await wrappedChildTool.execute("call-child-1", { command: "ls" }, undefined, undefined, childToolCtx);

			expect(childCards.length).toBe(1);
			expect(childCards[0].body).toContain("**Requested by:** `ChildTaskWorker`");
		}
	});
});
