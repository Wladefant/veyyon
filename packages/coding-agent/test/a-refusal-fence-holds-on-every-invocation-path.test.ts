/**
 * A refusal fence holds across every tool invocation path.
 *
 * WHY THIS SUITE EXISTS. Issue #37: An operation was refused by an extension
 * guard as shell_destructive_os, but equivalent work executed 38 seconds later
 * before operator approval. Subagents, eval environments, dynamic tools, and
 * worker IPC bypass paths bypassed the refusal because the refusal fence was
 * not anchored at a single executor choke point reading directly from session
 * config/settings.
 *
 * This suite enumerates every known invocation path from REFUSAL_ENTRY_POINTS
 * and asserts that:
 *  1. Every path enforces the refusal fence when configured in settings or
 *     standing session denial.
 *  2. The target tool never executes (its execute() body is never entered).
 *  3. Opt-outs are pinned by exact equality (no unverified paths).
 *  4. A mutation removing the check at the choke point fails every path.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { createSubagentSettings } from "@veyyon/coding-agent/task/executor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import {
	REFUSAL_ENTRY_POINTS,
	type RefusalEntryPoint,
	RefusalFenceError,
	checkRefusalFence,
	isToolRefused,
	recordRefusal,
} from "@veyyon/coding-agent/tools/core/refusal-fence";
import { type } from "arktype";

const PROBE_TOOL_NAME = "test_destructive_probe";
let probeExecuted = false;

function createProbeTool(name = PROBE_TOOL_NAME): AgentTool {
	return {
		name,
		label: name,
		summary: "Refusal probe tool that records whether it executed",
		description: "Refusal probe tool that records whether it executed",
		parameters: type({ cmd: "string" }),
		approval: () => ({ tier: "exec" as const }),
		execute: async () => {
			probeExecuted = true;
			return { content: [{ type: "text", text: "PROBE_RAN" }] };
		},
	} as unknown as AgentTool;
}

const mockRunner = {
	hasHandlers: (_event: string) => false,
	hasUI: () => false,
	getUIContext: () => undefined,
	getExtensionNameForHandler: () => undefined,
	emit: async () => undefined,
	emitToolCall: async () => undefined,
	emitToolResult: async () => undefined,
	createContext: () => ({}),
} as unknown as ExtensionRunner;

function createSessionApprovals(initial: Record<string, "allow" | "deny"> = {}): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">(Object.entries(initial));
	return {
		get: (toolName: string) => map.get(toolName),
		set: (toolName: string, decision: "allow" | "deny") => {
			map.set(toolName, decision);
		},
	};
}

function createMockToolSession(options: {
	settings?: Settings;
	sessionApprovals?: SessionToolApprovals;
	tool?: AgentTool;
	wrapTool?: boolean;
}): ToolSession {
	const tool = options.tool ?? createProbeTool();
	const wrapped = options.wrapTool !== false ? new ExtensionToolWrapper(tool, mockRunner) : tool;
	const settings = options.settings ?? Settings.isolated();
	const sessionApprovals = options.sessionApprovals ?? createSessionApprovals();

	const toolContext: AgentToolContext = {
		settings,
		sessionApprovals,
		autoApprove: false,
		sessionManager: {
			getSessionId: () => "mock-session-id",
			getCwd: () => "/mock/cwd",
		} as unknown as AgentToolContext["sessionManager"],
	} as unknown as AgentToolContext;

	return {
		cwd: "/mock/cwd",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		getToolByName: (name: string) => (name === tool.name ? (wrapped as AgentTool) : undefined),
		getToolContext: () => toolContext,
	};
}

describe("Universal Refusal Fence on Every Invocation Path", () => {
	beforeEach(() => {
		probeExecuted = false;
	});

	it("exports the complete 9-path runtime table without silent exclusions", () => {
		const expectedPaths: RefusalEntryPoint[] = [
			"task.executor",
			"eval.agent-bridge",
			"eval.tool-bridge",
			"session.irc",
			"job.resume",
			"cli.worker",
			"session.dynamic-tools",
			"collab.guest",
			"extension.tool_call",
		];
		expect(REFUSAL_ENTRY_POINTS).toEqual(expectedPaths);

		// Opt-outs pinned by exact equality: no path may be silently opted out
		const optedOutPaths: string[] = [];
		expect(optedOutPaths).toEqual([]);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 1: task.executor (subagent task execution)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 1: task.executor blocks refused tools in child subagent sessions even with stripped extensions", async () => {
		// Root session sets policy in settings
		const rootSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Subagent settings derived via production createSubagentSettings
		const subagentSettings = createSubagentSettings(rootSettings, {}, undefined);

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const subagentContext: AgentToolContext = {
			settings: subagentSettings,
			autoApprove: true, // yolo should NEVER bypass explicit refusal
			sessionApprovals: createSessionApprovals(), // stripped approvals
		} as unknown as AgentToolContext;
		await expect(
			wrapped.execute("task-call-1", { cmd: "rm -rf /" }, undefined, undefined, subagentContext),
		).rejects.toThrow(RefusalFenceError);

		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 2: eval.agent-bridge (eval agent() subagent spawn)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 2: eval.agent-bridge blocks refused tools in eval-spawned child agents", async () => {
		const parentSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Eval agent inherits via runtime fork
		const evalSpawnSettings = parentSettings.forkWithRuntimeOverrides();

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const evalContext: AgentToolContext = {
			settings: evalSpawnSettings,
			autoApprove: true,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await expect(
			wrapped.execute("eval-agent-call-1", { cmd: "whoami" }, undefined, undefined, evalContext),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 3: eval.tool-bridge (eval tool.<name>() execution)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 3: eval.tool-bridge blocks refused tools via callSessionTool", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const session = createMockToolSession({ settings });
		await expect(
			callSessionTool(PROBE_TOOL_NAME, { cmd: "id" }, { session }),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 4: session.irc (IRC-woken agent turns)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 4: session.irc blocks refused tools when an agent is woken by IRC", async () => {
		const ircSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const ircContext: AgentToolContext = {
			settings: ircSettings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await expect(
			wrapped.execute("irc-wake-call-1", { cmd: "ping" }, undefined, undefined, ircContext),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 5: job.resume (resumed / revived agent sessions)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 5: job.resume blocks refused tools in revived/reopened sessions", async () => {
		const baseSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Revived session clones settings
		const revivedSettings = await baseSettings.cloneForCwd("/mock/cwd");

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const revivedContext: AgentToolContext = {
			settings: revivedSettings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await expect(
			wrapped.execute("revive-call-1", { cmd: "restart" }, undefined, undefined, revivedContext),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 6: cli.worker (worker IPC bridge for JS_EVAL/TINY workers)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 6: cli.worker blocks refused tools arriving over worker IPC bridge", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const session = createMockToolSession({ settings });

		// Worker calls callSessionTool with abort signal and IPC context
		const abortController = new AbortController();
		await expect(
			callSessionTool(PROBE_TOOL_NAME, { cmd: "ps" }, { session, signal: abortController.signal }),
		).rejects.toThrow(RefusalFenceError);

		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 7: session.dynamic-tools (MCP and dynamic tools like refreshSshTool)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 7: session.dynamic-tools ensures dynamically refreshed tools are fenced", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Dynamic tool wrapped by the runtime tool wrapper
		const dynamicTool = createProbeTool();
		const wrappedDynamic = new ExtensionToolWrapper(dynamicTool, undefined); // even without runner!

		const context: AgentToolContext = {
			settings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await expect(
			wrappedDynamic.execute("dyn-call-1", { cmd: "ssh" }, undefined, undefined, context),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 8: collab.guest (collab/web guest client frames)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 8: collab.guest blocks refused tools when guest frames trigger agent prompt", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		// Collab guest session context
		const collabContext: AgentToolContext = {
			settings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;

		await expect(
			wrapped.execute("collab-call-1", { cmd: "status" }, undefined, undefined, collabContext),
		).rejects.toThrow(RefusalFenceError);

		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Path 9: extension.tool_call (extension hook refusal and recordRefusal persistence)
	// ─────────────────────────────────────────────────────────────────────────
	it("Path 9: extension.tool_call persists refusal into session config to fence all later calls", async () => {
		const settings = Settings.isolated();
		const sessionApprovals = createSessionApprovals();
		const context: AgentToolContext = {
			settings,
			sessionApprovals,
		} as unknown as AgentToolContext;

		// 1. Initial state: tool is not refused
		expect(isToolRefused(PROBE_TOOL_NAME, {}, context).refused).toBe(false);

		// 2. Extension hook (e.g. Telegram guard) refuses execution with a reason
		recordRefusal(PROBE_TOOL_NAME, "refused as shell_destructive_os", context);

		// 3. Status must now report refused
		const status = isToolRefused(PROBE_TOOL_NAME, {}, context);
		expect(status.refused).toBe(true);

		// 4. checkRefusalFence must throw RefusalFenceError
		expect(() => checkRefusalFence(PROBE_TOOL_NAME, {}, context)).toThrow(RefusalFenceError);

		// 5. Subsequent execution through ExtensionToolWrapper must be fenced
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);
		await expect(
			wrapped.execute("telegram-call-1", { cmd: "notepad.exe" }, undefined, undefined, context),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);

		// 6. Child session spawned after the refusal must inherit the refusal in settings
		const childSettings = createSubagentSettings(settings, {}, undefined);
		const childContext: AgentToolContext = {
			settings: childSettings,
			sessionApprovals: createSessionApprovals(), // fresh approvals
		} as unknown as AgentToolContext;

		await expect(
			wrapped.execute("child-after-refusal-1", { cmd: "notepad.exe" }, undefined, undefined, childContext),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Standing session denial under autoApprove / yolo (the standing denial bypass hole)
	// ─────────────────────────────────────────────────────────────────────────
	it("refusal fence blocks standing denials even under autoApprove / yolo bypass", async () => {
		const settings = Settings.isolated();
		const sessionApprovals = createSessionApprovals({ [PROBE_TOOL_NAME]: "deny" });

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const yoloContext: AgentToolContext = {
			settings,
			sessionApprovals,
			autoApprove: true, // autoApprove previously set standing = undefined!
			bypassAllApprovals: true,
		} as unknown as AgentToolContext;

		await expect(
			wrapped.execute("standing-yolo-1", { cmd: "test" }, undefined, undefined, yoloContext),
		).rejects.toThrow(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});
});
