import { describe, expect, it } from "bun:test";
import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { createCodexModel } from "./helpers";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
type NativeAssistantOptions = {
	content: AssistantMessage["content"];
	dt?: boolean;
	items?: Array<Record<string, unknown>>;
	modelId?: string;
	provider?: string;
	payloadProvider?: string;
	nativeHistory?: boolean;
};

type WireItem = {
	type?: string;
	call_id?: string;
	output?: string;
	role?: string;
	[key: string]: unknown;
};

function nativeAssistant(
	model: Model<"openai-codex-responses">,
	options: NativeAssistantOptions,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: options.provider ?? model.provider,
		model: options.modelId ?? model.id,
		content: options.content,
		...(options.nativeHistory === false ? {} : {
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: options.payloadProvider ?? model.provider,
				dt: options.dt ?? true,
				items: options.items ?? [],
			},
		}),
		usage: { ...zeroCost, totalTokens: 0, cost: { ...zeroCost, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	} as unknown as AssistantMessage;
}


function result(id: string, name: string, text: string): Context["messages"][number] {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

function nativeFunctionCall(id: string, name = "search"): Record<string, unknown> {
	return { type: "function_call", name, call_id: id, arguments: JSON.stringify({ query: id }) };
}

function nativeCustomCall(id: string, name = "custom"): Record<string, unknown> {
	return { type: "custom_tool_call", name, call_id: id, input: id };
}

function textAndCall(id: string, name = "search"): AssistantMessage["content"] {
	return [{ type: "text", text: "The assistant is continuing the tool workflow." }, { type: "toolCall", id, name, arguments: { query: id } }];
}


describe("native ChatGPT tool history pairing", () => {
	it("keeps a native historical result beside a canonical current call", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const assistant = nativeAssistant(model, {
			dt: true,
			content: textAndCall("call_b"),
			items: [nativeFunctionCall("call_a"), nativeFunctionCall("call_b")],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Resume the tool history.", timestamp: 0 },
				assistant,
				result("call_a", "search", "historical result A"),
				result("call_b", "search", "current result B"),
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		const calls = input.filter(item => item.type === "function_call").map(item => item.call_id);
		const outputs = input.filter(item => item.type === "function_call_output").map(item => [item.call_id, item.output]);
		expect(calls).toEqual(["call_a", "call_b"]);
		expect(outputs).toEqual([
			["call_a", "historical result A"],
			["call_b", "current result B"],
		]);
	});

	it("keeps both results after a native snapshot that replaces an earlier canonical call", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const snapshot = nativeAssistant(model, {
			dt: false,
			content: textAndCall("call_b"),
			items: [nativeFunctionCall("call_a"), nativeFunctionCall("call_b")],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Resume the conversation.", timestamp: 0 },
				nativeAssistant(model, { nativeHistory: false, dt: true, content: textAndCall("call_a") }),
				snapshot,
				result("call_a", "search", "snapshot result A"),
				result("call_b", "search", "snapshot result B"),
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		const calls = input.filter(item => item.type === "function_call").map(item => item.call_id);
		const outputs = input.filter(item => item.type === "function_call_output").map(item => [item.call_id, item.output]);
		expect(calls).toEqual(["call_a", "call_b"]);
		expect(outputs).toEqual([
			["call_a", "snapshot result A"],
			["call_b", "snapshot result B"],
		]);
	});

	it("folds a result whose canonical call is removed by a native snapshot", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const snapshot = nativeAssistant(model, {
			dt: false,
			content: textAndCall("call_a"),
			items: [nativeFunctionCall("call_b")],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Continue after compaction.", timestamp: 0 },
				snapshot,
				result("call_a", "search", "orphaned snapshot result"),
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		expect(input.some(item => item.type === "function_call_output" && item.call_id === "call_a")).toBe(false);
		expect(input.some(item => item.type === "message" && item.role === "user"
			&& JSON.stringify(item).includes("orphaned snapshot result"))).toBe(true);
	});

	it("deduplicates repeated native results and preserves the custom call dialect", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const assistant = nativeAssistant(model, {
			dt: true,
			content: textAndCall("call_b"),
			items: [nativeCustomCall("call_a"), nativeFunctionCall("call_b")],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Resume mixed tool history.", timestamp: 0 },
				assistant,
				result("call_a", "custom", "custom result A"),
				result("call_a", "custom", "duplicate custom result A"),
				result("call_b", "search", "function result B"),
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		const outputs = input.filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output")
			.map(item => [item.type, item.call_id, item.output]);
		expect(outputs).toEqual([
			["custom_tool_call_output", "call_a", "custom result A"],
			["function_call_output", "call_b", "function result B"],
		]);
	});

	it("ignores native history from a different model or provider", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		for (const source of ["model", "provider"] as const) {
			const assistant = nativeAssistant(model, {
				dt: true,
				content: textAndCall("call_b"),
				items: [nativeFunctionCall("call_a"), nativeFunctionCall("call_b")],
				...(source === "model" ? { modelId: "foreign-model" } : {
					provider: "foreign-provider",
					payloadProvider: "different-payload-provider",
				}),
			});
			const context: Context = {
				messages: [
					{ role: "user", content: "Replay only trusted history.", timestamp: 0 },
					assistant,
					result("call_a", "search", "foreign result A"),
					result("call_b", "search", "canonical result B"),
				],
			};

			const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
			expect(input.some(item => item.type === "function_call" && item.call_id === "call_a")).toBe(false);
			expect(input.some(item => item.type === "function_call_output" && item.call_id === "call_a")).toBe(false);
			expect(input.some(item => item.type === "function_call_output" && item.call_id === "call_b")).toBe(true);
		}
	});

	it("synthesizes canonical aborted pair after a native dt:false snapshot", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const snapshot = nativeAssistant(model, {
			dt: false,
			content: [{ type: "text", text: "The assistant preserved the snapshot." }],
			items: [
				nativeFunctionCall("call_snap"),
				{ type: "function_call_output", call_id: "call_snap", output: "snap result" },
			],
		});
		const canonicalAborted = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "toolCall", id: "call_aborted", name: "bash", arguments: { command: "ls" } }],
			stopReason: "aborted",
			timestamp: 1000,
		} as AssistantMessage;
		const context: Context = {
			messages: [
				{ role: "user", content: "Resume from snapshot.", timestamp: 0 },
				snapshot,
				{ role: "user", content: "Run bash command.", timestamp: 500 },
				canonicalAborted,
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		const snapOutput = input.find(item => item.type === "function_call_output" && item.call_id === "call_snap");
		const abortedOutput = input.find(item => item.type === "function_call_output" && item.call_id === "call_aborted");
		expect(snapOutput?.output).toBe("snap result");
		expect(abortedOutput?.output).toBe("aborted");
	});

	it("deduplicates repeated results for a call removed by a native snapshot", async () => {
		const model = createCodexModel("gpt-5.1-codex");
		const snapshot = nativeAssistant(model, {
			dt: false,
			content: textAndCall("call_a"),
			items: [nativeFunctionCall("call_b")],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Continue after compaction.", timestamp: 0 },
				snapshot,
				result("call_a", "search", "orphaned snapshot result"),
				result("call_a", "search", "duplicate orphaned snapshot result"),
			],
		};

		const input = (await buildTransformedCodexRequestBody(model, context, undefined)).input as WireItem[];
		const staleNotes = input.filter(item => item.type === "message" && item.role === "user"
			&& typeof item.content === "string" && item.content.includes("orphaned snapshot result"));
		expect(staleNotes).toHaveLength(1);
	});
});
