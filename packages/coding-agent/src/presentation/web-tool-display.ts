/**
 * Web and collab projection for tool execution displays.
 *
 * Exposes canonical `projectToolDisplay` projection computed from `buildToolExecutionDisplay`
 * with expanded display semantics (`expanded: true`), supplying pure `@veyyon/wire/presentation`
 * `ToolExecutionDisplay` view-models to collab wire frames, HTML export, and test suites
 * without browser-side coding-agent imports or duplicate per-tool interpretation.
 */

import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { isRecord } from "@veyyon/utils/type-guards";
import type { ToolExecutionDisplay, ToolExecutionImageItem } from "@veyyon/wire/presentation";
import { buildToolExecutionDisplay, type ToolExecutionBuildParams } from "./tool-execution";

export type { ToolExecutionBuildParams };

/**
 * Safely normalize an unknown tool result content field into a structured content array or string.
 */
export function normalizeToolResultContent(
	content: unknown,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> | string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const items: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
		for (const item of content) {
			if (isRecord(item) && typeof item.type === "string") {
				items.push({
					type: item.type,
					text: typeof item.text === "string" ? item.text : undefined,
					data: typeof item.data === "string" ? item.data : undefined,
					mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
				});
			}
		}
		return items;
	}
	return [];
}

/**
 * Extract details from an unknown tool result payload without unchecked casting.
 */
export function extractToolResultDetails(result: unknown): unknown {
	if (isRecord(result) && "details" in result) {
		return result.details;
	}
	return result;
}

/**
 * Extract normalized content from an unknown tool result payload without unchecked casting.
 */
export function extractToolResultContent(
	result: unknown,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> | string {
	if (isRecord(result) && "content" in result) {
		return normalizeToolResultContent(result.content);
	}
	return normalizeToolResultContent(result);
}

/**
 * Project a tool execution's canonical visual presentation state for web, collab wire, and HTML export.
 *
 * Uses the canonical `buildToolExecutionDisplay` projection with expanded content (`expanded: true` default),
 * producing pure `@veyyon/wire/presentation` `ToolExecutionDisplay` view-models without constructing
 * full terminal UI components or importing coding-agent runtime code on guest clients.
 */
export function projectToolDisplay(params: ToolExecutionBuildParams): ToolExecutionDisplay {
	const display = buildToolExecutionDisplay({
		...params,
		expanded: params.expanded ?? true,
	});

	// Avoid duplicating heavy base64 image data in display (already transported in raw result content)
	let images: readonly ToolExecutionImageItem[] | undefined;
	if (display.images && display.images.length > 0) {
		images = display.images.map(img => ({
			mimeType: img.mimeType,
		}));
	}

	// Avoid duplicating generic raw output if raw result is present
	let generic = display.generic;
	if (generic?.outputText && params.result) {
		generic = {
			...generic,
			outputText: undefined,
		};
	}

	return {
		...display,
		images,
		generic,
	};
}

/** A tool result as the display projections read it, from a session message or a correlation map. */
interface ToolResultForDisplay {
	content: unknown;
	details?: unknown;
	isError?: boolean;
}

/** The display of tool call `call`, finished when its `result` is known and running until then. */
export function projectToolCallDisplay(
	call: { id: string; name: string; arguments?: unknown },
	result: ToolResultForDisplay | undefined,
): ToolExecutionDisplay {
	return projectToolDisplay({
		toolName: call.name,
		toolCallId: call.id,
		args: call.arguments,
		result: result
			? { content: normalizeToolResultContent(result.content), details: result.details, isError: result.isError }
			: undefined,
		isError: result?.isError,
		isPartial: result === undefined,
		expanded: true,
	});
}

/** The display of tool result message `message`, drawn with the arguments of the `call` it answers when known. */
export function projectToolResultDisplay(
	message: ToolResultForDisplay & { toolCallId: string; toolName?: string; timestamp?: number },
	call: { toolName: string; args: unknown } | undefined,
): ToolExecutionDisplay {
	const isError = message.isError === true;
	return projectToolDisplay({
		toolName: message.toolName || call?.toolName || "",
		toolCallId: message.toolCallId,
		args: call?.args,
		result: { content: normalizeToolResultContent(message.content), details: message.details, isError },
		isError,
		isPartial: false,
		timestamp: message.timestamp,
		expanded: true,
	});
}

export interface ToolCallCorrelation {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

export interface ToolResultCorrelation {
	toolCallId: string;
	toolName?: string;
	content: unknown;
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
}

export const TOOL_CALL_BLOCK_TYPES: readonly string[] = Object.freeze(["toolCall", "toolUse", "tool_use"]);

export function isToolCallRecord(block: unknown): block is Record<string, unknown> & { id: string; name: string } {
	return (
		isRecord(block) &&
		typeof block.type === "string" &&
		TOOL_CALL_BLOCK_TYPES.includes(block.type) &&
		typeof block.id === "string" &&
		typeof block.name === "string"
	);
}

/**
 * Record a single session entry into tool call and tool result correlation maps.
 */
export function recordToolCorrelationEntry(
	entry: SessionEntry,
	toolCalls: Map<string, ToolCallCorrelation>,
	toolResults: Map<string, ToolResultCorrelation>,
): void {
	if (entry.type !== "message") return;
	const msg = entry.message;
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (isToolCallRecord(block)) {
				toolCalls.set(block.id, {
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					intent: typeof block.intent === "string" ? block.intent : undefined,
				});
			}
		}
	} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
		toolResults.set(msg.toolCallId, {
			toolCallId: msg.toolCallId,
			toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
			content: msg.content,
			details: msg.details,
			isError: msg.isError === true,
			timestamp: msg.timestamp,
		});
	}
}

/**
 * Scan an entry list and build correlation maps for tool calls and tool results.
 */
export function buildToolCorrelations(entries: readonly SessionEntry[]): {
	toolCalls: Map<string, ToolCallCorrelation>;
	toolResults: Map<string, ToolResultCorrelation>;
} {
	const toolCalls = new Map<string, ToolCallCorrelation>();
	const toolResults = new Map<string, ToolResultCorrelation>();

	for (const entry of entries) {
		recordToolCorrelationEntry(entry, toolCalls, toolResults);
	}

	return { toolCalls, toolResults };
}

/**
 * Project session entries for HTML export and guest consumers by attaching canonical
 * `display: ToolExecutionDisplay` to tool calls and tool results.
 *
 * Preserves complete raw messages, arguments, results, details, and identifiers without
 * mutating the source session records.
 */
export function projectSessionEntriesForExport(entries: readonly SessionEntry[]): SessionEntry[] {
	const { toolCalls, toolResults } = buildToolCorrelations(entries);

	return entries.map(entry => {
		if (entry.type !== "message") return entry;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let changed = false;
			const projectedContent = msg.content.map(block => {
				if (isToolCallRecord(block)) {
					changed = true;
					return { ...block, display: projectToolCallDisplay(block, toolResults.get(block.id)) };
				}
				return block;
			});

			if (!changed) return entry;
			return {
				...entry,
				message: {
					...msg,
					content: projectedContent,
				},
			};
		}

		if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			const display = projectToolResultDisplay(msg, toolCalls.get(msg.toolCallId));

			return {
				...entry,
				message: {
					...msg,
					display,
				},
			};
		}

		return entry;
	});
}
