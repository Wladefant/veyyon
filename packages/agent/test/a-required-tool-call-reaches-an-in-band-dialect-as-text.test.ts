/**
 * WHY THIS SUITE EXISTS. Under an owned in-band dialect the loop renders the tool
 * catalog into the system prompt and sends no native `tools`, so it also sends no
 * `tool_choice`: a forced choice there would be rejected. A caller that required a
 * call (an executor's `yield`, a guided goal) therefore lost the requirement, and
 * the model was free to answer in prose.
 *
 * THE CONTRACT. A required call under an owned dialect reaches the provider as an
 * instruction in the conversation and never as a native `tool_choice`; a native
 * turn keeps the native field and carries no instruction.
 *
 * NOT CAUGHT. Each provider's own handling of a native `tool_choice`, which
 * `a-tool-call-the-wire-cannot-force-is-asked-for-in-the-request.test.ts` in
 * `@veyyon/ai` sweeps.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentTool } from "@veyyon/agent-core/types";
import type { Context, SimpleStreamOptions, ToolChoice } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage, identityConverter } from "./helpers";

const INSTRUCTION = "This turn must call the `echo` tool.";

const schema = type({ msg: "string" });
const echoTool: AgentTool<typeof schema, { msg: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo a message back",
	parameters: schema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
	},
};

interface Captured {
	readonly context: Context;
	readonly toolChoice: ToolChoice | undefined;
}

async function firstRequest(dialect: AgentLoopConfig["dialect"], toolChoice: ToolChoice): Promise<Captured> {
	const captured: Captured[] = [];
	const mock = createMockModel({
		responses: [
			(context: Context, options?: SimpleStreamOptions) => {
				captured.push({ context, toolChoice: options?.toolChoice });
				return { content: ["done"] };
			},
		],
	});
	const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, dialect, toolChoice };
	await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();
	expect(captured).toHaveLength(1);
	return captured[0];
}

describe("a required tool call reaches an in-band dialect as text", () => {
	it("asks for the call in the conversation and sends no native tool_choice", async () => {
		const { context, toolChoice } = await firstRequest("glm", { type: "tool", name: "echo" });
		expect(toolChoice).toBeUndefined();
		expect(context.tools).toBeUndefined();
		expect(JSON.stringify(context.messages).split(INSTRUCTION).length - 1).toBe(1);
	});

	it("keeps the native tool_choice and asks for nothing on a native turn", async () => {
		const { context, toolChoice } = await firstRequest(undefined, { type: "tool", name: "echo" });
		expect(toolChoice).toEqual({ type: "tool", name: "echo" });
		expect(JSON.stringify(context.messages)).not.toContain(INSTRUCTION);
	});

	it("asks for nothing under the dialect when the call is optional", async () => {
		const { context, toolChoice } = await firstRequest("glm", "auto");
		expect(toolChoice).toBeUndefined();
		expect(JSON.stringify(context.messages)).not.toContain("This turn must call");
	});
});
