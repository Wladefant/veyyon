import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";

export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}
