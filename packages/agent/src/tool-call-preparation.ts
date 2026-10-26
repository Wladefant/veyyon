/**
 * The arguments a tool call runs with: the `i` intent field stripped, repaired, validated against the tool's
 * schema and transformed into the form the tool executes and the form that is shown. The agent loop prepares every
 * call it dispatches here, and a provider that runs calls itself during the stream (Cursor's exec channel) prepares
 * them here too, so a call receives the same arguments whichever path ran it.
 */

import * as AIError from "@veyyon/ai/error";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { INTENT_FIELD } from "@veyyon/wire";
import { errorMessage, logger } from "@veyyon/utils";
import { extractIntent, MAX_INTENT_LENGTH, schemaDefinesProperty } from "./tool-normalization";
import type { AgentContext, AgentLoopConfig, AgentToolCall, AnyAgentTool, ToolCallRepairResult } from "./types";

/** The hooks {@link prepareToolCall} applies, as the agent loop is configured with them. */
export type ToolCallPreparation = Pick<
	AgentLoopConfig,
	"intentTracing" | "repairToolCallArguments" | "transformToolCallArguments"
>;

/** A call ready to run: the tool, the arguments it executes with and the arguments that are shown. */
export interface ReadyToolCall {
	readonly ok: true;
	readonly tool: AnyAgentTool;
	/** The model's `i` while intent tracing is on, else the label the tool derives from its arguments. */
	readonly intent: string | undefined;
	/** What `tool.execute()` and `beforeToolCall` receive. */
	readonly execution: Record<string, unknown>;
	/** What is shown, streamed, traced and recorded. */
	readonly display: Record<string, unknown>;
}

/** A call that does not run, with the arguments recorded for it and the text of its error result. */
export interface RejectedToolCall {
	readonly ok: false;
	readonly intent: string | undefined;
	readonly args: Record<string, unknown>;
	readonly error: string;
}

export type PreparedToolCall = ReadyToolCall | RejectedToolCall;

/** The intent label a tool's own resolver derives from the stripped arguments, if it has one. */
function derivedIntent(
	tool: AnyAgentTool | undefined,
	toolName: string,
	args: Record<string, unknown>,
): string | undefined {
	if (typeof tool?.intent !== "function") return undefined;
	try {
		return tool.intent(args as never)?.trim() || undefined;
	} catch (error) {
		// Must never break tool execution, but a throwing intent resolver is a broken tool feature — surface it.
		logger.warn("tool intent resolver threw; using the default intent label", {
			tool: toolName,
			error: errorMessage(error),
		});
		return undefined;
	}
}

/** The error text for arguments `repairToolCallArguments` could not repair, followed by its hints. */
function unrepairableArgumentsText(outcome: ToolCallRepairResult): string {
	const hints =
		outcome.hints.length > 0 ? `\n\n[Tool argument repair]\n${outcome.hints.map(h => `- ${h}`).join("\n")}` : "";
	return `${outcome.reason ?? "Tool arguments could not be repaired."}${hints}`;
}

/**
 * Prepare `toolCall` for `tool`: strip `i` while intent tracing is on, repair, validate (a tool declaring
 * `lenientArgValidation` runs with its arguments as they are) and transform. `availableTools` lists the tools a call
 * to a missing tool is pointed at.
 */
export function prepareToolCall(
	tool: AnyAgentTool | undefined,
	toolCall: AgentToolCall,
	config: ToolCallPreparation,
	availableTools?: AgentContext["tools"],
): PreparedToolCall {
	let args = toolCall.arguments as Record<string, unknown>;
	let intent: string | undefined;
	const stripIntent = config.intentTracing && !(tool && schemaDefinesProperty(toolWireSchema(tool), INTENT_FIELD));
	if (stripIntent) {
		const extracted = extractIntent(args);
		args = extracted.strippedArgs;
		intent = extracted.intent ?? derivedIntent(tool, toolCall.name, args);
	}
	// The one constructor of a rejection. Its text is the cause's own message, so two rejections are byte-identical
	// only when the same thing happened twice.
	const rejected = (
		error: string,
		recorded: Record<string, unknown> = "__parseError" in args ? { __parseError: args.__parseError } : args,
	): RejectedToolCall => ({ ok: false, intent, args: recorded, error });
	if (!tool) {
		return rejected(
			new AIError.ToolNotFoundError(
				toolCall.name,
				availableTools?.map(t => t.name),
			).message,
		);
	}
	const oversizedIntent = (): RejectedToolCall | undefined =>
		intent !== undefined && intent.length > MAX_INTENT_LENGTH
			? rejected(
					`\`${INTENT_FIELD}\` is a short intent label (at most ${MAX_INTENT_LENGTH} chars); the value you sent is ${intent.length} chars. The tool was not run. Put that content in the tool's own parameters and retry with a brief \`${INTENT_FIELD}\`.`,
				)
			: undefined;
	const intentRejection = oversizedIntent();
	if (intentRejection) return intentRejection;
	let execution: Record<string, unknown>;
	try {
		const repair = config.repairToolCallArguments;
		if (repair) {
			const outcome = repair(tool, { ...toolCall, arguments: args });
			if (outcome.status === "unrepairable") {
				return rejected(unrepairableArgumentsText(outcome), args);
			}
			args = outcome.arguments;
			if (stripIntent) {
				const extracted = extractIntent(args);
				args = extracted.strippedArgs;
				intent = extracted.intent ?? intent;
				const repairedIntentRejection = oversizedIntent();
				if (repairedIntentRejection) return repairedIntentRejection;
			}
		}
		execution = validateToolArguments(tool, { ...toolCall, arguments: args });
	} catch (validationError) {
		if (!tool.lenientArgValidation) return rejected(errorMessage(validationError));
		execution = { ...args };
		delete execution.__parseError;
		delete execution.__rawJson;
	}
	const transform = config.transformToolCallArguments;
	if (!transform) return { ok: true, tool, intent, execution, display: execution };
	try {
		const transformed = transform(execution, toolCall.name);
		return { ok: true, tool, intent, execution: transformed.execution, display: transformed.display };
	} catch (transformError) {
		return rejected(errorMessage(transformError), execution);
	}
}
