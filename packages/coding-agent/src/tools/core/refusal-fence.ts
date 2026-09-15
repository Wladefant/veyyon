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

interface StoredRefusal {
	version: 1;
	tool: string;
	subject: ToolRefusalSubject;
	reason: string;
}

function refusals(settings?: Settings): StoredRefusal[] {
	const value = settings?.get("tools.refusals");
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is StoredRefusal =>
			typeof item === "object" &&
			item !== null &&
			item.version === 1 &&
			typeof item.tool === "string" &&
			typeof item.reason === "string" &&
			typeof item.subject?.value === "string" &&
			["path", "command", "tool"].includes(item.subject.kind),
	);
}

function cwd(context?: AgentToolContext): string {
	return context?.sessionManager?.getCwd() ?? process.cwd();
}

function normalizedPath(value: string, context?: AgentToolContext): string {
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
	context?: AgentToolContext,
	settingsOverride?: Settings,
	tool?: unknown,
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

	for (const refusal of refusals(settings)) {
		const subject = refusal.subject;
		let matches = false;
		if (subject.kind === "tool") {
			matches = subject.value === toolName;
		} else if (subject.kind === "path") {
			// An opaque executor can touch any path. Never infer shell effects from syntax.
			matches =
				!hasFilesystemTargets(tool) ||
				tool.filesystemTargets(params, cwd(context)).some(target => {
					const candidate = normalizedPath(target, context);
					const relative = path.relative(subject.value, candidate);
					return (
						relative === "" ||
						(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
					);
				});
		} else {
			// A command subject has no trustworthy effect set: opaque execution stays fenced.
			matches = !hasFilesystemTargets(tool);
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
	context?: AgentToolContext,
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
	context?: AgentToolContext,
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
