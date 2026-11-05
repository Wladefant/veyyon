/**
 * The Anthropic `tool_choice` a request sends for a provider-neutral {@link ToolChoice}. The Anthropic
 * stream, GitLab Duo's Anthropic proxy and the OpenAI/Anthropic shim read it from here, so none of
 * them imports the stream dispatcher that loads them.
 */

import type { ToolChoice } from "../types";
import type { AnthropicOptions } from "./anthropic";

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}
