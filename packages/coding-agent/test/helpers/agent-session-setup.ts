import type { AssistantMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";

/**
 * Shared factory for building a minimal mock `AssistantMessage`
 * used by AgentSession test suites.
 */
export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
