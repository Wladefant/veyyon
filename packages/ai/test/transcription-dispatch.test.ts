import { describe, expect, it } from "bun:test";
import type { Api, FetchImpl, Model } from "@veyyon/catalog/types";
import * as AIError from "../src/error";
import { transcribeAudio } from "../src/transcription";
import type { TranscriptionRequest } from "../src/transcription/types";

const cost = { input: 0.006, output: 0.006, cacheRead: 0, cacheWrite: 0 };

describe("transcribeAudio dispatcher", () => {
	it("dispatches to transcribeOpenAI when model.api is openai-transcriptions", async () => {
		const model = {
			id: "whisper-1",
			api: "openai-transcriptions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			cost,
		} as unknown as Model<Api>;
		const fetchMock: FetchImpl = async () => Response.json({ text: "Hello world" });
		const req: TranscriptionRequest = {
			audio: new Uint8Array([1, 2]),
			mimeType: "audio/wav",
			responseFormat: "json",
		};
		const res = await transcribeAudio(model, req, { apiKey: "key", fetch: fetchMock });
		expect(res.text).toBe("Hello world");
	});

	it("throws ConfigurationError when model.api is unsupported", () => {
		const model = {
			id: "custom-audio",
			api: "unsupported-transcription-api" as Api,
			provider: "custom",
			baseUrl: "https://api.example.com",
			cost,
		} as unknown as Model<Api>;
		const req: TranscriptionRequest = { audio: new Uint8Array([1]), mimeType: "audio/wav", responseFormat: "json" };
		expect(() => transcribeAudio(model, req, { apiKey: "key" })).toThrow(AIError.ConfigurationError);
		expect(() => transcribeAudio(model, req, { apiKey: "key" })).toThrow(
			"Unsupported transcription API: unsupported-transcription-api",
		);
	});
});
