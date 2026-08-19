/**
 * WHY: Extensions such as background channel bridges (e.g. Telegram) must be able to prove
 * whether they are attached to the root interactive session or to a delegated task subagent.
 * Relying solely on `hasUI: false` is fragile if a child session inherits UI or runs in custom harnesses.
 * This suite proves that `ExtensionContext` exposes stable runtime identity (`isSubagent`, `taskDepth`,
 * `agentId`, `parentTaskPrefix`) across real root, subagent, and headless sessions.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

interface ObservedContextState {
	isSubagent: boolean;
	taskDepth: number;
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
	if (ctx.taskDepth > 0) return false;
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

	it("populates root identity for interactive root session and permits root-only gating", async () => {
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
		expect(rootObs.agentId).toBe("Main");
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

	it("headless root session reports isSubagent=false and taskDepth=0 while hasUI=false", async () => {
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
		expect(headlessObs.agentId).toBe("Main");
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
});
