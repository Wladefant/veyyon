import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { checkRefusalFence, RefusalFenceError, type ToolPolicyFrame } from "./refusal-fence";

const executionContext = new AsyncLocalStorage<ToolPolicyFrame>();

/**
 * The frame, but only when it is a REAL tool context.
 *
 * `sessionManager` is required on a full context and absent from a policy-only
 * frame, so it separates the two. A policy-only frame is not handed to the tool:
 * those call sites passed no context before the fence existed, and passing a
 * half-populated one would let a tool read `undefined` where the type promises a
 * session.
 */
function asToolContext(frame: ToolPolicyFrame): AgentToolContext | undefined {
	return frame.sessionManager ? (frame as AgentToolContext) : undefined;
}

class ToolExecutionEntry {
	forward<T>(context: ToolPolicyFrame, operation: () => T): T {
		return executionContext.run(context, operation);
	}

	assert(tool: { name: string }, params: unknown, context?: ToolPolicyFrame): ToolPolicyFrame {
		const effectiveContext = context ?? executionContext.getStore();
		if (!effectiveContext?.settings) {
			throw new RefusalFenceError(tool.name, "Tool execution requires missing session policy context");
		}
		checkRefusalFence(tool.name, params, effectiveContext, undefined, tool);
		return effectiveContext;
	}

	/**
	 * Fence the call, then hand back a context that can be forwarded to a tool:
	 * the supplied one, or the ambient one when the caller omitted it. A
	 * policy-only frame yields `undefined`, because it is not a tool context.
	 */
	assertContext(tool: { name: string }, params: unknown, context?: ToolPolicyFrame): AgentToolContext | undefined {
		return asToolContext(this.assert(tool, params, context));
	}

	/**
	 * Fence a call whose caller may have established no context at all, against
	 * the policy the tool's OWNER stands for.
	 *
	 * A tool taken off a session registry is invoked directly — the cursor
	 * bridge, an eval snippet, a browser page, `session.getToolByName(...)` — and
	 * those call sites thread a context through only when they happen to have
	 * one. The session's standing refusals apply to that call either way, so a
	 * missing context reads the owner's policy instead of refusing the work for
	 * want of one.
	 *
	 * Returns the context the tool may be handed: the supplied frame, or the
	 * ambient one when the caller omitted it, and NEVER the owner policy. That
	 * frame answers the fence and stops there, because a caller that established
	 * no context established no session for the tool — or for the approval gate —
	 * to read.
	 */
	fence(
		tool: { name: string },
		params: unknown,
		context?: ToolPolicyFrame,
		ownerPolicy?: () => ToolPolicyFrame | undefined,
	): AgentToolContext | undefined {
		const established = context ?? executionContext.getStore();
		if (established) return this.assertContext(tool, params, established);
		this.assert(tool, params, ownerPolicy?.());
		return undefined;
	}

	/**
	 * Keyed on the tool's DETAILS type only, the way `wrapToolWithMetaNotice` is.
	 * A concrete tool types `execute`'s `params` concretely without exposing a
	 * schema this can infer from, so pinning the schema resolves it to `TSchema`,
	 * `Static<TSchema>` to `unknown`, and rejects the real tool contravariantly.
	 * Details stay bound, so a caller keeps its result and update typing; the
	 * params are validated against the tool's own schema downstream regardless.
	 */
	async invoke<TDetails>(
		tool: AgentTool<any, TDetails, any>,
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, any>,
		context?: ToolPolicyFrame,
	): Promise<AgentToolResult<TDetails, any>> {
		const effectiveContext = this.assert(tool, params, context);
		return executionContext.run(effectiveContext, () =>
			tool.execute(toolCallId, params, signal, onUpdate, asToolContext(effectiveContext)),
		);
	}
}

/** Actual dispatch boundaries, not the upstream reasons a session woke up. */
export const TOOL_EXECUTION_ENTRIES = Object.freeze({
	"session.tools": new ToolExecutionEntry(),
	"session.dynamic-tools": new ToolExecutionEntry(),
	"eval.tool-bridge": new ToolExecutionEntry(),
	"cli.worker": new ToolExecutionEntry(),
	"cli.read": new ToolExecutionEntry(),
	"commit.analysis": new ToolExecutionEntry(),
	"legacy.adapter": new ToolExecutionEntry(),
	"collab.guest": new ToolExecutionEntry(),
});

export type ToolExecutionEntryName = keyof typeof TOOL_EXECUTION_ENTRIES;
