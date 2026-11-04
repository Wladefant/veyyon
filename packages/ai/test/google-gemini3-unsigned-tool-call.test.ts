import { describe, expect, it } from "bun:test";
import { convertMessages } from "@veyyon/ai/providers/google-shared";
import type { Api, Context, Model, ToolCall, Usage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

// WHY: CCA replay needs a signature on the first function call in each imported
// model turn, not on its unsigned parallel siblings. Exact-model signatures stay
// intact. Public Gemini and Vertex keep their existing transport policies.
// These wire-format tests do not prove live endpoint generation.

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const VALID_SIGNATURE = "QUJDRA==";
const SENTINEL = "skip_thought_signature_validator";

type GoogleApi = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

function buildGeminiModel(api: GoogleApi, provider: string, id: string): Model<GoogleApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65536,
	});
}

function assistantTurn(api: Api, provider: string, id: string, content: ToolCall[]): Context {
	return {
		messages: [
			{ role: "user", content: "Optimize the code", timestamp: 1000 },
			{
				role: "assistant",
				provider,
				api,
				model: id,
				content,
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2000,
			},
		],
	};
}

/** One assistant turn with three parallel tool calls; only the first is signed. */
function parallelToolCalls(api: GoogleApi, provider: string, id: string): Context {
	return assistantTurn(api, provider, id, [
		{ type: "toolCall", id: "call_1", name: "todo", arguments: { op: "init" }, thoughtSignature: VALID_SIGNATURE },
		{ type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "helperExec" } },
		{ type: "toolCall", id: "call_3", name: "grep", arguments: { pattern: "shift" } },
	]);
}

/** One assistant turn whose sole tool call has no signature (cross-model replay / redacted args). */
function unsignedFirstCall(api: GoogleApi, provider: string, id: string): Context {
	return assistantTurn(api, provider, id, [
		{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "shift" } },
	]);
}

function toolCallParts(model: Model<GoogleApi>, context: Context) {
	const contents = convertMessages(model, context);
	return contents.find(c => c.role === "model")?.parts?.filter(part => part.functionCall) ?? [];
}

for (const origin of [
	{ api: "openai-completions", provider: "openai-codex", model: "gpt-6-luna" },
	{ api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.7-flash" },
	{ api: "google-generative-ai", provider: "google", model: "gemini-3.8-flash" },
] as const) {
	it(`signs only the first imported CCA call from ${origin.provider}/${origin.model} in each turn`, () => {
		const target = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.8-flash");
		const history = assistantTurn(origin.api, origin.provider, origin.model, [
			{ type: "toolCall", id: "first", name: "read", arguments: {}, thoughtSignature: VALID_SIGNATURE },
			{ type: "toolCall", id: "second", name: "read", arguments: {} },
			{ type: "toolCall", id: "third", name: "read", arguments: {} },
		]);
		history.messages.push(
			{ role: "user", content: "<user_interjection>Continue</user_interjection>", timestamp: 3000 },
			...assistantTurn(origin.api, origin.provider, origin.model, [
				{ type: "toolCall", id: "next-first", name: "read", arguments: {} },
				{ type: "toolCall", id: "next-second", name: "read", arguments: {} },
			]).messages.slice(1),
		);
		const turns = convertMessages(target, history).filter(turn => turn.role === "model");
		expect(turns.map(turn => turn.parts?.filter(part => part.functionCall).map(part => part.thoughtSignature))).toEqual([
			[SENTINEL, undefined, undefined],
			[SENTINEL, undefined],
		]);
	});
}

describe("Gemini 3 unsigned tool-call signatures (#9638)", () => {
	it("omits unsigned signatures and never emits the sentinel on Antigravity/CCA", () => {
		const model = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");

		const parallel = parallelToolCalls("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const parallelCalls = toolCallParts(model, parallel);
		expect(parallelCalls).toHaveLength(3);
		expect(parallelCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(parallelCalls[1]?.thoughtSignature).toBeUndefined();
		expect(parallelCalls[2]?.thoughtSignature).toBeUndefined();
		// The sentinel is what CCA rejects with 400 INVALID_ARGUMENT — it must never reach the wire.
		expect(JSON.stringify(convertMessages(model, parallel))).not.toContain(SENTINEL);

		const unsigned = unsignedFirstCall("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const unsignedCalls = toolCallParts(model, unsigned);
		expect(unsignedCalls[0]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(convertMessages(model, unsigned))).not.toContain(SENTINEL);
	});

	it("omits unsigned signatures and never emits the sentinel on Vertex", () => {
		const model = buildGeminiModel("google-vertex", "google-vertex", "gemini-3-flash");
		const unsigned = unsignedFirstCall("google-vertex", "google-vertex", "gemini-3-flash");
		const calls = toolCallParts(model, unsigned);

		expect(calls[0]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(convertMessages(model, unsigned))).not.toContain(SENTINEL);
	});

	it("keeps the sentinel bypass for unsigned calls on the public Gemini API", () => {
		const model = buildGeminiModel("google-generative-ai", "google", "gemini-3-flash");

		// An unsigned first call (cross-model replay / redacted args) must carry the
		// sentinel — the public endpoint 400s on a missing signature.
		const unsigned = unsignedFirstCall("google-generative-ai", "google", "gemini-3-flash");
		expect(toolCallParts(model, unsigned)[0]?.thoughtSignature).toBe(SENTINEL);

		// Parallel: the real signature is kept, the unsigned siblings get the sentinel.
		const parallelCalls = toolCallParts(model, parallelToolCalls("google-generative-ai", "google", "gemini-3-flash"));
		expect(parallelCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(parallelCalls[1]?.thoughtSignature).toBe(SENTINEL);
		expect(parallelCalls[2]?.thoughtSignature).toBe(SENTINEL);
	});

	it("emits the skip sentinel for foreign tool calls on Antigravity/CCA but keeps Gemini signatures (#844)", () => {
		const model = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.8-flash");

		// Foreign (e.g. openai-codex) assistant turn: tool calls must carry the skip sentinel
		// so Cloud Code Assist / Antigravity does not 400 with 'Function call is missing a thought_signature'.
		const foreignTurn = assistantTurn("openai-completions", "openai-codex", "gpt-6-luna", [
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
		]);
		const foreignCalls = toolCallParts(model, foreignTurn);
		expect(foreignCalls).toHaveLength(1);
		expect(foreignCalls[0]?.thoughtSignature).toBe(SENTINEL);

		// Gemini-produced turn: keeps its own real thought signature untouched.
		const geminiTurn = assistantTurn("google-gemini-cli", "google-antigravity", "gemini-3.8-flash", [
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "git status" }, thoughtSignature: VALID_SIGNATURE },
		]);
		const geminiCalls = toolCallParts(model, geminiTurn);
		expect(geminiCalls).toHaveLength(1);
		expect(geminiCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
	});
});
