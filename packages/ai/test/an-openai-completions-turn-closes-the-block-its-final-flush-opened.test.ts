/**
 * WHY: bytes the stream holds back until the turn ends must land in a block that is closed exactly
 * once, and the block they close must not be closed twice.
 *
 * The OpenAI-compatible stream withholds visible text in two places until it can decide what the
 * bytes are: the markup healer keeps `<thi` because it may open `<think>`, and the DeepSeek filter
 * keeps a trailing partial special token. Both release those bytes at finalization, and releasing
 * text can open a new text block and close the block that was current. Finalization then closes
 * "the current block". When that step read a copy of the current block taken before the flush, it
 * closed the block the flush had already closed (a second `thinking_end`) and never closed the text
 * block the flush opened (a `text_start` with no `text_end`), so a consumer that tracks block
 * lifecycles kept the answer open forever.
 *
 * The class: an end-of-stream step that decides what to close from state read before a step that
 * can change it. The sweep below drives the real provider over SSE from every block kind that can
 * be current when the held bytes are released, and asserts the lifecycle invariant on the emitted
 * event sequence rather than on one event.
 *
 * What it does not catch: the DSML and Kimi healer grammars, which are selected by model identity
 * and hold different markers; the invariant is the same, but no case here reaches them.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const context: Context = { messages: [{ role: "user", content: "Continue the task.", timestamp: 0 }] };

function openRouterModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<"openai-completions">;
}

function deepseekModel(): Model<"openai-completions"> {
	return buildModel({
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<"openai-completions">;
}

function sse(chunks: unknown[]): FetchImpl {
	return () =>
		Promise.resolve(
			new Response(`${chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
}

async function run(
	model: Model<"openai-completions">,
	chunks: unknown[],
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: sse(chunks) });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

type Phase = "start" | "end";
const LIFECYCLE: Record<string, Phase> = {
	text_start: "start",
	text_end: "end",
	thinking_start: "start",
	thinking_end: "end",
	toolcall_start: "start",
	toolcall_end: "end",
};

/**
 * Every content index the turn opened is closed exactly once, after it opened, and every block in
 * the final message was opened. Returns the violations so a failure names the index and the phase.
 */
function lifecycleViolations(events: AssistantMessageEvent[], message: AssistantMessage): string[] {
	const opened = new Map<number, number>();
	const closed = new Map<number, number>();
	const violations: string[] = [];
	for (const event of events) {
		const phase = LIFECYCLE[event.type];
		if (!phase || !("contentIndex" in event) || typeof event.contentIndex !== "number") continue;
		const index = event.contentIndex;
		if (phase === "start") {
			opened.set(index, (opened.get(index) ?? 0) + 1);
		} else {
			if (!opened.has(index)) violations.push(`${event.type} for unopened index ${index}`);
			closed.set(index, (closed.get(index) ?? 0) + 1);
		}
	}
	for (const [index, count] of opened) {
		if (count !== 1) violations.push(`index ${index} opened ${count} times`);
		const ends = closed.get(index) ?? 0;
		if (ends !== 1) violations.push(`index ${index} closed ${ends} times`);
	}
	for (let index = 0; index < message.content.length; index++) {
		if (message.content[index]!.type === "redactedThinking") continue;
		if (!opened.has(index)) violations.push(`index ${index} in the message was never opened`);
	}
	return violations;
}

const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const content = (text: string) => ({ choices: [{ index: 0, delta: { content: text } }] });
const reasoning = (text: string) => ({ choices: [{ index: 0, delta: { reasoning_content: text } }] });
const toolCall = {
	choices: [
		{
			index: 0,
			delta: {
				tool_calls: [
					{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
				],
			},
		},
	],
};

/**
 * One case per block kind that can be current when the held bytes are released. `text` is the
 * visible text the turn ends with, so it proves the held bytes were released and placed.
 */
const cases: { name: string; model: () => Model<"openai-completions">; chunks: unknown[]; text: string }[] = [
	{
		name: "a healer hold released after nothing else streamed",
		model: openRouterModel,
		chunks: [content("<thi"), finish],
		text: "<thi",
	},
	{
		name: "a healer hold released after a thinking block",
		model: openRouterModel,
		chunks: [reasoning("plan the answer"), content("<thi"), finish],
		text: "<thi",
	},
	{
		name: "a healer hold released after a tool call",
		model: openRouterModel,
		chunks: [toolCall, content("<thi"), finish],
		text: "<thi",
	},
	{
		name: "a healer hold released onto a text block already open",
		model: openRouterModel,
		chunks: [content("answer"), content("<thi"), finish],
		text: "answer<thi",
	},
	{
		name: "a DeepSeek partial special token released after a thinking block",
		model: deepseekModel,
		chunks: [reasoning("plan the answer"), content("<｜"), finish],
		text: "<｜",
	},
];

describe("an OpenAI-compatible turn closes the block its final flush opened", () => {
	for (const testCase of cases) {
		it(`keeps every block lifecycle whole for ${testCase.name}`, async () => {
			const { events, message } = await run(testCase.model(), testCase.chunks);

			const textBlocks = message.content.filter(block => block.type === "text");
			expect(textBlocks.map(block => (block.type === "text" ? block.text : ""))).toEqual([testCase.text]);
			expect(lifecycleViolations(events, message)).toEqual([]);
		});
	}
});
