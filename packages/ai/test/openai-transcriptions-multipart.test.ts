import { describe, expect, it } from "bun:test";
import type { Api, FetchImpl, Model } from "@veyyon/catalog/types";
import * as AIError from "../src/error";
import { TranscriptionApiError, transcribeOpenAI } from "../src/transcription/openai-transcriptions";
import type { TranscriptionRequest } from "../src/transcription/types";

const cost = { input: 0.006, output: 0.006, cacheRead: 0, cacheWrite: 0 };
const model = {
	id: "whisper-1",
	api: "openai-transcriptions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	cost,
} as unknown as Model<Api>;

describe("transcribeOpenAI multipart adapter", () => {
	it("dispatches multipart audio, fields, and confines bearer token to Authorization header", async () => {
		const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
		const fetchMock: FetchImpl = async (input, init) => {
			const headers = new Headers(init?.headers);
			if (!(init?.body instanceof FormData)) throw new Error("expected FormData body");
			const body = init.body;
			const file = body.get("file");
			if (!(file instanceof File)) throw new Error("expected File");
			const leak = Array.from(headers.entries()).some(
				e => e[0] !== "authorization" && e[1].includes("secret-token"),
			);
			expect(String(input)).toBe("https://api.openai.com/v1/audio/transcriptions");
			expect(headers.get("authorization")).toBe("Bearer secret-token");
			expect(leak || String(input).includes("secret-token")).toBe(false);
			const b = (k: string) => String(body.get(k));
			expect(`${b("model")},${b("response_format")},${b("language")},${b("prompt")},${b("temperature")}`).toBe(
				"whisper-1,verbose_json,en,prompt,0.1",
			);
			expect(body.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
			expect([file.name, file.type]).toEqual(["test.wav", "audio/wav"]);
			expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
			const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost: 0.001, seconds: 3.5 };
			const segments = [{ id: 0, start: 0, end: 3.5, text: "Transcribed text." }];
			return Response.json({ text: "Transcribed text.", language: "en", duration: 3.5, segments, usage });
		};

		const req: TranscriptionRequest = {
			audio,
			mimeType: "audio/wav",
			fileName: "test.wav",
			language: "en",
			prompt: "prompt",
			temperature: 0.1,
			responseFormat: "verbose_json",
			timestampGranularities: ["word", "segment"],
		};
		const res = await transcribeOpenAI(model, req, { apiKey: "secret-token", fetch: fetchMock });
		expect(`${res.text}|${res.language}|${res.duration}|${res.seconds}|${res.usage.totalTokens}`).toBe(
			"Transcribed text.|en|3.5|3.5|15",
		);
		expect(res.usage.cost.total).toBe(0.001);
	});

	it("decodes provider error envelope and validates malformed schema rejections", async () => {
		const dummy: TranscriptionRequest = { audio: new Uint8Array([1]), mimeType: "audio/wav", responseFormat: "json" };
		const errFetch: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { message: "Invalid key", code: "invalid_api_key" } }), { status: 401 });
		const err = await transcribeOpenAI(model, dummy, { apiKey: "bad", fetch: errFetch }).catch(e => e);
		expect(err).toBeInstanceOf(TranscriptionApiError);
		if (!(err instanceof TranscriptionApiError)) throw new Error("expected TranscriptionApiError");
		expect([err.status, err.code]).toEqual([401, "invalid_api_key"]);
		expect(err.message).toContain("Invalid key");

		const malformed = await transcribeOpenAI(model, dummy, {
			apiKey: "k",
			fetch: async () => Response.json({ no_text: true }),
		}).catch(e => e);
		expect(malformed).toBeInstanceOf(AIError.ProviderResponseError);
	});
});
