/**
 * An idle session draws a still todo board and stops requesting frames.
 *
 * WHY THIS SUITE EXISTS.
 * The anchored Todos HUD above the composer used to animate whenever a task was
 * marked in progress — including while the session sat idle waiting for the
 * operator to type, because a task mark persists across the turn boundary. The
 * loudest region above the composer said the agent was working while it was
 * actually waiting for input.
 *
 * The fix gated board motion on whether the agent is actually in motion
 * (`session.isStreaming || session.isCompacting || session.hasPostPromptWork`).
 * Pure predicate unit tests assert the helper function in isolation, but they
 * cannot see the full end-to-end consequence through the real interactive mode,
 * event controller, anchored timer sync, and terminal viewport paint.
 *
 * THE CLASS THIS CLOSES.
 * "An idle session running an unending animation loop or drawing in-flight
 * breathing/rail motion across turn boundaries."
 *
 * WHAT IT DOES NOT CATCH.
 * Agent HUD lane motion (owned by `test/modes/terminal/components/agents-surface.test.ts`),
 * the completion strike envelope countdown (owned by `test/modes/terminal/a-stopped-mode-draws-no-more-frames.test.ts`),
 * and static glyph monochrome assertions (owned by `test/modes/terminal/components/dashboard/todo-hud-states.test.ts`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { TODO_BOARD_FRAME_DIVISOR } from "@veyyon/coding-agent/modes/terminal/components/dashboard/todo-board";
import { RAIL_IDLE_STEP_MS } from "@veyyon/coding-agent/modes/terminal/draw/rail-motion";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, stopThemeWatcher, theme } from "@veyyon/coding-agent/theme/theme";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../../../../../hosts/terminal/engine/test/virtual-terminal";
import { createTestAgentSession } from "../../../../helpers/test-agent-session";

/**
 * Whether the anchored board drew a phase row for `Phase One` carrying `tally`.
 * The board's rows open on its rail and right-align the tally.
 */
function hudPhaseRow(screen: string, tally: string): boolean {
	const rail = theme.symbol("block.rail");
	return screen
		.split("\n")
		.some(
			row => row.trimStart().startsWith(`${rail} `) && row.includes("Phase One") && row.trimEnd().endsWith(tally),
		);
}

function todoResult(statuses: Array<[string, string]>) {
	return {
		content: [{ type: "text", text: "board" }],
		details: {
			op: "done",
			storage: "memory",
			phases: [{ name: "Phase One", tasks: statuses.map(([content, status]) => ({ content, status })) }],
		},
	} as never;
}

function assistant(content: unknown[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
		timestamp: Date.now(),
	};
}

describe("an idle session draws a still todo board", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-idle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "display.transitions": "on" } });
		({ authStorage, session } = await createTestAgentSession(tempDir.path(), {
			settings: { "startup.quiet": true, "display.transitions": "on" },
		}));
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(100, 24);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender(mode.ui);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
		stopThemeWatcher();
	});

	it("draws a still board while the session is idle waiting for user input", async () => {
		const controller = mode.eventController;
		const todoCall = (id: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id, name: "todo", arguments: args }]);

		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_update",
			message: todoCall("t1", { op: "start", task: "first task" }),
			assistantMessageEvent: { type: "text_delta", delta: "" },
		} as never);
		await controller.handleEvent({
			type: "message_end",
			message: todoCall("t1", { op: "start", task: "first task" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "todo",
			args: { op: "start", task: "first task" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: todoResult([
				["first task", "in_progress"],
				["second task", "pending"],
			]),
			isError: false,
		} as never);

		// End the turn: the session enters idle state waiting for user input.
		await controller.handleEvent({ type: "agent_end" } as never);
		await terminal.waitForRender(mode.ui);

		const first = terminal.getViewport().join("\n");
		const stripped = Bun.stripANSI(first);
		expect(hudPhaseRow(stripped, "0/2")).toBe(true);
		expect(stripped).toContain("first task");
		expect(stripped).toContain("second task");

		// Wait past one full board frame of wall clock (TODO_BOARD_FRAME_DIVISOR (4) * RAIL_IDLE_STEP_MS (60ms) = 240ms + 40ms slack = 280ms).
		// If the board were animating while idle, its task marker would advance
		// from frame 0 ("·") to frame 1 (":"), causing viewport byte divergence.
		const waitMs = TODO_BOARD_FRAME_DIVISOR * RAIL_IDLE_STEP_MS + 40;
		await Bun.sleep(waitMs);
		await terminal.waitForRender(mode.ui);

		const second = terminal.getViewport().join("\n");
		expect(second).toBe(first);
	});

	it("draws the board with phase and task rows on screen while the turn is running", async () => {
		const controller = mode.eventController;
		const todoCall = (id: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id, name: "todo", arguments: args }]);

		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_update",
			message: todoCall("t1", { op: "start", task: "first task" }),
			assistantMessageEvent: { type: "text_delta", delta: "" },
		} as never);
		await controller.handleEvent({
			type: "message_end",
			message: todoCall("t1", { op: "start", task: "first task" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "todo",
			args: { op: "start", task: "first task" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: todoResult([
				["first task", "in_progress"],
				["second task", "pending"],
			]),
			isError: false,
		} as never);

		// Turn is still RUNNING: no agent_end sent.
		await terminal.waitForRender(mode.ui);

		const screen = Bun.stripANSI(terminal.getViewport().join("\n"));
		// Assert the board is REACHED and drawn (phase row and task rows are on screen),
		// without asserting a specific animated spinner frame so the test cannot flake.
		expect(hudPhaseRow(screen, "0/2")).toBe(true);
		expect(screen).toContain("first task");
		expect(screen).toContain("second task");
	});

	it("stops asking the host for frames once the session is idle", async () => {
		const controller = mode.eventController;
		const renderSpy = vi.spyOn(mode.ui, "requestRender");
		const todoCall = (id: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id, name: "todo", arguments: args }]);

		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_update",
			message: todoCall("t1", { op: "start", task: "first task" }),
			assistantMessageEvent: { type: "text_delta", delta: "" },
		} as never);
		await controller.handleEvent({
			type: "message_end",
			message: todoCall("t1", { op: "start", task: "first task" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "todo",
			args: { op: "start", task: "first task" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: todoResult([
				["first task", "in_progress"],
				["second task", "pending"],
			]),
			isError: false,
		} as never);

		// End the turn: mode should disarm anchored motion timer and settle.
		await controller.handleEvent({ type: "agent_end" } as never);
		await terminal.waitForRender(mode.ui);

		// Snapshot the render count once the turn is settled and idle.
		renderSpy.mockClear();

		// Wait past several clock steps (e.g. 4 idle steps = 240ms).
		// If the anchored clock were running, it would invoke ui.requestRender() on every step (60ms).
		const idleWaitMs = TODO_BOARD_FRAME_DIVISOR * RAIL_IDLE_STEP_MS + 20;
		await Bun.sleep(idleWaitMs);

		// The mode must not have requested any further frames while sitting idle.
		expect(renderSpy.mock.calls.length).toBe(0);
	});
});
