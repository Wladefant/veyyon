import type { AgentMessage } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, Model, UserMessage } from "@veyyon/ai";
import { emptyUsage, type GeneratedProvider, getBundledModel } from "@veyyon/catalog/models";

export function createUserMessage(text: string, timestamp = Date.now()): UserMessage {
	return { role: "user", content: text, timestamp };
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

/** An assistant message that replies with one text block and stops. */
export function createAssistantText(text: string): AssistantMessage {
	return createAssistantMessage([{ type: "text", text }]);
}

/**
 * A `convertToLlm` that passes every user, assistant and tool-result message through unchanged and
 * drops the rest. Unlike the agent's default it keeps a provider refusal, so a suite sees exactly the
 * messages its loop produced.
 */
export function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

/** A model from the bundled catalog that a suite depends on; a model the catalog no longer ships fails the suite here. */
export function requireBundledModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`The bundled catalog has no ${provider}/${id} model`);
	return model;
}
