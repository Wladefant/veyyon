/**
 * Utility functions for mapping unified ToolChoice to provider-specific formats,
 * and for carrying a required tool call the wire format cannot force.
 */
import { AI_PROMPTS } from "../prompts/registry";
import type { Context, ImageContent, Message, TextContent, Tool, ToolChoice } from "../types";

/** OpenAI Completions API tool choice format */
export type OpenAICompletionsToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } }
	| undefined;

/** OpenAI Responses API tool choice format (flat structure) */
export type OpenAIResponsesToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| undefined;

/**
 * Extract function name from unified ToolChoice.
 */
function extractFunctionName(choice: ToolChoice): string | undefined {
	if (typeof choice === "string") return undefined;
	if (choice.type === "tool" && "name" in choice) return choice.name;
	if (choice.type === "function") {
		if ("function" in choice && choice.function && typeof choice.function === "object") {
			return (choice.function as { name?: string }).name;
		}
		if ("name" in choice) return choice.name;
	}
	return undefined;
}

/**
 * Map unified ToolChoice to OpenAI Completions API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 */
export function mapToOpenAICompletionsToolChoice(choice?: ToolChoice): OpenAICompletionsToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "function", function: { name } } : undefined;
}

/**
 * Returns true when an OpenAI-completions `tool_choice` value forces a tool
 * call (`"required"` or a function-name pin), as opposed to leaving it open
 * (`"auto"`, `"none"`, or unset). Accepts `unknown` because the param shape
 * pulled from the OpenAI SDK (`ChatCompletionToolChoiceOption`) widens with
 * each release; this check only needs the open/forced bit.
 */
export function isForcedToolChoice(choice: unknown): boolean {
	if (choice === undefined || choice === "auto" || choice === "none") return false;
	return true;
}

/**
 * Map unified ToolChoice to OpenAI Responses API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", name } (flat structure)
 */
export function mapToOpenAIResponsesToolChoice(choice?: ToolChoice): OpenAIResponsesToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "function", name } : undefined;
}

/** How much of a tool call an OpenAI `tool_choice` (Chat Completions or Responses) forces. */
export function openAIToolCallForce(choice: unknown): WireToolCallForce {
	if (!isForcedToolChoice(choice)) return "open";
	return choice === "required" ? "any" : "named";
}

/** The tool call a caller's `toolChoice` requires: one named tool, or any offered tool. */
export type RequiredToolCall = { readonly name: string } | "any";

/**
 * How much of a tool call the request a provider built forces: the named tool,
 * some tool, or nothing, in which case the model may answer in text.
 */
export type WireToolCallForce = "named" | "any" | "open";

/** The tool call `choice` requires, or `undefined` when it leaves the reply open (`auto`, `none`, unset). */
export function requiredToolCall(choice: ToolChoice | undefined): RequiredToolCall | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice === "any" || choice === "required" ? "any" : undefined;
	const name = extractFunctionName(choice);
	return name ? { name } : undefined;
}

const TOOL_TOKEN = "{{TOOL}}";
const NAMED_TOOL_CALL_INSTRUCTION = AI_PROMPTS["tool-choice/named"].text.trim();
const ANY_TOOL_CALL_INSTRUCTION = AI_PROMPTS["tool-choice/any"].text.trim();

/** How a request's tool list differs from `context.tools`. */
export interface OfferedTools {
	/** The tools the request offers, when it leaves some of `context.tools` out. */
	readonly tools?: readonly Tool[];
	/** The name the request advertises a tool under, when it renames tools on the wire. */
	readonly wireName?: (name: string) => string;
}

/**
 * The context a request sends when `choice` requires a tool call that `wire` does
 * not force.
 *
 * A host that rejects or ignores a forced `tool_choice` (a thinking model, a
 * gateway, an API with no such field) still receives the tool, and then the model
 * may answer in prose. The requirement then rides the request as text: the
 * instruction is appended to the last message, so the cached prefix ahead of it is
 * unchanged. Returns `context` itself when the wire already forces the call, when
 * nothing is required, or when the required tool is not offered, since an
 * instruction to call a tool the request does not carry cannot be followed.
 */
export function carryRequiredToolCall(
	context: Context,
	choice: ToolChoice | undefined,
	wire: WireToolCallForce,
	offered?: OfferedTools,
): Context {
	if (wire === "named") return context;
	const required = requiredToolCall(choice);
	if (required === undefined) return context;
	const tools = offered?.tools ?? context.tools;
	let instruction: string;
	if (required === "any") {
		if (wire === "any" || !tools?.length) return context;
		instruction = ANY_TOOL_CALL_INSTRUCTION;
	} else {
		const { name } = required;
		if (!tools?.some(tool => tool.name === name || tool.customWireName === name)) return context;
		const wireName = offered?.wireName?.(name) ?? name;
		instruction = NAMED_TOOL_CALL_INSTRUCTION.replace(TOOL_TOKEN, () => wireName);
	}
	return { ...context, messages: appendInstruction(context.messages, instruction) };
}

/**
 * `messages` with `text` closing the last turn. A tool result or a plain user turn
 * takes it as a trailing text block, so no new turn is opened and no API sees two
 * user turns in a row. A turn replayed from a provider's native history is sent as
 * that history rather than as its content, so it is followed by a new user turn,
 * as is an assistant turn or an empty history.
 */
function appendInstruction(messages: readonly Message[], text: string): Message[] {
	const last = messages.at(-1);
	const head = messages.slice(0, -1);
	if (last?.role === "toolResult") {
		return [...head, { ...last, content: [...last.content, { type: "text", text }] }];
	}
	if ((last?.role === "user" || last?.role === "developer") && !last.providerPayload) {
		return [...head, { ...last, content: appendText(last.content, text) }];
	}
	return [...messages, { role: "user", content: text, synthetic: true, timestamp: Date.now() }];
}

function appendText(
	content: string | (TextContent | ImageContent)[],
	text: string,
): string | (TextContent | ImageContent)[] {
	return typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }];
}
