import type { AgentMessage } from "@veyyon/agent-core";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import type { MockResponse } from "@veyyon/ai/providers/mock";
import { toolResultText } from "./tool-result-text";

/** A scripted plain-text assistant turn that ends the loop. */
export function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

/** The persisted tool result for one call id in a transcript. */
export function findToolResult(messages: readonly AgentMessage[], callId: string): ToolResultMessage | undefined {
	return messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === callId,
	);
}

/**
 * Text of the first `toolName` result in a request context, which is what the next model call received.
 * Matched by tool name, not call id: the wire canonicalizer rewrites provider-facing ids, so the outbound
 * id is not the emitted one.
 */
export function nextRequestToolResultText(messages: readonly Message[], toolName: string): string | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	return result && toolResultText(result);
}
