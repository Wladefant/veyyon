/**
 * WHY: every outbound request passes through `ProviderContextCanonicalizer`, which renames
 * provider tool-call ids to short `tc_<n>` handles. An OpenAI Responses assistant message also
 * records its calls in a native `openaiResponsesHistory` payload, and the Responses request
 * builders replay those items verbatim, with the provider's `call_id`, instead of re-encoding the
 * blocks. Renaming the result's id while the replayed call kept the original left every result
 * answering a call the request did not contain: the Codex builder folded each one into a
 * stale-output note and sent a "No tool output was recorded" placeholder for the call, on every
 * turn of every session.
 *
 * CLASS CLOSED: a call bound by a native payload keeps its id through the canonicalizer, and so
 * does its result, so both native-replay builders (Codex and OpenAI Responses) pair each result
 * with its replayed call. Calls outside a payload still take a handle, and the handle namespace
 * stays unambiguous when a provider emits an id shaped like one.
 *
 * GAP: a future payload type that binds ids under a field other than `call_id` is not swept; the
 * `ProviderPayload` union has one member today and the canonicalizer reads that member only.
 */
import { describe, expect, it } from "bun:test";
import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import { buildParams } from "@veyyon/ai/providers/openai-responses";
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";

const ROOTS = ["/repo"];

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function canonicalizer(): ProviderContextCanonicalizer {
	let counter = 0;
	return new ProviderContextCanonicalizer(new Map(), () => {
		counter += 1;
		return `tc_${counter}`;
	});
}

/** An assistant turn the way a Responses provider stores it: blocks plus the native items. */
function nativeTurn(model: Model<Api>, calls: Array<{ callId: string; itemId: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(({ callId, itemId }) => ({
			type: "toolCall" as const,
			id: `${callId}|${itemId}`,
			name: "read",
			arguments: { path: callId },
		})),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 1_000,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
				...calls.map(({ callId, itemId }) => ({
					type: "function_call",
					id: itemId,
					call_id: callId,
					name: "read",
					arguments: JSON.stringify({ path: callId }),
				})),
			],
		},
	};
}

function result(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1_001,
	};
}

/** Two native turns, each answered, then the prompt that triggers the next request. */
function history(model: Model<Api>): Message[] {
	return [
		{ role: "user", content: "start", timestamp: 1 },
		nativeTurn(model, [
			{ callId: "call_aaaaaaaaaaaaaaaaaaaaaaaa", itemId: "fc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
			{ callId: "call_bbbbbbbbbbbbbbbbbbbbbbbb", itemId: "fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
		]),
		result("call_aaaaaaaaaaaaaaaaaaaaaaaa|fc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "alpha"),
		result("call_bbbbbbbbbbbbbbbbbbbbbbbb|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "beta"),
		nativeTurn(model, [
			{ callId: "call_cccccccccccccccccccccccc", itemId: "fc_cccccccccccccccccccccccccccccccccccccccccccccccccccc" },
		]),
		result("call_cccccccccccccccccccccccc|fc_cccccccccccccccccccccccccccccccccccccccccccccccccccc", "gamma"),
		{ role: "user", content: "continue", timestamp: 2 },
	];
}

interface WireItem {
	type?: string;
	role?: string;
	call_id?: string;
	output?: unknown;
}

/** Each output in request order with the call it answers, or `undefined` when no call precedes it. */
function pairing(input: WireItem[]): Array<{ output: unknown; answers: string | undefined }> {
	const calls = new Set<string>();
	const pairs: Array<{ output: unknown; answers: string | undefined }> = [];
	for (const item of input) {
		if (item.type === "function_call" && item.call_id) calls.add(item.call_id);
		if (item.type === "function_call_output" && item.call_id) {
			pairs.push({ output: item.output, answers: calls.has(item.call_id) ? item.call_id : undefined });
		}
	}
	return pairs;
}

const EXPECTED_PAIRS = [
	{ output: "alpha", answers: "call_aaaaaaaaaaaaaaaaaaaaaaaa" },
	{ output: "beta", answers: "call_bbbbbbbbbbbbbbbbbbbbbbbb" },
	{ output: "gamma", answers: "call_cccccccccccccccccccccccc" },
];

/** User-role items in the request: the prompts, plus one note per folded result. */
function userItems(input: WireItem[]): number {
	return input.filter(item => item.role === "user").length;
}

describe("a tool result answers the call its native history replays", () => {
	it("Codex replays every result as the output of its own call", async () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		const messages = canonicalizer().transform(history(model), ROOTS).messages;

		const body = await buildTransformedCodexRequestBody(model, { messages }, undefined);
		const input = body.input as WireItem[];

		expect(pairing(input)).toEqual(EXPECTED_PAIRS);
		// The two prompts are the only user items: no result was folded into a note.
		expect(userItems(input)).toBe(2);
	});

	it("OpenAI Responses replays every result as the output of its own call", () => {
		const model = buildModel({
			api: "openai-responses",
			id: "gpt-test",
			name: "GPT Test",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 2048,
			contextWindow: 8192,
			reasoning: true,
		}) as Model<"openai-responses">;
		const messages = canonicalizer().transform(history(model), ROOTS).messages;

		const { params } = buildParams(model, { messages }, undefined, undefined);
		const input = params.input as WireItem[];

		expect(pairing(input)).toEqual(EXPECTED_PAIRS);
		expect(userItems(input)).toBe(2);
	});

	it("a payload-bound call keeps its id while a call outside any payload takes a handle", () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		const plain: AssistantMessage = {
			...nativeTurn(model, [{ callId: "call_dddddddddddddddddddddddd", itemId: "fc_dddd" }]),
			providerPayload: undefined,
		};
		const source: Message[] = [...history(model), plain, result("call_dddddddddddddddddddddddd|fc_dddd", "delta")];

		const out = canonicalizer().transform(source, ROOTS).messages;
		const ids = out.flatMap(message =>
			message.role === "assistant"
				? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
				: message.role === "toolResult"
					? [message.toolCallId]
					: [],
		);

		expect(ids).toEqual([
			"call_aaaaaaaaaaaaaaaaaaaaaaaa|fc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"call_bbbbbbbbbbbbbbbbbbbbbbbb|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"call_aaaaaaaaaaaaaaaaaaaaaaaa|fc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"call_bbbbbbbbbbbbbbbbbbbbbbbb|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"call_cccccccccccccccccccccccc|fc_cccccccccccccccccccccccccccccccccccccccccccccccccccc",
			"call_cccccccccccccccccccccccc|fc_cccccccccccccccccccccccccccccccccccccccccccccccccccc",
			"tc_1",
			"tc_1",
		]);
		// A resumed session rebuilds the same map by walking the same history, so the bytes it
		// sends match the bytes the live session sent and the provider's cached prefix holds.
		expect(canonicalizer().transform(source, ROOTS).messages).toEqual(out);
	});

	it("a call id that merely extends a bound call id is not bound by it", () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		const turn = nativeTurn(model, [{ callId: "call_eeee", itemId: "fc_eeee" }]);
		const extended: AssistantMessage = {
			...turn,
			content: [{ type: "toolCall", id: "call_eeeeX|fc_other", name: "read", arguments: {} }],
		};

		const out = canonicalizer().transform([extended, result("call_eeeeX|fc_other", "x")], ROOTS).messages;

		expect(out.map(message => (message.role === "toolResult" ? message.toolCallId : undefined))).toEqual([
			undefined,
			"tc_1",
		]);
	});

	it("a provider id shaped like a handle is renamed even when a payload binds it", () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		// The first call outside any payload takes `tc_1`; a later native call the provider named
		// `tc_1` must not keep that name, or two different calls would share one id on the wire.
		const plain: AssistantMessage = {
			...nativeTurn(model, [{ callId: "call_ffff", itemId: "fc_ffff" }]),
			providerPayload: undefined,
		};
		const collider = nativeTurn(model, [{ callId: "tc_1", itemId: "fc_gggg" }]);
		const bare: AssistantMessage = {
			...collider,
			content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: {} }],
		};

		const out = canonicalizer().transform(
			[plain, result("call_ffff|fc_ffff", "f"), bare, result("tc_1", "g")],
			ROOTS,
		).messages;
		const resultIds = out.flatMap(message => (message.role === "toolResult" ? [message.toolCallId] : []));

		expect(resultIds).toEqual(["tc_1", "tc_2"]);
	});
});
