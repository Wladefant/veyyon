import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionMessageEntry } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";

/**
 * The session the compaction suites build: message entries under one fixed timestamp, and the
 * user, assistant and `read` result messages those entries hold. Every message is stamped `1`, so
 * no estimate or cut point depends on the clock.
 */

/** Message entries with ids `e-0`, `e-1`, … in the order they are built; no suite reads an id's number. */
export interface MessageEntries {
	entry(message: AgentMessage): SessionMessageEntry;
	/** The next id in the sequence, for an entry of another type. */
	nextId(): string;
}

export function messageEntries(): MessageEntries {
	let next = 0;
	const nextId = () => `e-${next++}`;
	return {
		entry: message => ({
			type: "message",
			id: nextId(),
			parentId: null,
			timestamp: "2026-08-06T00:00:00.000Z",
			message,
		}),
		nextId,
	};
}

export function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: emptyUsage(),
		stopReason: "stop",
	};
}

/** What a `read` call returned: one text block. */
export function readResult(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	};
}
