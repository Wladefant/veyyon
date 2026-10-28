import { emptyUsage } from "@veyyon/catalog/models";
export function makeAssistantMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}
