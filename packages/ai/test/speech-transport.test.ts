import { describe, expect, it } from "bun:test";
import type { Api, FetchImpl, Model } from "@veyyon/catalog/types";
import { VERSION } from "@veyyon/utils/dirs";
import { postSpeechRequest, SpeechApiError } from "../src/speech/transport";

const testModel: Model<Api> = {
	id: "tts-test",
	provider: "openai",
	api: "openai-speech" as Api,
	baseUrl: "https://speech.example.com/v1",
	headers: { "x-custom-meta": "value" },
} as unknown as Model<Api>;

describe("speech transport postSpeechRequest", () => {
	it("dispatches speech payload through injected fetch and returns SpeechResult", async () => {
		const capturedRequests: Array<{ url: string; headers: Headers; body: unknown }> = [];
		const fakeAudio = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedRequests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			return new Response(fakeAudio, { status: 200, headers: { "content-type": "audio/mpeg" } });
		};

		const result = await postSpeechRequest(
			testModel,
			"/audio/speech",
			{ model: "tts-test", input: "Hello world" },
			"mp3",
			{ apiKey: "secret-key", fetch: fetchImpl },
		);

		expect(capturedRequests).toHaveLength(1);
		expect(capturedRequests[0]?.url).toBe("https://speech.example.com/v1/audio/speech");
		expect(capturedRequests[0]?.headers.get("authorization")).toBe("Bearer secret-key");
		expect(capturedRequests[0]?.headers.get("content-type")).toBe("application/json");
		expect(capturedRequests[0]?.headers.get("user-agent")).toBe(`veyyon/${VERSION}`);
		expect(capturedRequests[0]?.headers.get("x-custom-meta")).toBe("value");
		expect(capturedRequests[0]?.body).toEqual({ model: "tts-test", input: "Hello world" });
		expect(result.audio).toEqual(fakeAudio);
		expect(result.mimeType).toBe("audio/mpeg");
		expect(result.usage.input).toBe(0);
		expect(result.usage.output).toBe(0);
	});

	it("confines the bearer token to Authorization even if model headers define authorization", async () => {
		const modelWithOldAuth: Model<Api> = {
			...testModel,
			headers: { authorization: "Bearer stale-token", "x-header": "test" },
		};
		let capturedHeaders: Headers | undefined;
		let capturedUrl: string | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = new Headers(init?.headers);
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		};

		await postSpeechRequest(modelWithOldAuth, "/audio/speech", { input: "Sanitize test" }, "wav", {
			apiKey: "real-bearer-key",
			fetch: fetchImpl,
		});

		expect(capturedHeaders).toBeDefined();
		expect(capturedHeaders?.get("authorization")).toBe("Bearer real-bearer-key");
		expect(capturedUrl?.includes("real-bearer-key")).toBe(false);
		for (const [key, value] of capturedHeaders?.entries() ?? []) {
			if (key.toLowerCase() !== "authorization") {
				expect(value.includes("real-bearer-key")).toBe(false);
			}
		}
	});

	it("retries on 401 using ApiKeyResolver when available", async () => {
		const keysUsed: Array<string | null> = [];
		let attempts = 0;
		const fetchImpl: FetchImpl = async (_input, init) => {
			attempts++;
			keysUsed.push(new Headers(init?.headers).get("authorization"));
			if (attempts === 1) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
		};

		const result = await postSpeechRequest(testModel, "/audio/speech", { input: "retry test" }, "mp3", {
			apiKey: async ctx => (ctx.error ? "refreshed-key" : "initial-key"),
			fetch: fetchImpl,
		});

		expect(attempts).toBe(2);
		expect(keysUsed).toEqual(["Bearer initial-key", "Bearer refreshed-key"]);
		expect(result.audio).toEqual(new Uint8Array([9, 8, 7]));
	});

	it("throws SpeechApiError on non-2xx responses preserving status and headers", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response("Bad Request: invalid voice", { status: 400, headers: { "x-request-id": "req-123" } });

		let thrown: unknown;
		try {
			await postSpeechRequest(testModel, "/audio/speech", { input: "error test" }, "mp3", {
				apiKey: "test-key",
				fetch: fetchImpl,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(SpeechApiError);
		const err = thrown as SpeechApiError;
		expect(err.name).toBe("SpeechApiError");
		expect(err.status).toBe(400);
		expect(err.message).toContain("openai/tts-test speech API failed (400)");
		expect(err.headers?.get("x-request-id")).toBe("req-123");
	});
});
