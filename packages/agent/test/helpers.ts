import type { AgentMessage } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, UserMessage } from "@veyyon/ai";
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

/**
 * A `convertToLlm` that passes every user, assistant and tool-result message through unchanged and
 * drops the rest. Unlike the agent's default it keeps a provider refusal, so a suite sees exactly the
 * messages its loop produced.
 */
export function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}
