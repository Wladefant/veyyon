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

import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import type { Settings } from "../../config/settings";
import type { ToolRefusalSubject } from "../../extensibility/shared-events";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isUnboundedExecutor } from "./effect-scope";

/**
 * What a dispatch boundary must carry for the fence to judge a call: in
 * practice the `settings` holding the standing refusals, and whatever else of
 * the tool context the caller happens to have.
 *
 * It is a PARTIAL context because several boundaries never had a full one.
 * `veyyon read`, commit analysis and the worker IPC bridge construct a tool and
 * run it outside a session, so they can offer settings and nothing else;
 * requiring `AgentToolContext` would mean inventing a session manager, model
 * registry and abort handle that do not exist.
 */
export type ToolPolicyFrame = Partial<AgentToolContext>;

interface StoredRefusal {
	version: 1;
	tool: string;
	subject: ToolRefusalSubject;
	reason: string;
}

/**
 * Whether a refused path and a path this call would touch can be the same file.
 *
 * Containment runs BOTH ways. `relative(refused, candidate)` catches a call
 * writing `/repo/protected/file` while `/repo/protected` is refused; the reverse
 * catches a call whose target is a directory CONTAINING the refused path, which
 * is how the directory-granular tools report themselves — `search` publishes its
 * roots, not the files under them, so a one-way check would let a search rooted
 * at `/repo` read a refused `/repo/protected` unfenced.
 *
 * `path.relative` rather than a string prefix, so `/repo/protectedX` does not
 * match `/repo/protected` and `/repo/sub/../protected` does.
 */
function pathsOverlap(refused: string, candidate: string): boolean {
	const inside = (from: string, to: string): boolean => {
		const relative = path.relative(from, to);
		return (
			relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		);
	};
	return inside(refused, candidate) || inside(candidate, refused);
}

function refusals(settings?: Settings): StoredRefusal[] {
	const value = settings?.get("tools.refusals");
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is StoredRefusal => {
		if (typeof item !== "object" || item === null) return false;
		// The setting is declared as opaque objects: refusals are written by older
		// builds too, so every field is re-validated here rather than trusted.
		const row = item as Partial<StoredRefusal>;
		return (
			row.version === 1 &&
			typeof row.tool === "string" &&
			typeof row.reason === "string" &&
			typeof row.subject?.value === "string" &&
			["path", "command", "tool"].includes(row.subject.kind)
		);
	});
}

function cwd(context?: ToolPolicyFrame): string {
	return context?.sessionManager?.getCwd() ?? process.cwd();
}

function normalizedPath(value: string, context?: ToolPolicyFrame): string {
	const resolved = path.resolve(cwd(context), value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
	params?: unknown,
	context?: ToolPolicyFrame,
	settingsOverride?: Settings,
	tool?: unknown,
): RefusalStatus {
	const settings = settingsOverride ?? context?.settings;
	const unbounded = isUnboundedExecutor(tool);

	// 1. Read refusal policy directly from session/config settings.
	// This ensures that child sessions (subagents, eval agents) created with
	// stripped extensions or uninherited sessionApprovals are still fenced,
	// because settings are inherited across process and worktree forks.
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
		const refusalList = settings.get("tools.refusals");
		if (Array.isArray(refusalList) && refusalList.includes(toolName)) {
			return {
				refused: true,
				reason: `Tool "${toolName}" is blocked by refusal list (tools.refusals: ${toolName})`,
			};
		}
	}

	for (const refusal of refusals(settings)) {
		const subject = refusal.subject;
		let matches = false;
		if (subject.kind === "tool") {
			matches = subject.value === toolName;
		} else if (subject.kind === "path") {
			// A tool that DECLARES unbounded effects can touch any path, and nothing
			// about a shell line, a script body or a delegated agent is safe to infer
			// from its arguments, so it stays fenced for every call while the refusal
			// stands. `filesystemTargets` narrows this only for a tool that declared
			// its effects are exactly those targets.
			matches =
				unbounded ||
				(hasFilesystemTargets(tool) &&
					tool
						.filesystemTargets(params, cwd(context))
						.some(target => pathsOverlap(subject.value, normalizedPath(target, context))));
		} else {
			// A command subject names work, not a path, and only a tool that can run
			// arbitrary work can perform it. Same declaration, same answer.
			matches = unbounded;
		}
		if (matches) return { refused: true, reason: refusal.reason };
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
	context?: ToolPolicyFrame,
	settingsOverride?: Settings,
	tool?: unknown,
): void {
	const status = isToolRefused(toolName, params, context, settingsOverride, tool);
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
	context?: ToolPolicyFrame,
	settingsOverride?: Settings,
	subject?: ToolRefusalSubject,
): void {
	const settings = settingsOverride ?? context?.settings;
	if (
		subject &&
		(typeof subject.value !== "string" ||
			subject.value.trim() === "" ||
			!["path", "command", "tool"].includes(subject.kind))
	)
		subject = undefined;
	if (subject) {
		if (!settings) throw new RefusalFenceError(toolName, "Cannot retain a scoped refusal without session settings");
		const normalized =
			subject.kind === "path" ? { ...subject, value: normalizedPath(subject.value, context) } : subject;
		const previous = settings.get("tools.refusals");
		const legacy = Array.isArray(previous) ? previous.filter(item => typeof item === "string") : [];
		const next = [
			...legacy,
			...refusals(settings).filter(
				item => item.subject.kind !== normalized.kind || item.subject.value !== normalized.value,
			),
			{ version: 1 as const, tool: toolName, subject: normalized, reason },
		];
		settings.set("tools.refusals", next);
		settings.override("tools.refusals", next);
		return;
	}
	if (settings) {
		const current = (settings.get("tools.approval") ?? {}) as Record<string, unknown>;
		const next = { ...current, [toolName]: "deny" };
		settings.set("tools.approval", next);
		settings.override("tools.approval", next);
	}
	context?.sessionApprovals?.set(toolName, "deny");
}
