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

	assert(tool: { name: string }, context?: ToolPolicyFrame): ToolPolicyFrame {
		const effectiveContext = context ?? executionContext.getStore();
		if (!effectiveContext?.settings) {
			throw new RefusalFenceError(tool.name, "Tool execution requires missing session policy context");
		}
		checkRefusalFence(tool.name, effectiveContext);
		return effectiveContext;
	}

	/**
	 * The frame that answers the fence, and the frame a tool may be handed.
	 *
	 * A tool taken off a session registry is invoked directly — the cursor
	 * bridge, an eval snippet, a browser page, `session.getToolByName(...)` — and
	 * those call sites thread a context through only when they happen to have
	 * one. The session's tool policy applies to that call either way, so a
	 * missing context is judged against the owner's policy instead of refusing
	 * the work for want of one.
	 *
	 * `established` is what the CALLER brought: the supplied frame, or the
	 * ambient one when the caller omitted it, and never the owner policy. A
	 * caller that established no context established no session for the tool — or
	 * for the approval gate — to read, so the owner frame answers the fence and
	 * stops there.
	 */
	#resolve(
		context: ToolPolicyFrame | undefined,
		ownerPolicy: (() => ToolPolicyFrame | undefined) | undefined,
	): { policy: ToolPolicyFrame | undefined; established: ToolPolicyFrame | undefined } {
		const established = context ?? executionContext.getStore();
		return { policy: established ?? ownerPolicy?.(), established };
	}

	resolveExecution(
		tool: { name: string },
		context?: ToolPolicyFrame,
		ownerPolicy?: () => ToolPolicyFrame | undefined,
	): { policy: ToolPolicyFrame; toolContext: AgentToolContext | undefined } {
		const { policy, established } = this.#resolve(context, ownerPolicy);
		const assertedPolicy = this.assert(tool, policy);
		return { policy: assertedPolicy, toolContext: established ? asToolContext(established) : undefined };
	}

	/**
	 * Fence a call whose caller may have established no context at all, then hand
	 * back the context the tool may be given: the caller's own, or nothing.
	 */
	fence(
		tool: { name: string },
		context?: ToolPolicyFrame,
		ownerPolicy?: () => ToolPolicyFrame | undefined,
	): AgentToolContext | undefined {
		const { policy, established } = this.#resolve(context, ownerPolicy);
		this.assert(tool, policy);
		return established && asToolContext(established);
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
		ownerPolicy?: () => ToolPolicyFrame | undefined,
	): Promise<AgentToolResult<TDetails, any>> {
		const { policy, toolContext } = this.resolveExecution(tool, context, ownerPolicy);
		// The fenced policy becomes ambient, so a tool that calls another tool
		// inherits the policy this call was judged against even when the caller
		// established nothing. The tool itself still sees only what the caller
		// brought.
		return executionContext.run(policy, () => tool.execute(toolCallId, params, signal, onUpdate, toolContext));
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
