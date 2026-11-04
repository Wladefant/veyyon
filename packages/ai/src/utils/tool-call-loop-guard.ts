import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { setSafeProperty } from "@veyyon/utils/type-guards";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		// A model-supplied `__proto__`/`constructor`/`prototype` key must land as an
		// own property, else a bare assignment would drop or prototype-mutate it and
		// distinct argument sets would collide into the same canonical hash (a false
		// repeated-tool-call detection).
		setSafeProperty(output, key, canonicalizeToolCallValue(input[key]));
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = collapseWhitespace(text);
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** The message's only tool call, or undefined when it made none or several. */
function soleToolCall(message: AssistantMessage): ToolCall | undefined {
	let found: ToolCall | undefined;
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		if (found) return undefined;
		found = part;
	}
	return found;
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and returns the threshold hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCall = soleToolCall(turn.message);
		if (!toolCall || this.#exemptTools.has(toolCall.name)) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}

		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const hash = `${toolCall.name}:${canonicalArgs}`;
		this.#count = hash === this.#lastHash ? this.#count + 1 : 1;
		this.#lastHash = hash;

		// Exactly the threshold turn, not every turn past it: the redirect is
		// steering, and a steer repeated on every subsequent call is noise the
		// model pays for on each request.
		if (this.#count !== this.#threshold) return null;
		return {
			kind: "repeated_tool_call",
			toolName: toolCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
			argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
		};
	}
}
