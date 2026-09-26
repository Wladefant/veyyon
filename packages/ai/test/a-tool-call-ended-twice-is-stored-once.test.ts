/**
 * WHY. Every non-official provider stream is re-projected before the agent loop reads it: through
 * `wrapLeakedThinkingStream` always, and through `wrapInbandToolStream` as well in owned-dialect
 * mode. Both projectors map a source content index to the block they emitted for it. Each deleted
 * that mapping on the first `toolcall_end`, so a second `toolcall_end` for the same index found
 * nothing and was projected as a brand-new block.
 *
 * Cursor ends every exec-channel call twice: `synthesizeCursorExecToolCall` emits start+end when the
 * server asks the process to run the tool, and the `toolCallCompleted` update ends the same block
 * again. Every such call was therefore stored twice in the assistant message. The copy never
 * received a result, the session recorded it as a pending call, and resume listed dozens of them.
 *
 * The class this closes: one source index yields exactly one projected block, however many times the
 * source ends it, on every projector, whether or not the block was started before its first end.
 *
 * What this suite does NOT catch: a provider that reuses one content index for two different calls,
 * which the stream contract rules out, or a duplicate a provider puts into its own `output.content`
 * before any projector sees it.
 */
import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	createCursorUsageAccount,
	processInteractionUpdate,
	synthesizeCursorExecToolCall,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "@veyyon/ai/types";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { wrapLeakedThinkingStream } from "@veyyon/ai/utils/leaked-thinking-stream";
import { wrapInbandToolStream } from "../src/dialect/owned-stream";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** Every projector a provider stream passes through on its way to the agent loop. */
const PROJECTORS: Record<string, (inner: AssistantMessageEventStream) => AssistantMessageEventStream> = {
	wrapLeakedThinkingStream: inner => wrapLeakedThinkingStream(inner),
	wrapInbandToolStream: inner => wrapInbandToolStream(inner, [], "glm"),
};

type Feed = (push: (event: AssistantMessageEvent) => void, output: AssistantMessage) => void;

async function project(
	wrap: (inner: AssistantMessageEventStream) => AssistantMessageEventStream,
	feed: Feed,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const inner = new AssistantMessageEventStream();
	const output = assistant();
	const out = wrap(inner);
	inner.push({ type: "start", partial: output });
	feed(event => inner.push(event), output);
	inner.push({ type: "done", reason: "toolUse", message: output });
	inner.end(output);
	const events: AssistantMessageEvent[] = [];
	for await (const event of out) events.push(event);
	return { events, result: await out.result() };
}

function toolIds(message: AssistantMessage): string[] {
	return message.content.filter((b): b is ToolCall => b.type === "toolCall").map(b => b.id);
}

function endIndices(events: AssistantMessageEvent[]): number[] {
	return events.flatMap(e => (e.type === "toolcall_end" ? [e.contentIndex] : []));
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

describe("a tool call its provider ends twice", () => {
	for (const [name, wrap] of Object.entries(PROJECTORS)) {
		describe(name, () => {
			it("is one block when it was started first", async () => {
				const { events, result } = await project(wrap, (push, output) => {
					const block = call("call-read", "read", { path: "src/app.ts" });
					output.content.push(block);
					push({ type: "toolcall_start", contentIndex: 0, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
				});

				expect(toolIds(result)).toEqual(["call-read"]);
				// Both ends point at the one block, so a consumer keyed by index sees one call.
				expect(endIndices(events)).toEqual([0, 0]);
			});

			it("is one block when it was never started", async () => {
				const { events, result } = await project(wrap, (push, output) => {
					const block = call("call-read", "read", { path: "src/app.ts" });
					output.content.push(block);
					push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
				});

				expect(toolIds(result)).toEqual(["call-read"]);
				expect(endIndices(events)).toEqual([0, 0]);
			});

			it("takes the arguments of the last end", async () => {
				const { result } = await project(wrap, (push, output) => {
					const block = call("call-read", "read", { path: "src/app.ts" });
					output.content.push(block);
					push({ type: "toolcall_start", contentIndex: 0, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
					const completed = call("call-read", "read", { path: "src/app.ts", limit: 40 });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: completed, partial: output });
				});

				const blocks = result.content.filter((b): b is ToolCall => b.type === "toolCall");
				expect(blocks.map(b => b.arguments)).toEqual([{ path: "src/app.ts", limit: 40 }]);
			});

			it("keeps distinct calls distinct and in order", async () => {
				const { result } = await project(wrap, (push, output) => {
					const first = call("call-a", "read", { path: "a.ts" });
					const second = call("call-b", "grep", { pattern: "x" });
					output.content.push(first);
					push({ type: "toolcall_start", contentIndex: 0, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: output });
					output.content.push(second);
					push({ type: "toolcall_start", contentIndex: 1, partial: output });
					push({ type: "toolcall_end", contentIndex: 1, toolCall: second, partial: output });
					push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: output });
					push({ type: "toolcall_end", contentIndex: 1, toolCall: second, partial: output });
				});

				expect(toolIds(result)).toEqual(["call-a", "call-b"]);
			});
		});
	}
});

function cursorState(output: AssistantMessage): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		usage: createCursorUsageAccount(
			{
				id: "cursor-composer-2.5",
				provider: "cursor",
				api: "cursor-agent",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<"cursor-agent">,
			output,
		),
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		execDispatches: new Map(),
	};
}

describe("a Cursor exec-channel call reported completed", () => {
	it("reaches the agent loop as one resolved block", async () => {
		const inner = new AssistantMessageEventStream();
		const output = { ...assistant(), api: "cursor-agent", provider: "cursor" } as AssistantMessage;
		const state = cursorState(output);
		const out = wrapLeakedThinkingStream(inner);

		inner.push({ type: "start", partial: output });
		// The exec channel asks this process to run the read.
		synthesizeCursorExecToolCall(output, inner, state, "call-read", "read", { path: "src/app.ts" });
		// The server then reports the same call completed, which ends its block a second time.
		processInteractionUpdate(
			{
				message: {
					case: "toolCallCompleted",
					value: {
						callId: "call-read",
						toolCall: { tool: { case: "readToolCall", value: { args: { path: "src/app.ts" } } } },
					},
				},
			},
			output,
			inner,
			state,
		);
		inner.push({ type: "done", reason: "toolUse", message: output });
		inner.end(output);

		const result = await out.result();
		const blocks = result.content.filter(b => b.type === "toolCall") as (ToolCall & CursorExecResolvedCarrier)[];
		expect(blocks.map(b => b.id)).toEqual(["call-read"]);
		// The loop skips a resolved block; the projected copy must keep the stamp or the tool runs twice.
		expect(blocks[0]?.[kCursorExecResolved]).toBe(true);
	});
});
