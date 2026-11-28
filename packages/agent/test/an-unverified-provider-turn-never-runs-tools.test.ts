// A complete-looking tool block does not prove the stream completed. Drive the real
// decoders and agent dispatcher; only fetch is replaced. This does not verify live
// serving identities or provider availability.
import { expect, test } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { Context, FetchImpl, SimpleStreamOptions } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const partial = "Partial answer";
const followUp = "Tool ran";
const toolName = "echo";
const args = { value: "offline" };
const modelSpec = {
	name: "Synthetic test model",
	baseUrl: "https://offline.invalid/v1",
	input: ["text" as const],
	contextWindow: 8192,
	maxTokens: 2048,
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const responses = buildModel({ ...modelSpec, id: "gpt-test", api: "openai-responses", provider: "openai" });
const google = buildModel({ ...modelSpec, id: "gemini-4-hydrogen", api: "google-generative-ai", provider: "google" });
const cli = buildModel({ ...modelSpec, id: "gemini-4-hydrogen-xhigh", api: "google-gemini-cli", provider: "google-antigravity" });
const schemas = z.object({ value: z.string() });

type Ending = "complete" | "eof" | "mismatched model" | "incomplete response" | "incomplete event";

function responsesFrames(ending: Ending, follow: boolean): unknown[] {
	const item = { id: "msg_1", type: "message", role: "assistant", content: [] };
	const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: toolName };
	return [
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: follow ? followUp : partial },
		{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
		...(follow ? [] : [{
			type: "response.output_item.done",
			output_index: 1,
			item: { ...call, status: "completed", arguments: JSON.stringify(args) },
		}]),
		...(ending === "eof" ? [] : [{
			type: "response.completed",
			...(ending === "incomplete event" ? { incomplete: true } : {}),
			response: {
				id: "resp_1",
				status: "completed",
				model: ending === "mismatched model" ? "gpt-other" : responses.id,
				...(ending === "incomplete response" ? { incomplete: true } : {}),
			},
		}]),
	];
}

function googleFrames(ending: Ending, follow: boolean): unknown[] {
	return [
		{
			modelVersion: google.id,
			candidates: [{ content: { parts: [
				{ text: follow ? followUp : partial },
				...(follow ? [] : [{ functionCall: { name: toolName, args } }]),
			] } }],
		},
		...(ending === "eof" ? [] : [{
			modelVersion: ending === "mismatched model" ? "gemini-4-neon" : google.id,
			candidates: [{ finishReason: "STOP" }],
		}]),
	];
}

const providers = {
	Responses: {
		model: responses,
		frames: responsesFrames,
		stream: (context: Context, options: SimpleStreamOptions) => streamOpenAIResponses(responses, context, { ...options, apiKey: "offline" }),
	},
	Gemini: {
		model: google,
		frames: googleFrames,
		stream: (context: Context, options: SimpleStreamOptions) => streamGoogle(google, context, { ...options, apiKey: "offline" }),
	},
	Antigravity: {
		model: cli,
		frames: (ending: Ending, follow: boolean) => googleFrames(ending, follow).map(response => ({ response })),
		stream: (context: Context, options: SimpleStreamOptions) => streamGoogleGeminiCli(cli, context, {
			...options,
			apiKey: JSON.stringify({ token: "offline", projectId: "offline" }),
		}),
	},
};

for (const [name, provider] of Object.entries(providers)) {
	const endings: Ending[] = ["complete", "eof", "mismatched model"];
	if (name === "Responses") endings.push("incomplete response", "incomplete event");
	for (const ending of endings) {
		test(`${name}: ${ending === "complete" ? "dispatches a verified tool call" : `blocks tools after ${ending}`}`, async () => {
			let requests = 0;
			const executions: string[] = [];
			const fetch: FetchImpl = async () => {
				if (++requests > 2) throw new Error("Unexpected provider retry");
				const frames = provider.frames(ending, requests === 2);
				return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			};
			const echo: AgentTool<typeof schemas> = {
				name: toolName,
				label: "Echo",
				description: "Echo a value",
				parameters: schemas,
				async execute(_id, { value }) {
					executions.push(value);
					return { content: [{ type: "text", text: value }] };
				},
			};
			const agent = new Agent({
				initialState: { model: provider.model, tools: [echo] },
				streamFn: (_model, context, options) => provider.stream(context, { ...options, fetch }),
			});
			await agent.prompt("Echo a value");

			const messages = agent.state.messages.filter(message => message.role === "assistant");
			expect(messages[0]?.content).toContainEqual(expect.objectContaining({ type: "text", text: partial }));
			if (ending === "complete") {
				expect(executions).toEqual([args.value]);
				expect(requests).toBe(2);
				expect(messages.map(message => message.stopReason)).toEqual(["toolUse", "stop"]);
				expect(messages[1]?.content).toContainEqual(expect.objectContaining({ type: "text", text: followUp }));
			} else {
				expect(executions).toEqual([]);
				expect(requests).toBe(1);
				expect(messages.map(message => message.stopReason)).toEqual(["error"]);
			}
		});
	}
}
