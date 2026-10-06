/**
 * WHY:
 *
 * THE DEFECT:
 * The terminal "Agents" HUD block (renderAgentHudLines in modes/terminal/components/dashboard/agent-hud.ts)
 * lists observer sessions with status 'active' and `detached === true`. The observer
 * (SessionObserverRegistry) is fed only by the executor's TASK_SUBAGENT_LIFECYCLE and
 * TASK_SUBAGENT_PROGRESS EventBus channels. When an IRC message arrives for an idle or parked
 * agent (task/irc-bus.ts #send -> ensureLive -> session.deliverIrcMessage), the woken turn
 * reports only to AgentRegistry (through syncStatusWithTurns: agent_start idle -> running).
 * As a result, the status badge (which reads AgentRegistry) counted the agent as running while
 * the Agents block had no row for it (left 'completed' from its first run).
 *
 * THE CLASS:
 * Subagent status transitions occurring outside the primary executor event-bus lifecycle stream
 * (such as IRC wakes, out-of-band resumptions, and registry status changes) desynchronizing
 * from the terminal observer registry and the anchored HUD block.
 *
 * A wake carries no outcome of its own: settling a woken row must restore what the bus reported
 * (or `aborted` when the registry aborts it), never manufacture `completed`, which auto-closed a
 * todo matching a failed run. And a row the bus still reports as active is the bus's run: a turn
 * boundary inside it neither lists a sync spawn in the block nor settles it.
 *
 * THE GAP:
 * This test calls `AgentRegistry.global().setStatus` and `openApprovalWait` rather than
 * running a full live multi-turn IRC message delivery turn through the LLM client. The
 * unsuccessful outcomes are listed by hand (`failed`, `aborted`), since a type union cannot be
 * swept at run time; the registry statuses are swept from `AGENT_STATUSES`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/terminal/session-observer-registry";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AGENT_STATUSES, AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type AgentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@veyyon/coding-agent/task";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";

/**
 * Whether the lane block drew a lane for `id` carrying `description`.
 */
function laneRow(hud: string, id: string, description: string): boolean {
	return hud
		.split("\n")
		.some(row => row.trimStart().startsWith("▏ ") && row.includes(id) && row.includes(description));
}

function makeLifecycle(
	id: string,
	index: number,
	description: string,
	status: AgentLifecyclePayload["status"] = "started",
	detached = true,
): AgentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status,
		parentToolCallId: `call-${id}`,
		detached,
	};
}

describe("an agent woken by IRC is listed in the Agents block while it runs", () => {
	let tempDir: TempDir | undefined;
	let childTempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let mainSession: AgentSession | undefined;
	let childSession: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let terminal: VirtualTerminal | undefined;
	let eventBus: EventBus | undefined;

	beforeAll(async () => {
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-hud-irc-");
		childTempDir = TempDir.createSync("@pi-hud-irc-child-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		mainSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		childSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Child"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(childTempDir.path(), childTempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});

		eventBus = new EventBus();
		mode = new InteractiveMode(mainSession, "test", undefined, undefined, undefined, eventBus);
		terminal = new VirtualTerminal(110, 30);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await mainSession?.dispose();
		await childSession?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		childTempDir?.removeSync();
		mode = undefined;
		mainSession = undefined;
		childSession = undefined;
		terminal = undefined;
		eventBus = undefined;
		vi.restoreAllMocks();
		vi.useRealTimers();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		stopThemeWatcher();
	});

	/** The HUD block's painted bytes: the exact lines the anchored container hands the frame. */
	function hudText(): string {
		if (!mode) throw new Error("mode not booted");
		return Bun.stripANSI(mode.agentContainer.render(110).join("\n"));
	}

	async function flushUi(action?: () => void): Promise<void> {
		vi.useFakeTimers();
		action?.();
		vi.advanceTimersByTime(150);
		vi.useRealTimers();
		mode?.ui.requestRender();
		await terminal?.waitForRender();
	}

	const cases: Array<{ detached: boolean; wakePath: "idle" | "parked" }> = [
		{ detached: true, wakePath: "idle" },
		{ detached: true, wakePath: "parked" },
		{ detached: false, wakePath: "idle" },
		{ detached: false, wakePath: "parked" },
	];

	for (const { detached, wakePath } of cases) {
		it(`lists an agent woken from ${wakePath} (initially detached=${detached}) in the Agents block`, async () => {
			const id = `Agent-${detached ? "det" : "sync"}-${wakePath}`;
			const description = `Testing ${wakePath} wake (detached=${detached})`;

			// 1. Emit lifecycle 'started' with that detached value
			await flushUi(() => {
				eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "started", detached));
			});

			if (!childSession) throw new Error("childSession not booted");
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: childSession,
				status: "running",
			});

			// 2. Emit lifecycle 'completed' and setStatus(id, 'idle') and assert no row
			await flushUi(() => {
				eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "completed", detached));
				AgentRegistry.global().setStatus(id, "idle");
			});

			expect(laneRow(hudText(), id, description)).toBe(false);

			// 3. For the parked path, also setStatus(id, 'parked') and then 'idle'
			if (wakePath === "parked") {
				await flushUi(() => {
					AgentRegistry.global().setStatus(id, "parked");
				});
				await flushUi(() => {
					AgentRegistry.global().setStatus(id, "idle");
				});
				expect(laneRow(hudText(), id, description)).toBe(false);
			}

			// 4. Then setStatus(id, 'running') and assert the row is present with its description (the defect)
			await flushUi(() => {
				AgentRegistry.global().setStatus(id, "running");
			});

			const runningHud = hudText();
			expect(runningHud).toContain("Agents");
			expect(laneRow(runningHud, id, description)).toBe(true);

			// 5. Then setStatus(id, 'idle') and assert the row is gone
			await flushUi(() => {
				AgentRegistry.global().setStatus(id, "idle");
			});

			expect(laneRow(hudText(), id, description)).toBe(false);
		});
	}

	it("does not list a sync spawn when status_changed fires without a status transition (e.g. pending approval)", async () => {
		const id = "SyncSpawnApproval";
		const description = "Sync spawn pending approval";

		// Sync spawn (detached: false) in its first run
		await flushUi(() => {
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "started", false));
		});

		if (!childSession) throw new Error("childSession not booted");
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childSession,
			status: "running",
		});
		await flushUi();

		// Sync spawn should not be in the detached agents HUD
		expect(laneRow(hudText(), id, description)).toBe(false);

		// While still running, receive a pending approval prompt (running -> running status_changed)
		await flushUi(() => {
			AgentRegistry.global().openApprovalWait(id, { toolName: "bash", since: Date.now() });
		});

		// Must NOT appear in the block
		expect(laneRow(hudText(), id, description)).toBe(false);
		expect(hudText()).not.toContain(id);
	});

	it("leaves row absent after lifecycle failed and lists it when revived to running", async () => {
		const id = "FailedAgentRevive";
		const description = "Agent that failed and revived";

		await flushUi(() => {
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "started", true));
		});

		if (!childSession) throw new Error("childSession not booted");
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childSession,
			status: "running",
		});

		// Lifecycle failed followed by idle
		await flushUi(() => {
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "failed", true));
			AgentRegistry.global().setStatus(id, "idle");
		});

		expect(laneRow(hudText(), id, description)).toBe(false);

		// Wake the agent to running
		await flushUi(() => {
			AgentRegistry.global().setStatus(id, "running");
		});

		const runningHud = hudText();
		expect(runningHud).toContain("Agents");
		expect(laneRow(runningHud, id, description)).toBe(true);

		// Settle back to idle
		await flushUi(() => {
			AgentRegistry.global().setStatus(id, "idle");
		});

		expect(laneRow(hudText(), id, description)).toBe(false);
	});

	/** The status of the one todo seeded with `content`, as the board holds it now. */
	function todoStatus(content: string): string | undefined {
		return mode?.todoPhases.flatMap(phase => phase.tasks).find(task => task.content === content)?.status;
	}

	// A wake carries no outcome of its own. For every unsuccessful outcome the bus can report for the
	// first run, and every status the registry can settle the woken turn into, the row goes back to the
	// reported outcome, so a todo matching the spawn stays open exactly as it would had the agent never
	// been woken. Manufacturing `completed` here closes the todo as if the agent had succeeded.
	const unsuccessfulOutcomes: AgentLifecyclePayload["status"][] = ["failed", "aborted"];
	const settledStatuses = AGENT_STATUSES.filter(status => status !== "running");
	for (const outcome of unsuccessfulOutcomes) {
		for (const settled of settledStatuses) {
			it(`keeps a ${outcome} run's todo open when its wake settles to ${settled}`, async () => {
				const id = `Woken-${outcome}-${settled}`;
				const description = `Review the limiter after a ${outcome} run settling ${settled}`;
				mode?.setTodos([{ name: "Tasks", tasks: [{ content: description, status: "pending" }] }]);

				await flushUi(() => {
					eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "started", true));
				});
				if (!childSession) throw new Error("childSession not booted");
				AgentRegistry.global().register({
					id,
					displayName: id,
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					session: childSession,
					status: "running",
				});
				await flushUi(() => {
					eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, outcome, true));
					AgentRegistry.global().setStatus(id, "idle");
				});
				expect(todoStatus(description)).toBe("pending");

				await flushUi(() => {
					AgentRegistry.global().setStatus(id, "running");
				});
				expect(laneRow(hudText(), id, description)).toBe(true);

				await flushUi(() => {
					AgentRegistry.global().setStatus(id, settled);
				});
				expect(laneRow(hudText(), id, description)).toBe(false);
				expect(todoStatus(description)).toBe("pending");
			});
		}
	}

	it("leaves a sync spawn's own run to the bus when its registry status flaps mid-run", async () => {
		const id = "SyncSpawnFlap";
		const description = "Sync spawn between two turns of its first run";
		mode?.setTodos([{ name: "Tasks", tasks: [{ content: description, status: "pending" }] }]);

		await flushUi(() => {
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, description, "started", false));
		});
		if (!childSession) throw new Error("childSession not booted");
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: childSession,
			status: "running",
		});

		// One turn of the run ends and the next begins; the bus has reported no outcome yet.
		await flushUi(() => {
			AgentRegistry.global().setStatus(id, "idle");
		});
		expect(todoStatus(description)).toBe("pending");
		await flushUi(() => {
			AgentRegistry.global().setStatus(id, "running");
		});

		// A sync spawn is drawn by its own tool block, never by the detached Agents block.
		expect(laneRow(hudText(), id, description)).toBe(false);
		expect(todoStatus(description)).toBe("pending");
	});
});

describe("a woken agent's row after the wake", () => {
	it("settles aborted when the registry aborts the woken turn of a completed agent", () => {
		const bus = new EventBus();
		const observer = new SessionObserverRegistry();
		observer.subscribeToEventBus(bus);
		const id = "WokenThenAborted";
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, "Woken then aborted", "started", true));
		observer.mirrorAgentStatus({ id, status: "running" });
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(id, 0, "Woken then aborted", "completed", true));
		observer.mirrorAgentStatus({ id, status: "idle" });

		observer.mirrorAgentStatus({ id, status: "running" });
		expect(observer.getSessions().find(session => session.id === id)?.status).toBe("active");
		observer.mirrorAgentStatus({ id, status: "aborted" });
		expect(observer.getSessions().find(session => session.id === id)?.status).toBe("aborted");
		observer.dispose();
	});
});
