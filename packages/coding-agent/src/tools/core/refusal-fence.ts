/**
 * Universal Refusal Fence.
 *
 * Enforces executor-owned tool refusal across every invocation path in the
 * runtime. The refusal policy is read directly from session / config settings
 * and session approvals, so child sessions (subagents, eval agents, worktrees)
 * created with stripped extensions or uninherited approvals are still fenced.
 *
 * Issue #37: Refusal fence choke point.
 */

import type { AgentToolContext } from "@veyyon/agent-core";
import type { Settings } from "../../config/settings";

/**
 * The runtime table of all 9 invocation paths subject to the refusal fence.
 * Exported from this owning module so any new entry point added to the system
 * must be registered here and exercised by the sweep test.
 */
export const REFUSAL_ENTRY_POINTS = [
	"task.executor", // Path 1: task tool (subagents)
	"eval.agent-bridge", // Path 2: eval agent()
	"eval.tool-bridge", // Path 3: eval tool.<name>()
	"session.irc", // Path 4: irc-woken agents
	"job.resume", // Path 5: job resumption / reviveSession
	"cli.worker", // Path 6: cli.ts worker re-entry (TINY/JS_EVAL/TAB workers)
	"session.dynamic-tools", // Path 7: MCP/dynamic tools incl. refreshSshTool
	"collab.guest", // Path 8: collab/web guest frames
	"extension.tool_call", // Path 9: Telegram tool_call hook
] as const;

export type RefusalEntryPoint = (typeof REFUSAL_ENTRY_POINTS)[number];

export class RefusalFenceError extends Error {
	readonly toolName: string;
	readonly reason: string;

	constructor(toolName: string, reason: string) {
		super(reason);
		this.name = "RefusalFenceError";
		this.toolName = toolName;
		this.reason = reason;
	}
}

export interface RefusalStatus {
	refused: boolean;
	reason?: string;
}

/**
 * Check whether a tool is refused by policy in settings or standing session denial.
 */
export function isToolRefused(
	toolName: string,
	_params?: unknown,
	context?: AgentToolContext,
	settingsOverride?: Settings,
): RefusalStatus {
	const settings = settingsOverride ?? context?.settings;

	// 1. Read refusal policy directly from session/config settings.
	// This ensures that child sessions (subagents, eval agents) created with
	// stripped extensions or uninherited sessionApprovals are still fenced,
	// because settings are inherited across process and worktree forks.
	if (settings) {
		const approvalPolicies = (settings.get("tools.approval") ?? {}) as Record<string, unknown>;
		const directPolicy = approvalPolicies[toolName] ?? settings.get(`tools.approval.${toolName}`);
		if (directPolicy === "deny" || directPolicy === "refuse") {
			return {
				refused: true,
				reason: `Tool "${toolName}" is blocked by user policy.\nTo allow: remove "tools.approval.${toolName}: deny" from config.`,
			};
		}
		const refusalList = settings.get("tools.refusals");
		if (Array.isArray(refusalList) && refusalList.includes(toolName)) {
			return {
				refused: true,
				reason: `Tool "${toolName}" is blocked by refusal list (tools.refusals: ${toolName})`,
			};
		}
	}

	// 2. Read session-level standing refusal if present in context.
	const standing = context?.sessionApprovals?.get(toolName);
	if (standing === "deny") {
		return {
			refused: true,
			reason: `Tool call denied for this session: ${toolName}`,
		};
	}

	return { refused: false };
}

/**
 * Assert that the tool is not refused. Throws RefusalFenceError if refused.
 */
export function checkRefusalFence(
	toolName: string,
	params?: unknown,
	context?: AgentToolContext,
	settingsOverride?: Settings,
): void {
	const status = isToolRefused(toolName, params, context, settingsOverride);
	if (status.refused) {
		throw new RefusalFenceError(toolName, status.reason ?? `Tool "${toolName}" is refused by policy`);
	}
}

/**
 * Record a refusal into the session settings and approvals so that all child
 * sessions and later calls inherit the denial.
 */
export function recordRefusal(
	toolName: string,
	reason: string,
	context?: AgentToolContext,
	settingsOverride?: Settings,
): void {
	const settings = settingsOverride ?? context?.settings;
	if (settings) {
		const current = (settings.get("tools.approval") ?? {}) as Record<string, unknown>;
		const next = { ...current, [toolName]: "deny" };
		settings.set("tools.approval", next);
		settings.override("tools.approval", next);
	}
	context?.sessionApprovals?.set(toolName, "deny");
}
