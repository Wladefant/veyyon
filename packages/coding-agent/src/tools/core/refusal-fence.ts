/**
 * Universal Refusal Fence.
 *
 * Enforces the operator's own tool denials across every invocation path in the
 * runtime. Two sources count, and both are decisions the operator made: a
 * `tools.approval.<tool>: deny` entry they put in config, and a "deny" they
 * chose for this session. The policy is read directly from the settings and
 * session approvals a call carries, so child sessions (subagents, eval agents,
 * worktrees) created with stripped extensions are still fenced.
 *
 * Nothing here records a denial on the operator's behalf. An extension that
 * blocks a call blocks that call only: it is answered where it was asked, and
 * the next call is asked again. Turning such a block into a standing denial
 * wrote `tools.approval.<tool>: deny` into the profile config and locked the
 * tool in every later session with no prompt to undo it.
 *
 * Issue #37: Refusal fence choke point.
 */

import type { AgentToolContext } from "@veyyon/agent-core";
import type { Settings } from "../../config/settings";

/**
 * What a dispatch boundary must carry for the fence to judge a call: in
 * practice the `settings` holding the operator's tool policy, and whatever else
 * of the tool context the caller happens to have.
 *
 * It is a PARTIAL context because several boundaries never had a full one.
 * `veyyon read`, commit analysis and the worker IPC bridge construct a tool and
 * run it outside a session, so they can offer settings and nothing else;
 * requiring `AgentToolContext` would mean inventing a session manager, model
 * registry and abort handle that do not exist.
 */
export type ToolPolicyFrame = Partial<AgentToolContext>;

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
 * Check whether the operator denied a tool in config or for this session.
 */
export function isToolRefused(toolName: string, context?: ToolPolicyFrame, settingsOverride?: Settings): RefusalStatus {
	const settings = settingsOverride ?? context?.settings;

	// Read the policy from settings rather than session memory: settings are
	// inherited across process and worktree forks, so a subagent or eval agent
	// started with uninherited session approvals is still fenced.
	if (settings) {
		// `tools.approval` is a record setting, so the per-tool policy is read by
		// indexing it; there is no `tools.approval.<tool>` path in the schema.
		const approvalPolicies = (settings.get("tools.approval") ?? {}) as Record<string, unknown>;
		const directPolicy = approvalPolicies[toolName];
		if (directPolicy === "deny" || directPolicy === "refuse") {
			return {
				refused: true,
				reason: `Tool "${toolName}" is blocked by user policy.\nTo allow: remove "tools.approval.${toolName}: deny" from config.`,
			};
		}
	}

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
export function checkRefusalFence(toolName: string, context?: ToolPolicyFrame, settingsOverride?: Settings): void {
	const status = isToolRefused(toolName, context, settingsOverride);
	if (status.refused) {
		throw new RefusalFenceError(toolName, status.reason ?? `Tool "${toolName}" is refused by policy`);
	}
}
