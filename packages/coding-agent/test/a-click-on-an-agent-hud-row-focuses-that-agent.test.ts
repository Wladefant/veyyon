/**
 * WHY THIS SUITE EXISTS.
 *
 * The anchored Agents block named every running agent and none of them could be
 * reached from it: getting into an agent took `/agents`, a pick and Enter. A
 * click on an agent's row now focuses that agent (oh-my-pi 42cab80d, in its
 * mouse-only form aef2ec9a).
 *
 * The class it closes is the row-to-agent mapping on the real mode: the block is
 * a blank line, a header, agent rows and an overflow count, and a map that is off
 * by one focuses the NEIGHBOUR of the agent under the pointer, which reads as the
 * click working. So the sweep clicks every drawn line and requires each agent row
 * to name its own agent and every other line to name none.
 *
 * What it does NOT catch: whether the engine delivers the click (pinned in
 * hosts/terminal/engine/test/a-click-above-the-footer-reaches-only-a-child-that-asked.test.ts)
 * or what focusing does (session-focus-controller's own suites). Focusing is
 * stubbed at `focusAgentSession`, the mode's public seam, because a real focus
 * needs a live agent lifecycle this suite has no reason to run.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AGENT_HUD_VISIBLE_LIMIT } from "@veyyon/coding-agent/modes/terminal/components/dashboard/agent-hud";
import {
	InteractiveMode,
	SUBAGENT_OBSERVER_UI_COALESCE_MS,
} from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type AgentProgressPayload, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@veyyon/coding-agent/task";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { Component } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { type MouseRoutable, parseSgrMouse, type SgrMouseEvent } from "@veyyon/utils/mouse";

const WIDTH = 120;

function progressPayload(id: string, index: number): AgentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: `job ${index}`,
		parentToolCallId: "tool-call",
		detached: true,
		progress: {
			id,
			index,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: `job ${index}`,
			description: `job ${index}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		},
	};
}

function sgr(data: string): SgrMouseEvent {
	const event = parseSgrMouse(data);
	if (!event) throw new Error(`not an SGR report: ${JSON.stringify(data)}`);
	return event;
}

const LEFT_PRESS = sgr("\x1b[<0;5;1M");
const LEFT_RELEASE = sgr("\x1b[<0;5;1m");

describe("a click on an agent HUD row focuses that agent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-agent-hud-click-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
		await mode.init();
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/** Spawn `count` detached agents and let the coalesced HUD rebuild land. */
	async function spawn(count: number): Promise<string[]> {
		vi.useFakeTimers();
		const ids = Array.from({ length: count }, (_, i) => `HudAgent${i}`);
		ids.forEach((id, i) => {
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, i));
		});
		await Promise.resolve();
		vi.advanceTimersByTime(SUBAGENT_OBSERVER_UI_COALESCE_MS);
		await Promise.resolve();
		vi.useRealTimers();
		return ids;
	}

	/** The block's drawn lines, stripped. */
	function drawn(): string[] {
		return Bun.stripANSI(mode.agentContainer.render(WIDTH).join("\n")).split("\n");
	}

	it("focuses exactly the agent on the clicked row, and nothing from any other line", async () => {
		// One past the cap, so the overflow count row is drawn and swept too.
		const ids = await spawn(AGENT_HUD_VISIBLE_LIMIT + 1);
		const focus = vi.spyOn(mode, "focusAgentSession").mockResolvedValue();
		const lines = drawn();
		expect(lines.some(line => line.includes("more running"))).toBe(true);

		const focusedByLine = lines.map((_, line) => {
			focus.mockClear();
			mode.agentContainer.routeMouse(LEFT_PRESS, line, 4);
			return focus.mock.calls.map(call => call[0]);
		});

		const expected = lines.map(line => {
			const id = ids.find(candidate => line.includes(candidate));
			return id === undefined ? [] : [id];
		});
		expect(focusedByLine).toEqual(expected);
		// Every listed agent is reachable; the one past the cap is not drawn.
		expect(focusedByLine.flat()).toEqual(ids.slice(0, AGENT_HUD_VISIBLE_LIMIT));
	});

	it("acts on the press only, so a release on the same row does not focus twice", async () => {
		const [id] = await spawn(1);
		const focus = vi.spyOn(mode, "focusAgentSession").mockResolvedValue();
		const line = drawn().findIndex(row => row.includes(id!));
		mode.agentContainer.routeMouse(LEFT_PRESS, line, 4);
		mode.agentContainer.routeMouse(LEFT_RELEASE, line, 4);
		expect(focus.mock.calls).toEqual([[id]]);
	});

	it("declares click targets only while an agent row is drawn", async () => {
		const container: Component & Partial<MouseRoutable> = mode.agentContainer;
		const pointer = () => container.wantsPointer?.() === true;
		expect(pointer()).toBe(false);
		await spawn(1);
		expect(pointer()).toBe(true);
	});

	it("reports a refused focus instead of dropping it", async () => {
		const [id] = await spawn(1);
		vi.spyOn(mode, "focusAgentSession").mockRejectedValue(new Error(`Agent "${id}" was terminated`));
		const shown = vi.spyOn(mode, "showError").mockImplementation(() => {});
		mode.agentContainer.routeMouse(
			LEFT_PRESS,
			drawn().findIndex(row => row.includes(id!)),
			4,
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(shown).toHaveBeenCalledWith(`Agent "${id}" was terminated`);
	});

	it("keeps one drawn row per mapped line after the terminal narrows", async () => {
		const ids = await spawn(3);
		const focus = vi.spyOn(mode, "focusAgentSession").mockResolvedValue();
		const wide = drawn();
		// A width far narrower than the rows the block was built for.
		const narrow = Bun.stripANSI(mode.agentContainer.render(24).join("\n")).split("\n");
		expect(narrow).toHaveLength(wide.length);

		const focusedByLine = narrow.map((_, line) => {
			focus.mockClear();
			mode.agentContainer.routeMouse(LEFT_PRESS, line, 4);
			return focus.mock.calls.map(call => call[0]);
		});
		const expected = wide.map(line => {
			const id = ids.find(candidate => line.includes(candidate));
			return id === undefined ? [] : [id];
		});
		expect(focusedByLine).toEqual(expected);
	});

	it("ignores the right and middle buttons", async () => {
		const [id] = await spawn(1);
		const focus = vi.spyOn(mode, "focusAgentSession").mockResolvedValue();
		const line = drawn().findIndex(row => row.includes(id!));
		mode.agentContainer.routeMouse(sgr("\x1b[<2;5;1M"), line, 4);
		mode.agentContainer.routeMouse(sgr("\x1b[<1;5;1M"), line, 4);
		expect(focus).not.toHaveBeenCalled();
	});
});
