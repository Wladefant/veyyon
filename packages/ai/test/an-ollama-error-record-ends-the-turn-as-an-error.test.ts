/**
 * WHY: once Ollama has answered HTTP 200 it reports a failure as an NDJSON `{"error": ...}` record
 * in the body. The stream loop read only `message` and `done`, so the record was dropped: a partial
 * answer ended as a successful stop, an error-only response ended as an empty success the
 * empty-completion wrapper then retried, and a failed tool-call stream ended as `toolUse` and ran
 * its half-streamed calls (oh-my-pi 86dba86f69b7ea092801d15242337afce955185c).
 *
 * The class: any in-band error record, whatever came before it, must end the turn as an error that
 * carries the provider's text. Each case below ends on a `done` line, so it fails without the fix
 * rather than passing on the missing-done path.
 *
 * What it does not catch: an error record whose `error` field is not a non-empty string.
 */
import { describe, expect, it } from "bun:test";
import type { Context } from "@veyyon/ai";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { buildModel } from "@veyyon/catalog/build";

function ollamaModel() {
	return buildModel({
		id: "qwen3-coder",
		name: "Qwen3 Coder",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
	});
}

const context: Context = { messages: [{ role: "user", content: "Add two numbers.", timestamp: 0 }] };

const DONE = { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 };
const ERROR = { error: "model runner has unexpectedly stopped" };

function ndjson(...chunks: Record<string, unknown>[]): Response {
	return new Response(`${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`, { status: 200 });
}

async function run(...chunks: Record<string, unknown>[]) {
	let requests = 0;
	const result = await streamOllama(ollamaModel(), context, {
		apiKey: "test-key",
		fetch: async () => {
			requests++;
			return ndjson(...chunks);
		},
	}).result();
	return { result, requests };
}

describe("an Ollama error record ends the turn as an error", () => {
	it("fails a partial answer instead of ending it as a stop", async () => {
		const { result } = await run({ message: { content: "The sum is" } }, ERROR, DONE);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("model runner has unexpectedly stopped");
	});

	it("fails an error-only response once instead of retrying it as an empty success", async () => {
		const { result, requests } = await run(ERROR, DONE);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("model runner has unexpectedly stopped");
		expect(requests).toBe(1);
	});

	it("fails a tool-call stream instead of handing its calls to the loop as toolUse", async () => {
		const { result } = await run(
			{ message: { content: "", tool_calls: [{ function: { name: "add", arguments: { a: 1 } } }] } },
			ERROR,
			DONE,
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("model runner has unexpectedly stopped");
	});
});
