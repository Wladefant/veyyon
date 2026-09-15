import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Static, TSchema } from "@veyyon/ai";
import { checkRefusalFence } from "./refusal-fence";

const executionContext = new AsyncLocalStorage<AgentToolContext>();

class ToolExecutionEntry {
	forward<T>(context: AgentToolContext, operation: () => T): T {
		return executionContext.run(context, operation);
	}

	assert(tool: { name: string }, params: unknown, context?: AgentToolContext): AgentToolContext {
		const effectiveContext = context ?? executionContext.getStore();
		if (!effectiveContext?.settings) throw new Error("Tool execution requires session policy context");
		checkRefusalFence(tool.name, params, effectiveContext, undefined, tool);
		return effectiveContext;
	}

	async invoke<TParameters extends TSchema, TDetails>(
		tool: AgentTool<TParameters, TDetails>,
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		const effectiveContext = this.assert(tool, params, context);
		return executionContext.run(effectiveContext, () =>
			tool.execute(toolCallId, params, signal, onUpdate, effectiveContext),
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
