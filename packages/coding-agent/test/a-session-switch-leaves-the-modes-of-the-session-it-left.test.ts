/**
 * Subject: `modes/terminal/controllers/plan-mode-controller.ts` and
 * `modes/terminal/controllers/vibe-mode-controller.ts`, driven through `AgentSession.switchSession`
 * and the switch reconciler `InteractiveMode.init` registers.
 *
 * Contract: a session switch ends every mode the session it left was in and restores the mode the
 * target session recorded, nothing more.
 *
 * 1. Plan mode, active or paused, ends: the pre-plan active toolset comes back, the session's plan
 *    state and the plan file are cleared, and the next `/plan` is a first entry, not a re-entry.
 * 2. A target that recorded `plan_paused` restores the paused state: `/plan` with a prompt resumes
 *    the plan as a re-entry, and a bare `/plan` turns it off.
 * 3. Vibe mode ends: the vibe tools leave the registry and the pre-vibe active toolset comes back.
 *
 * THE CLASS IT CLOSES. The clear runs once per mode controller from one choke point
 * (`#clearTransientModeState`), and each controller clears its own fields. Dropping a controller
 * from the choke point, a field from a controller's clear, or the paused branch of the plan guard
 * leaves the previous session's mode painted over the next session and its tools still active.
 *
 * NOT CAUGHT: the goal-mode leg of the same choke point, which `goals/goal-mode-integration.test.ts`
 * covers, and a switch cancelled by a `session_before_switch` hook, which never reaches the
 * reconciler.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { VIBE_TOOL_NAMES } from "@veyyon/coding-agent/tools/agent/vibe";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("a session switch leaves the modes of the session it left", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-switch-modes-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "the session the switch leaves", timestamp: 1 });
		sessionManager.appendMessage(createAssistantMessage("a reply, so the file is written"));
		await sessionManager.flush();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
			toolRegistry: new Map(["read", "resolve"].map(name => [name, stubTool(name)])),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		await session.setActiveToolsByName(["read"]);

		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
		const terminal = new VirtualTerminal(100, 30);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender(mode.ui);
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
		stopThemeWatcher();
	});

	/**
	 * Writes a second session file, recording `recordedMode` when given, and returns its path. The
	 * assistant reply is what makes the session manager write the file at all.
	 */
	async function targetSession(recordedMode?: "plan_paused"): Promise<string> {
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendMessage({ role: "user", content: "the session the switch reaches", timestamp: 2 });
		target.appendMessage(createAssistantMessage("a reply, so the file is written"));
		if (recordedMode) target.appendModeChange(recordedMode);
		await target.flush();
		const file = target.getSessionFile();
		await target.close();
		if (!file || !existsSync(file)) throw new Error("target session wrote no file");
		return file;
	}

	it("ends an active plan and restores the toolset the plan replaced", async () => {
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getActiveToolNames().toSorted()).toEqual(["read", "resolve"]);

		expect(await session.switchSession(await targetSession())).toBe(true);

		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(false);
		expect(mode.planModePlanFilePath).toBeUndefined();
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.reentry).toBe(false);
	});

	it("ends a paused plan, so the next /plan is a first entry", async () => {
		await mode.handlePlanModeCommand();
		await mode.handlePlanModeCommand();
		expect(mode.planModePaused).toBe(true);

		expect(await session.switchSession(await targetSession())).toBe(true);

		expect(mode.planModePaused).toBe(false);
		expect(mode.planModeEnabled).toBe(false);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getPlanModeState()?.reentry).toBe(false);
	});

	it("restores the paused plan the target recorded, so /plan with a prompt resumes it", async () => {
		expect(await session.switchSession(await targetSession("plan_paused"))).toBe(true);

		expect(mode.planModePaused).toBe(true);
		expect(mode.planModeEnabled).toBe(false);
		await mode.handlePlanModeCommand("continue the plan");
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getPlanModeState()?.reentry).toBe(true);
	});

	it("restores the paused plan the target recorded, so a bare /plan turns it off", async () => {
		expect(await session.switchSession(await targetSession("plan_paused"))).toBe(true);

		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.planModePaused).toBe(false);
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("ends vibe mode and takes its tools out of the registry", async () => {
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "resolve", ...VIBE_TOOL_NAMES].toSorted());

		expect(await session.switchSession(await targetSession())).toBe(true);

		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "resolve"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});
});
