import { describe, expect, it } from "bun:test";
import type { Api, FetchImpl, Model } from "@veyyon/catalog/types";
import { ConfigurationError, ValidationError } from "../src/error";
import {
	DEFAULT_XAI_SAMPLE_RATE,
	synthesizeOpenAiSpeech,
	synthesizeSpeech,
	synthesizeXaiSpeech,
} from "../src/speech";

const openaiModel = {
	id: "tts-1",
	provider: "openai",
	api: "openai-speech" as Api,
	baseUrl: "https://api.openai.com/v1",
} as unknown as Model<Api>;

const xaiModel = {
	id: "grok-tts",
	provider: "xai",
	api: "xai-tts" as Api,
	baseUrl: "https://api.x.ai/v1",
} as unknown as Model<Api>;

describe("speech adapters and router", () => {
	it("synthesizeOpenAiSpeech builds valid payload with default voice and rejects sampleRate/bitRate", async () => {
		let captured: { url: string; body: Record<string, unknown> } | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			captured = { url: String(input), body: JSON.parse(String(init?.body)) };
			return new Response(new Uint8Array([1, 2]), { status: 200 });
		};

		await synthesizeOpenAiSpeech(
			openaiModel,
			{ text: "Hello", format: "mp3", speed: 1.25, instructions: "cheerfully" },
			{ apiKey: "test-key", fetch: fetchImpl },
		);

		expect(captured?.url).toBe("https://api.openai.com/v1/audio/speech");
		expect(captured?.body).toEqual({
			model: "tts-1",
			input: "Hello",
			response_format: "mp3",
			voice: "alloy",
			speed: 1.25,
			instructions: "cheerfully",
		});

		await synthesizeOpenAiSpeech(
			openaiModel,
			{ text: "Hello", format: "mp3", voice: "shimmer" },
			{ apiKey: "test-key", fetch: fetchImpl },
		);
		expect(captured?.body.voice).toBe("shimmer");

		await expect(
			synthesizeOpenAiSpeech(
				openaiModel,
				{ text: "err", format: "mp3", sampleRate: 16000 },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeOpenAiSpeech(
				openaiModel,
				{ text: "err", format: "mp3", bitRate: 64000 },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
	});

	it("synthesizeXaiSpeech validates formats and options, constructing output_format", async () => {
		let captured: { url: string; body: unknown } | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			captured = { url: String(input), body: JSON.parse(String(init?.body)) };
			return new Response(new Uint8Array([3, 4]), { status: 200 });
		};

		await synthesizeXaiSpeech(
			xaiModel,
			{ text: "xAI audio", format: "wav", voice: "eve", sampleRate: 48000 },
			{ apiKey: "xai-key", fetch: fetchImpl },
		);

		expect(captured?.url).toBe("https://api.x.ai/v1/tts");
		expect(captured?.body).toEqual({
			text: "xAI audio",
			voice_id: "eve",
			output_format: { codec: "wav", sample_rate: 48000 },
		});

		await expect(
			synthesizeXaiSpeech(
				xaiModel,
				{ text: "t", format: "flac" },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(
				xaiModel,
				{ text: "t", format: "mp3", speed: 1.5 },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(
				xaiModel,
				{ text: "t", format: "mp3", instructions: "whisper" },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(
				xaiModel,
				{ text: "a".repeat(15001), format: "mp3" },
				{ apiKey: "k" },
			),
		).rejects.toThrow(ValidationError);
	});

	it("synthesizeSpeech routes to provider adapter with distinct wire endpoints and payloads", async () => {
		const capturedRequests: Array<{
			url: string;
			body: Record<string, unknown>;
		}> = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedRequests.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
			});
			return new Response(new Uint8Array([5, 6]), { status: 200 });
		};

		const openAiRes = await synthesizeSpeech(
			openaiModel,
			{ text: "Route test", format: "mp3" },
			{ apiKey: "k", fetch: fetchImpl },
		);
		expect(openAiRes.audio).toEqual(new Uint8Array([5, 6]));

		const xaiRes = await synthesizeSpeech(
			xaiModel,
			{ text: "Route test 2", format: "wav" },
			{ apiKey: "k", fetch: fetchImpl },
		);
		expect(xaiRes.audio).toEqual(new Uint8Array([5, 6]));

		expect(capturedRequests).toHaveLength(2);
		expect(capturedRequests[0]?.url).toBe(
			"https://api.openai.com/v1/audio/speech",
		);
		expect(capturedRequests[0]?.body).toEqual({
			model: "tts-1",
			input: "Route test",
			voice: "alloy",
			response_format: "mp3",
		});

		expect(capturedRequests[1]?.url).toBe("https://api.x.ai/v1/tts");
		expect(capturedRequests[1]?.body).toEqual({
			text: "Route test 2",
			voice_id: "eve",
			output_format: { codec: "wav", sample_rate: DEFAULT_XAI_SAMPLE_RATE },
		});

		// Assert xAI endpoint and schema are distinct from OpenAI
		expect(capturedRequests[1]?.url).not.toBe(capturedRequests[0]?.url);
		expect(capturedRequests[1]?.body.voice_id).toBe("eve");
		expect(capturedRequests[1]?.body.input).toBeUndefined();
		expect(capturedRequests[1]?.body.model).toBeUndefined();

		const unsupported = { ...openaiModel, api: "anthropic-messages" as Api };
		await expect(
			synthesizeSpeech(
				unsupported,
				{ text: "Fail", format: "mp3" },
				{ apiKey: "k", fetch: fetchImpl },
			),
		).rejects.toThrow(ConfigurationError);
	});
});
