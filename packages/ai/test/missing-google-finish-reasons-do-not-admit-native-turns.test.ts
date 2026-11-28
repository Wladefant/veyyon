// Gemini Developer API and Cloud Code Assist require a finish reason before
// accepting output. Vertex-compatible endpoints keep the legacy EOF policy.
// These wrapper tests do not exercise the agent tool dispatcher.
import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@veyyon/ai/providers/google-vertex";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { stopReasonForTerminallessEof } from "@veyyon/ai/utils/terminalless-eof";
import { buildModel } from "@veyyon/catalog/build";
import { sseResponse } from "./helpers/fetch-mock";

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiParts(...parts: unknown[]): Record<string, unknown> {
	return { candidates: [{ content: { parts } }] };
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist). */
function ccaParts(...parts: unknown[]): Record<string, unknown> {
	return { response: genaiParts(...parts) };
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});
const vertexModel = buildModel({ ...genaiModel, api: "google-vertex" });

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const always = (response: () => Response): FetchImpl => {
	return async () => response();
};

describe("Google streams without a finish reason", () => {
	it("preserves marker-less text completion for Vertex-compatible endpoints", async () => {
		const stream = streamGoogleVertex(vertexModel, context, {
			apiKey: "k",
			fetch: always(() => sseResponse([genaiParts({ text: "Hello!" })])),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		expect(result.errorMessage).toBeUndefined();
	});

	it("rejects a complete-looking Gemini function call with no finishReason", async () => {
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: always(() => sseResponse([genaiParts({ functionCall: { name: "read", args: { path: "a.ts" } } })])),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	/**
	 * A function call with no name is the one partial shape this dialect can
	 * produce: the id is minted by the decoder and `args` arrives already parsed,
	 * so a nameless call is unusable and outranks any text beside it. Promoting it
	 * would hand the session a tool-use turn naming no tool.
	 */
	it("still refuses a body whose only function call has no name", async () => {
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: always(() => sseResponse([genaiParts({ text: "here goes" }, { functionCall: { args: {} } })])),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	it("retains partial Cloud Code Assist text without marking the turn complete", async () => {
		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: always(() => sseResponse([ccaParts({ text: "From CCA" })])),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
		expect(textOf(result)).toBe("From CCA");
	});

	it("still refuses a Cloud Code Assist body whose only function call has no name", async () => {
		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: always(() => sseResponse([ccaParts({ text: "here goes" }, { functionCall: { args: {} } })])),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	it("leaves the shared compatibility judgement intact", () => {
		const text = [{ type: "text" as const, text: "answer" }];
		const namedCall = [{ type: "toolCall" as const, id: "1", name: "read", arguments: {} }];

		expect(stopReasonForTerminallessEof(text, true)).toBe("stop");
		expect(stopReasonForTerminallessEof(namedCall, true)).toBe("toolUse");
		expect(stopReasonForTerminallessEof(namedCall, false)).toBeUndefined();
		expect(stopReasonForTerminallessEof([], true)).toBeUndefined();
	});
});
