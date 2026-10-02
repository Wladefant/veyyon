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
	});

	it("confines the bearer token to Authorization even if model headers define authorization", async () => {
		const modelWithOldAuth = { ...testModel, headers: { authorization: "Bearer stale-token", "x-header": "test" } };
		let capturedHeaders: Headers | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			capturedHeaders = new Headers(init?.headers);
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		};
		await postSpeechRequest(modelWithOldAuth, "/audio/speech", { input: "Sanitize test" }, "wav", {
			apiKey: "real-bearer-key",
			fetch: fetchImpl,
		});
		expect(capturedHeaders?.get("authorization")).toBe("Bearer real-bearer-key");
		for (const [key, value] of capturedHeaders?.entries() ?? []) {
			if (key.toLowerCase() !== "authorization") expect(value.includes("real-bearer-key")).toBe(false);
		}
	});

	it("replaces lowercase content-type headers case-insensitively with exact wire value", async () => {
		const modelWithLowerCt = {
			...testModel,
			headers: { "content-type": "application/json; charset=utf-8" },
			resolveHeaders: async () => ({ "content-type": "text/plain" }),
		} as unknown as Model<Api>;
		let captured: Headers | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			captured = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(new Uint8Array([1]), { status: 200 });
		};
		await postSpeechRequest(modelWithLowerCt, "/audio/speech", { input: "ct test" }, "mp3", {
			apiKey: "key",
			fetch: fetchImpl,
		});
		expect(captured?.get("content-type")).toBe("application/json");
		const ctEntries = Array.from(captured?.entries() ?? []).filter(([k]) => k.toLowerCase() === "content-type");
		expect(ctEntries).toEqual([["content-type", "application/json"]]);
	});

	it("retries on 401 using ApiKeyResolver when available", async () => {
		const keysUsed: Array<string | null> = [];
		let attempts = 0;
		const fetchImpl: FetchImpl = async (_input, init) => {
			attempts++;
			keysUsed.push(new Headers(init?.headers).get("authorization"));
			if (attempts === 1) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
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
		const err = (await postSpeechRequest(testModel, "/audio/speech", { input: "err" }, "mp3", {
			apiKey: "test-key",
			fetch: fetchImpl,
		}).catch(e => e)) as SpeechApiError;
		expect(err).toBeInstanceOf(SpeechApiError);
		expect(err.status).toBe(400);
		expect(err.message).toContain("openai/tts-test speech API failed (400): Bad Request: invalid voice");
		expect(err.headers?.get("x-request-id")).toBe("req-123");
	});

	it("redacts echoed bearer tokens from surfaced SpeechApiError message including retries", async () => {
		let attempts = 0;
		const fetchImpl: FetchImpl = async () => {
			attempts++;
			return new Response(`Incorrect API key provided: key-${attempts}`, { status: 401 });
		};
		const err = (await postSpeechRequest(testModel, "/audio/speech", { input: "echo" }, "mp3", {
			apiKey: async ctx => (ctx.error ? "key-2" : "key-1"),
			fetch: fetchImpl,
		}).catch(e => e)) as SpeechApiError;
		expect(err).toBeInstanceOf(SpeechApiError);
		expect(err.status).toBe(401);
		expect(err.message).toContain("openai/tts-test speech API failed (401): Incorrect API key provided: [redacted]");
		expect(err.message.includes("key-1")).toBe(false);
		expect(err.message.includes("key-2")).toBe(false);
	});
});
