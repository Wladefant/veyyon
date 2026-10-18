/**
 * Streaming half of the auth-gateway's OpenAI Responses bridge: veyyon's
 * {@link AssistantMessageEventStream} written as the documented `response.*` SSE taxonomy.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses-streaming
 */

import { errorMessage } from "@veyyon/utils/type-guards";
import type { AuthGatewayParsedRequest, AuthGatewayStreamControl, FrameSink } from "../auth-gateway/types";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ComputerAction,
	ComputerSafetyCheck,
	ToolCall,
} from "../types";
import {
	buildOutputItems,
	buildUsage,
	customToolCallItem,
	failedMessageError,
	functionCallItem,
	type MessageSignature,
	makeCustomCallId,
	makeFuncCallId,
	makeMsgId,
	makeReasoningId,
	makeRespId,
	type OutputItem,
	type OutputText,
	type ResponseStatus,
	reasoningItemId,
	responseEnvelope,
	responseStatusForStopReason,
	sameMessageSignature,
	wireCallId,
} from "./openai-responses-server-output";
import { parseTextSignature } from "./openai-shared";

interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: OutputText[];
	signature?: MessageSignature;
}
interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	reasoningText: string;
}
interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	name: string;
	argsText: string;
	/** Set when the underlying ToolCall is a custom-tool emission. */
	customWireName?: string;
}
interface OpenComputerCall {
	kind: "computer_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}
type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall | OpenComputerCall;

const TERMINAL_EVENT: Record<ResponseStatus, string> = {
	completed: "response.completed",
	in_progress: "response.completed",
	incomplete: "response.incomplete",
	failed: "response.failed",
};

function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The SSE frames for one response. {@link apply} takes the events in stream order; {@link finish}
 * or {@link fail} writes the terminal event and `[DONE]`.
 *
 * At most one message or reasoning item is open at a time. A tool call opened beside it leaves it open,
 * and every open item is found by the content index its events carry, so interleaved events each reach their own item.
 */
class ResponsesStreamWriter {
	readonly #sink: FrameSink;
	readonly #responseId: string;
	readonly #model: string;
	#sequence = 0;
	#createdAt = Math.floor(Date.now() / 1000);
	#outputIndex = 0;
	/** Every open item, keyed by the content index its events arrive under. */
	readonly #openItems = new Map<number, OpenItem>();
	/** The one open message or reasoning item. Opening another prose item closes it first. */
	#openProse: OpenMessage | OpenReasoning | null = null;
	readonly #finished: OutputItem[] = [];
	#final: AssistantMessage | undefined;
	#failure: AssistantMessage | undefined;

	constructor(sink: FrameSink, responseId: string, model: string) {
		this.#sink = sink;
		this.#responseId = responseId;
		this.#model = model;
	}

	apply(ev: AssistantMessageEvent): void {
		switch (ev.type) {
			case "start":
				return this.#start(ev.partial);
			case "text_start":
				return this.#textStart(ev.partial, ev.contentIndex);
			case "text_delta":
				return this.#textDelta(ev.contentIndex, ev.delta);
			case "text_end":
				return this.#textEnd(ev.contentIndex, ev.content);
			case "thinking_start":
				return this.#thinkingStart(ev.partial, ev.contentIndex);
			case "thinking_delta":
				return this.#thinkingDelta(ev.contentIndex, ev.delta);
			case "thinking_end":
				return this.#thinkingEnd(ev.contentIndex, ev.content);
			case "toolcall_start":
				return this.#toolCallStart(ev.partial, ev.contentIndex);
			case "toolcall_delta":
				return this.#toolCallDelta(ev.contentIndex, ev.delta);
			case "toolcall_end":
				return this.#toolCallEnd(ev.contentIndex, ev.toolCall);
			case "done":
				this.#final = ev.message;
				return;
			case "error":
				this.#failure = ev.error;
				return;
		}
	}

	/**
	 * Close every open item and write the terminal event: `response.failed` for an `error` event, a
	 * rejected result or a stream that ended without a final message, and otherwise the event the
	 * final message's stop reason selects, carrying the items built from that message.
	 */
	async finish(events: AssistantMessageEventStream): Promise<void> {
		this.#closeAll();
		if (this.#failure) return this.#failWith(this.#failure.errorMessage ?? "stream failed");
		// A stream that produced no `done` event is asked for its result, and a rejection there is a
		// failure like any other: a generation that failed after emitting some text must not reach the
		// client as a completed response with partial content.
		let resultFailure: string | undefined;
		const message =
			this.#final ??
			((await events.result().catch((error: unknown) => {
				resultFailure = errorMessage(error);
				return null;
			})) as AssistantMessage | null);
		if (!message) return this.#failWith(resultFailure ?? "stream ended without a final message");
		// Build the canonical output from the final message so non-streaming
		// readers see the exact same shape they'd get from encodeResponse().
		const output = buildOutputItems(message);
		const usage = buildUsage(message);
		const status = responseStatusForStopReason(message);
		this.#terminal(
			TERMINAL_EVENT[status],
			responseEnvelope({
				id: this.#responseId,
				createdAt: this.#createdAt,
				status,
				model: this.#model,
				output,
				usage,
				error: failedMessageError(message, status),
			}),
		);
	}

	/** The stream itself threw: report the error with no items. */
	fail(error: unknown): void {
		this.#terminal("response.failed", {
			id: this.#responseId,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "failed",
			model: this.#model,
			output: [],
			error: { message: errorMessage(error) },
			incomplete_details: null,
		});
	}

	#failWith(message: string): void {
		this.#terminal(
			"response.failed",
			responseEnvelope({
				id: this.#responseId,
				createdAt: this.#createdAt,
				status: "failed",
				model: this.#model,
				output: this.#finished,
				usage: null,
				error: message,
			}),
		);
	}

	#emit(name: string, data: Record<string, unknown>): void {
		if (this.#sink.cancelled) return;
		this.#sink.enqueue(sseEvent(name, { type: name, sequence_number: this.#sequence++, ...data }));
	}

	#terminal(name: string, response: Record<string, unknown>): void {
		this.#sink.enqueue(sseEvent(name, { type: name, sequence_number: this.#sequence++, response }));
		if (!this.#sink.cancelled) this.#sink.enqueue("data: [DONE]\n\n");
	}

	#snapshot(): Record<string, unknown> {
		return responseEnvelope({
			id: this.#responseId,
			createdAt: this.#createdAt,
			status: "in_progress",
			model: this.#model,
			output: [],
			usage: null,
		});
	}

	#start(partial: AssistantMessage): void {
		this.#createdAt = Math.floor((partial.timestamp || Date.now()) / 1000);
		this.#emit("response.created", { response: this.#snapshot() });
		// Mirrors real OpenAI; some clients gate on it before reading items.
		this.#emit("response.in_progress", { response: this.#snapshot() });
	}

	/** Close the open message or reasoning item before another one opens. An open tool call stays open. */
	#closeOpenProse(): void {
		if (this.#openProse) this.#closeProse(this.#openProse);
	}

	#textStart(partial: AssistantMessage, contentIndex: number): void {
		const block = partial.content[contentIndex];
		const signature = block?.type === "text" ? parseTextSignature(block.textSignature) : undefined;
		let cur: OpenMessage;
		if (this.#openProse?.kind === "message" && sameMessageSignature(this.#openProse.signature, signature)) {
			// Continue the same message item with a new content part.
			cur = this.#openProse;
			cur.currentPartText = "";
			this.#openItems.set(contentIndex, cur);
		} else {
			this.#closeOpenProse();
			cur = this.#openMessage(signature, contentIndex);
		}
		this.#emit("response.content_part.added", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			content_index: cur.contentIndex,
			part: { type: "output_text", text: "", annotations: [] },
		});
	}

	#openMessage(signature: MessageSignature | undefined, contentIndex: number): OpenMessage {
		const outputIndex = this.#outputIndex++;
		const itemId = signature?.id ?? makeMsgId();
		const phase = signature?.phase ? { phase: signature.phase } : {};
		const item = { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [], ...phase };
		this.#emit("response.output_item.added", { output_index: outputIndex, item });
		const next: OpenMessage = {
			kind: "message",
			itemId,
			outputIndex,
			contentIndex: 0,
			currentPartText: "",
			content: [],
			...(signature ? { signature } : {}),
		};
		this.#openProse = next;
		this.#openItems.set(contentIndex, next);
		return next;
	}

	#textDelta(contentIndex: number, delta: string): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind !== "message") return;
		cur.currentPartText += delta;
		this.#emit("response.output_text.delta", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			content_index: cur.contentIndex,
			delta,
			logprobs: [],
		});
		// TODO: when pi-ai surfaces output_text annotations
		// (web_search citations, …), emit
		// `response.output_text.annotation.added` here.
	}

	#textEnd(contentIndex: number, content: string | undefined): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind !== "message") return;
		const text = content ?? cur.currentPartText;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex, content_index: cur.contentIndex };
		this.#emit("response.output_text.done", { ...where, text, logprobs: [] });
		cur.content.push({ type: "output_text", text, annotations: [] });
		this.#emit("response.content_part.done", { ...where, part: { type: "output_text", text, annotations: [] } });
		cur.contentIndex += 1;
		cur.currentPartText = "";
	}

	#thinkingStart(partial: AssistantMessage, contentIndex: number): void {
		this.#closeOpenProse();
		const outputIndex = this.#outputIndex++;
		const part = partial.content[contentIndex];
		const itemId = part?.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
		this.#emit("response.output_item.added", {
			output_index: outputIndex,
			item: { type: "reasoning", id: itemId, summary: [] },
		});
		// Open the summary part. Real OpenAI streams summary text in the
		// canonical `reasoning_summary_*` lifecycle; pi-ai's own decoder
		// reads `summary[].text` from the eventual `output_item.done`.
		this.#emit("response.reasoning_summary_part.added", {
			item_id: itemId,
			output_index: outputIndex,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		});
		const next: OpenReasoning = { kind: "reasoning", itemId, outputIndex, reasoningText: "" };
		this.#openProse = next;
		this.#openItems.set(contentIndex, next);
	}

	#thinkingDelta(contentIndex: number, delta: string): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind !== "reasoning") return;
		cur.reasoningText += delta;
		this.#emit("response.reasoning_summary_text.delta", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			summary_index: 0,
			delta,
		});
	}

	#thinkingEnd(contentIndex: number, content: string | undefined): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind !== "reasoning") return;
		const text = content ?? cur.reasoningText;
		cur.reasoningText = text;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex, summary_index: 0 };
		this.#emit("response.reasoning_summary_text.done", { ...where, text });
		this.#emit("response.reasoning_summary_part.done", { ...where, part: { type: "summary_text", text } });
		this.#closeProse(cur);
	}

	#toolCallStart(partial: AssistantMessage, contentIndex: number): void {
		const outputIndex = this.#outputIndex++;
		const part = partial.content[contentIndex];
		const tc = part?.type === "toolCall" ? part : undefined;
		if (tc?.providerMetadata?.type === "computer") {
			const metadata = tc.providerMetadata;
			const callId = wireCallId(tc.id);
			this.#emit("response.output_item.added", {
				output_index: outputIndex,
				item: {
					type: "computer_call",
					id: metadata.providerItemId,
					call_id: callId,
					actions: metadata.actions,
					pending_safety_checks: metadata.pendingSafetyChecks,
					status: "in_progress",
				},
			});
			this.#openItems.set(contentIndex, {
				kind: "computer_call",
				itemId: metadata.providerItemId,
				outputIndex,
				contentIndex,
				callId,
				actions: metadata.actions,
				pendingSafetyChecks: metadata.pendingSafetyChecks,
			});
			return;
		}
		const customWireName = tc?.customWireName || undefined;
		const itemId = tc?.thoughtSignature ?? (customWireName !== undefined ? makeCustomCallId() : makeFuncCallId());
		const callId = wireCallId(tc?.id ?? "");
		const name = customWireName ?? tc?.name ?? "";
		const item =
			customWireName !== undefined
				? { type: "custom_tool_call", id: itemId, call_id: callId, name, input: "", status: "in_progress" }
				: { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" };
		this.#emit("response.output_item.added", { output_index: outputIndex, item });
		this.#openItems.set(contentIndex, {
			kind: "function_call",
			itemId,
			outputIndex,
			contentIndex,
			callId,
			name,
			argsText: "",
			...(customWireName !== undefined ? { customWireName } : {}),
		});
	}

	#toolCallDelta(contentIndex: number, delta: string): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind !== "function_call") return;
		cur.argsText += delta;
		const name = cur.customWireName
			? "response.custom_tool_call_input.delta"
			: "response.function_call_arguments.delta";
		this.#emit(name, { item_id: cur.itemId, output_index: cur.outputIndex, delta });
	}

	#toolCallEnd(contentIndex: number, tc: ToolCall): void {
		const cur = this.#openItems.get(contentIndex);
		if (cur?.kind === "computer_call") {
			cur.callId = wireCallId(tc.id);
			const metadata = tc.providerMetadata;
			if (metadata?.type === "computer") {
				cur.itemId = metadata.providerItemId;
				cur.actions = metadata.actions;
				cur.pendingSafetyChecks = metadata.pendingSafetyChecks;
			}
			this.#closeCall(cur);
			return;
		}
		if (cur?.kind !== "function_call") return;
		// Promote possibly-late info from the canonical ToolCall.
		if (tc.customWireName && !cur.customWireName) cur.customWireName = tc.customWireName;
		if (tc.thoughtSignature) cur.itemId = tc.thoughtSignature;
		cur.callId = wireCallId(tc.id);
		cur.name = cur.customWireName ?? tc.name;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex };
		if (cur.customWireName) {
			// Custom tool: raw input string. Streamed deltas accumulated the wire-level body; fall back to
			// `arguments.input` from the finalized ToolCall when nothing streamed (rare).
			const input = tc.arguments?.input;
			cur.argsText ||= typeof input === "string" ? input : "";
			this.#emit("response.custom_tool_call_input.done", { ...where, input: cur.argsText, name: cur.name });
		} else {
			// Standard JSON tool: arguments object on the veyyon side, the wire wants the JSON string the
			// model emitted (= streamed deltas).
			cur.argsText ||= JSON.stringify(tc.arguments ?? {});
			this.#emit("response.function_call_arguments.done", { ...where, arguments: cur.argsText, name: cur.name });
		}
		this.#closeCall(cur);
	}

	/** Every open item, closed in the order it opened. */
	#closeAll(): void {
		for (const item of new Set(this.#openItems.values())) {
			if (item.kind === "function_call" || item.kind === "computer_call") this.#closeCall(item);
			else this.#closeProse(item);
		}
	}

	/** Drop an item from the open set: every content index it was reached by, and the prose slot. */
	#forget(item: OpenItem): void {
		for (const [contentIndex, candidate] of this.#openItems) {
			if (candidate === item) this.#openItems.delete(contentIndex);
		}
		if (this.#openProse === item) this.#openProse = null;
	}

	#closeCall(call: OpenFunctionCall | OpenComputerCall): void {
		let item: OutputItem;
		if (call.kind === "computer_call") {
			item = {
				type: "computer_call",
				id: call.itemId,
				call_id: call.callId,
				actions: call.actions,
				pending_safety_checks: call.pendingSafetyChecks,
				status: "completed",
			};
		} else {
			item = call.customWireName
				? customToolCallItem(call.itemId, call.callId, call.customWireName, call.argsText)
				: functionCallItem(call.itemId, call.callId, call.name, call.argsText);
		}
		this.#forget(call);
		this.#emit("response.output_item.done", { output_index: call.outputIndex, item });
		this.#finished.push(item);
	}

	#closeProse(open: OpenMessage | OpenReasoning): void {
		this.#forget(open);
		const item: OutputItem =
			open.kind === "message"
				? {
						type: "message",
						id: open.itemId,
						status: "completed",
						role: "assistant",
						content: open.content,
						...(open.signature?.phase ? { phase: open.signature.phase } : {}),
					}
				: { type: "reasoning", id: open.itemId, summary: [{ type: "summary_text", text: open.reasoningText }] };
		this.#emit("response.output_item.done", { output_index: open.outputIndex, item });
		this.#finished.push(item);
	}
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	_options?: AuthGatewayParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const sink: FrameSink = {
				get cancelled() {
					return cancelled;
				},
				enqueue: frame => controller.enqueue(encoder.encode(frame)),
			};
			const writer = new ResponsesStreamWriter(sink, responseId, requestedModelId);
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const ev of events) {
					if (cancelled) return;
					writer.apply(ev);
				}
				await writer.finish(events);
				controller.close();
			} catch (err) {
				if (!cancelled) {
					writer.fail(err);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}
