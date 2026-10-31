import type { AgentTool } from "@veyyon/agent-core";
import { type } from "arktype";

/** A tool named `name` that takes no parameters and answers every call with the text `ok`. */
export function createOkTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}
