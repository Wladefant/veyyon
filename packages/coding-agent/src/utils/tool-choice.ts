import type { Api, KnownApi, Model, ToolChoice } from "@veyyon/ai";

/**
 * The choice that requires one named tool, per API. `tool` and `function` are the two spellings of
 * a named choice; every provider reads both. A wire that cannot force the call sends the
 * requirement as request text, so every API but Google's names the tool. Google's three APIs
 * require any tool.
 */
const NAMED_TOOL_CHOICE: Record<KnownApi, "tool" | "function" | "required"> = {
	"anthropic-messages": "tool",
	"bedrock-converse-stream": "tool",
	"openai-codex-responses": "function",
	"openai-responses": "function",
	"openai-completions": "function",
	"azure-openai-responses": "function",
	openrouter: "function",
	"ollama-chat": "function",
	"google-generative-ai": "required",
	"google-gemini-cli": "required",
	"google-vertex": "required",
	"cursor-agent": "tool",
	"devin-agent": "tool",
	"gitlab-duo-agent": "tool",
};

/**
 * Build a provider-aware tool choice that targets one specific tool. Returns `undefined` for an
 * API no built-in provider implements.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model || !Object.hasOwn(NAMED_TOOL_CHOICE, model.api)) return undefined;
	const form = NAMED_TOOL_CHOICE[model.api as KnownApi];
	if (form === "required") return "required";
	return form === "tool" ? { type: "tool", name: toolName } : { type: "function", name: toolName };
}

/**
 * Whether the given tool choice can be satisfied by the active tool set for the
 * upcoming turn. Non-named choices (`"none"`, `"required"`, etc.) do not name a
 * specific tool and are therefore always active.
 */
export function isToolChoiceActive(toolChoice: ToolChoice | undefined, tools: readonly { name: string }[]): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}
