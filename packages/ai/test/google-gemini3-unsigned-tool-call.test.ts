import { describe, expect, it } from "bun:test";
import { convertMessages } from "@veyyon/ai/providers/google-shared";
import type { Api, AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

// WHY: CCA replay needs a signature on the first function call in each imported
// step (and on unsigned native Gemini 4 steps), not on its unsigned parallel siblings.
// Exact-model signatures stay intact. Public Gemini and Vertex keep their transport policies.

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
const SECOND_SIGNATURE = "U0VDT05E";
const FOREIGN_SIGNATURE = "Rk9SRUlHTg==";
const LONG_SIGNATURE = "TE9OR19TSUdOQVRVUkU=";

const GEMINI_4_CCA_TARGETS = [
	"gemini-4-neon-medium",
	"gemini-4-carbon-medium",
	"gemini-4-hydrogen-medium",
] as const;

type GoogleApi = Extract<Api, `google-${string}`>;

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

function assistantMessage(
	api: Api,
	provider: string,
	model: string,
	content: AssistantMessage["content"],
): AssistantMessage {
	return { role: "assistant", provider, api, model, content, usage: ZERO_USAGE, stopReason: "toolUse", timestamp: 2000 };
}

function assistantTurn(api: Api, provider: string, id: string, content: AssistantMessage["content"]): Context {
	return {
		messages: [
			{ role: "user", content: "Optimize the code", timestamp: 1000 },
			assistantMessage(api, provider, id, content),
		],
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
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

const REPLAY_TARGETS = {
	"google-gemini-cli": {
		model: buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.8-flash"),
		signatures: [
			[SENTINEL, undefined, undefined],
			[SENTINEL, undefined],
		],
	},
	"google-generative-ai": {
		model: buildGeminiModel("google-generative-ai", "google", "gemini-3.8-pro"),
		signatures: [
			[SENTINEL, SENTINEL, SENTINEL],
			[SENTINEL, SENTINEL],
		],
	},
	"google-vertex": {
		model: buildGeminiModel("google-vertex", "google-vertex", "gemini-3.8-flash"),
		signatures: [
			[undefined, undefined, undefined],
			[undefined, undefined],
		],
	},
} satisfies Record<GoogleApi, { model: Model<GoogleApi>; signatures: (string | undefined)[][] }>;

for (const origin of [
	{ api: "openai-completions", provider: "openai-codex", model: "gpt-6-luna" },
	{ api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.7-flash" },
	{ api: "google-generative-ai", provider: "google", model: "gemini-3.8-flash" },
] as const) {
	for (const target of Object.values(REPLAY_TARGETS)) {
		it(`applies ${target.model.api} replay signatures to ${origin.provider}/${origin.model} in each turn`, () => {
			const history = assistantTurn(origin.api, origin.provider, origin.model, [
				{ type: "text", text: "Inspect the files." },
				{ type: "toolCall", id: "first", name: "read", arguments: {}, thoughtSignature: VALID_SIGNATURE },
				{ type: "toolCall", id: "second", name: "read", arguments: {} },
				{ type: "toolCall", id: "third", name: "read", arguments: {} },
			]);
			history.messages.push(
				{ role: "user", content: "<user_interjection>Continue</user_interjection>", timestamp: 3000 },
				...assistantTurn(origin.api, origin.provider, origin.model, [
					{ type: "text", text: "Inspect the next file." },
					{ type: "toolCall", id: "next-first", name: "read", arguments: {} },
					{ type: "toolCall", id: "next-second", name: "read", arguments: {} },
				]).messages.slice(1),
			);
			const turns = convertMessages(target.model, history).filter(turn => turn.role === "model");
			expect(
				turns.map(turn => turn.parts?.filter(part => part.functionCall).map(part => part.thoughtSignature)),
			).toEqual(target.signatures);
		});
	}
}

describe("Gemini 3 unsigned tool-call signatures (#9638)", () => {
	it("preserves signatures and unsigned siblings in same-model Antigravity/CCA history", () => {
		const model = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");

		const parallel = parallelToolCalls("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const parallelCalls = toolCallParts(model, parallel);
		expect(parallelCalls).toHaveLength(3);
		expect(parallelCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(parallelCalls[1]?.thoughtSignature).toBeUndefined();
		expect(parallelCalls[2]?.thoughtSignature).toBeUndefined();
		// Same-model CCA history does not need the imported-history bypass.
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

		// The first foreign call needs the bypass; same-model calls keep their own signatures.
		const foreignTurn = assistantTurn("openai-completions", "openai-codex", "gpt-6-luna", [
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
		]);
		const foreignCalls = toolCallParts(model, foreignTurn);
		expect(foreignCalls).toHaveLength(1);
		expect(foreignCalls[0]?.thoughtSignature).toBe(SENTINEL);

		// Gemini-produced turn: keeps its own real thought signature untouched.
		const geminiTurn = assistantTurn("google-gemini-cli", "google-antigravity", "gemini-3.8-flash", [
			{
				type: "toolCall",
				id: "call_2",
				name: "bash",
				arguments: { command: "git status" },
				thoughtSignature: VALID_SIGNATURE,
			},
		]);
		const geminiCalls = toolCallParts(model, geminiTurn);
		expect(geminiCalls).toHaveLength(1);
		expect(geminiCalls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
	});
});

describe("Gemini 4 Cloud Code Assist tool-call signatures (#1284)", () => {
	for (const targetId of GEMINI_4_CCA_TARGETS) {
		const target = buildGeminiModel("google-gemini-cli", "google-antigravity", targetId);

		it(`replays multi-step history with signed target batches, imported fallback after text, and omitted native first signature for ${targetId}`, () => {
			const context: Context = {
				messages: [
					{ role: "user", content: "Fix #1284", timestamp: 1000 },
					assistantMessage("google-gemini-cli", "google-antigravity", targetId, [
						{ type: "toolCall", id: "t1_a", name: "read", arguments: {}, thoughtSignature: VALID_SIGNATURE },
						{ type: "toolCall", id: "t1_b", name: "grep", arguments: {} },
					]),
					toolResult("t1_a", "read", "file contents", 2100),
					toolResult("t1_b", "grep", "match", 2101),
					assistantMessage("openai-completions", "openai-codex", "gpt-6-luna", [
						{ type: "text", text: "Checking the caller." },
						{ type: "toolCall", id: "f1_a", name: "irc", arguments: {}, thoughtSignature: FOREIGN_SIGNATURE },
						{ type: "toolCall", id: "f1_b", name: "bash", arguments: {} },
					]),
					toolResult("f1_a", "irc", "ok", 3100),
					toolResult("f1_b", "bash", "clean", 3101),
					assistantMessage("google-gemini-cli", "google-antigravity", targetId, [
						{ type: "text", text: "Applying fix." },
						{ type: "toolCall", id: "t2_a", name: "edit", arguments: {}, thoughtSignature: SECOND_SIGNATURE },
						{ type: "toolCall", id: "t2_b", name: "read", arguments: {} },
					]),
					toolResult("t2_a", "edit", "updated", 4100),
					toolResult("t2_b", "read", "verified", 4101),
					assistantMessage("google-gemini-cli", "google-antigravity", targetId, [
						{ type: "text", text: "Running final check." },
						{ type: "toolCall", id: "t3_a", name: "bash", arguments: {} },
						{ type: "toolCall", id: "t3_b", name: "read", arguments: {} },
					]),
					toolResult("t3_a", "bash", "passed", 5100),
					toolResult("t3_b", "read", "done", 5101),
				],
			};

			const contents = convertMessages(target, context);
			expect(JSON.stringify(contents)).not.toContain(FOREIGN_SIGNATURE);
			expect(contents.map(c => c.role)).toEqual([
				"user", "model", "user", "model", "user", "model", "user", "model", "user",
			]);

			const callSigs = (index: number) =>
				contents[index]?.parts?.filter(p => p.functionCall).map(p => [p.functionCall?.name, p.thoughtSignature]);
			const responseNames = (index: number) =>
				contents[index]?.parts?.filter(p => p.functionResponse).map(p => p.functionResponse?.name);

			expect(callSigs(1)).toEqual([
				["read", VALID_SIGNATURE],
				["grep", undefined],
			]);
			expect(responseNames(2)).toEqual(["read", "grep"]);

			expect(contents[3]?.parts?.[0]).toEqual({ text: "Checking the caller." });
			expect(callSigs(3)).toEqual([
				["irc", SENTINEL],
				["bash", undefined],
			]);
			expect(responseNames(4)).toEqual(["irc", "bash"]);

			expect(callSigs(5)).toEqual([
				["edit", SECOND_SIGNATURE],
				["read", undefined],
			]);
			expect(responseNames(6)).toEqual(["edit", "read"]);

			expect(callSigs(7)).toEqual([
				["bash", SENTINEL],
				["read", undefined],
			]);
			expect(responseNames(8)).toEqual(["bash", "read"]);
		});

		it(`emits skip sentinel on first call when opt-in retention or max-length elides a Gemini 4 signature for ${targetId}`, () => {
			const messages: Context["messages"] = [
				{ role: "user", content: "Check history", timestamp: 1000 },
				assistantMessage("google-gemini-cli", "google-antigravity", targetId, [
					{ type: "toolCall", id: "r1_a", name: "read", arguments: {}, thoughtSignature: LONG_SIGNATURE },
					{ type: "toolCall", id: "r1_b", name: "grep", arguments: {} },
				]),
				toolResult("r1_a", "read", "a", 2100),
				toolResult("r1_b", "grep", "b", 2101),
				assistantMessage("google-gemini-cli", "google-antigravity", targetId, [
					{ type: "toolCall", id: "r2_a", name: "edit", arguments: {}, thoughtSignature: VALID_SIGNATURE },
					{ type: "toolCall", id: "r2_b", name: "read", arguments: {} },
				]),
				toolResult("r2_a", "edit", "c", 3100),
				toolResult("r2_b", "read", "d", 3101),
			];

			const modelCallSignatures = (context: Context) =>
				convertMessages(target, context)
					.filter(c => c.role === "model")
					.map(c => c.parts?.filter(p => p.functionCall).map(p => p.thoughtSignature));

			expect(modelCallSignatures({ messages, thoughtSignatureRetention: 1 })).toEqual([
				[SENTINEL, undefined],
				[VALID_SIGNATURE, undefined],
			]);
			expect(modelCallSignatures({ messages, thoughtSignatureMaxLength: VALID_SIGNATURE.length })).toEqual([
				[SENTINEL, undefined],
				[VALID_SIGNATURE, undefined],
			]);
		});
	}
});
