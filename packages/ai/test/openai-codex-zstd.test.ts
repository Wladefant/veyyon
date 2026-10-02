import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { __resetProxyCache } from "@veyyon/ai/utils/proxy";
import { buildModel } from "@veyyon/catalog/build";
import * as piUtils from "@veyyon/utils";
import { withEnv } from "./helpers";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	setAgentDir(originalAgentDir);
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl = "https://chatgpt.com/backend-api"): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

// A fixed replacement payload pins the outgoing wire body so the serialized
// JSON is byte-deterministic across the compress/decompress round-trip.
const PINNED_PAYLOAD: Record<string, unknown> = {
	model: "gpt-5.3-codex-spark",
	input: [{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }],
	stream: true,
	prompt_cache_key: "zstd-test-cache-key",
};

interface CapturedRequest {
	body: RequestInit["body"];
	headers: Headers;
}

async function runAndCaptureRequest(model = createCodexTestModel()): Promise<CapturedRequest> {
	const tempDir = TempDir.createSync("@veyyon-codex-zstd-");
	setAgentDir(tempDir.path());
	const token = createCodexTestToken();

	let captured: CapturedRequest | undefined;
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured = {
			body: init?.body,
			headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
		};
		return new Response(createCompletedCodexSse("Hello"), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
		apiKey: token,
		fetch: fetchMock as FetchImpl,
		onPayload: async () => PINNED_PAYLOAD,
	}).result();

	expect(result.stopReason).toBe("stop");
	if (captured === undefined) throw new Error("expected the SSE request to reach fetch");
	return captured;
}

describe("codex SSE request body zstd compression", () => {
	it("compresses the request body with zstd and sets content-encoding by default", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.get("content-encoding")).toBe("zstd");
			expect(headers.get("content-type")).toContain("application/json");
			if (!(body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
			// A zstd frame begins with the magic number 0xFD2FB528 (little-endian).
			expect(Array.from(body.subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);

			const decompressed = new TextDecoder().decode(Bun.zstdDecompressSync(body));
			expect(decompressed).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("sends the plain JSON string without content-encoding when PI_CODEX_ZSTD=0", async () => {
		await withEnv({ PI_CODEX_ZSTD: "0" }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.has("content-encoding")).toBe(false);
			expect(headers.get("content-type")).toContain("application/json");
			expect(typeof body).toBe("string");
			expect(body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it.each([400, 415])("retries uncompressed when server rejects compressed request with %i", async status => {
		const tempDir = TempDir.createSync("@temp-zstd-fallback-");
		setAgentDir(tempDir.path());
		let rejectedBodyCanceled = false;
		let canceledBeforeRetry = false;
		const attempts: Array<{ headers: Headers; body: RequestInit["body"] }> = [];
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			attempts.push({ headers, body: init?.body });
			if (attempts.length === 1) {
				const response = new Response(JSON.stringify({ error: { message: "Rejected" } }), {
					status,
					headers: { "content-type": "application/json" },
				});
				// Retry classification reads a clone; observe cancellation of the original body.
				Object.defineProperty(response, "body", {
					value: new ReadableStream({
						cancel() {
							rejectedBodyCanceled = true;
						},
					}),
				});
				return response;
			}
			canceledBeforeRetry = rejectedBodyCanceled;
			return new Response(createCompletedCodexSse("Success after retry"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(canceledBeforeRetry).toBe(true);
		expect(attempts).toHaveLength(2);
		expect(attempts[0].headers.get("content-encoding")).toBe("zstd");
		expect(attempts[0].body instanceof Uint8Array).toBe(true);
		const decoded = new TextDecoder().decode(Bun.zstdDecompressSync(attempts[0].body as Uint8Array));
		expect(attempts[1].headers.has("content-encoding")).toBe(false);
		expect(JSON.parse(attempts[1].body as string)).toEqual(JSON.parse(decoded));
	});

	it("does not compress with zstd when using a non-official baseUrl", async () => {
		const { body, headers } = await runAndCaptureRequest(
			createCodexTestModel("https://custom-proxy.internal.example.com/backend-api"),
		);
		expect(headers.has("content-encoding")).toBe(false);
		expect(typeof body).toBe("string");
	});

	it("falls back to uncompressed plain JSON when Bun.zstdCompressSync throws", async () => {
		vi.spyOn(Bun, "zstdCompressSync").mockImplementation(() => {
			throw new Error("Simulated zstd compression failure");
		});
		const { body, headers } = await runAndCaptureRequest();
		expect(headers.has("content-encoding")).toBe(false);
		expect(typeof body).toBe("string");
	});
});
