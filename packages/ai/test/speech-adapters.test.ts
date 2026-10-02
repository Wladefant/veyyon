import { describe, expect, it } from "bun:test";
import type { Api, FetchImpl, Model } from "@veyyon/catalog/types";
import { ConfigurationError, ValidationError } from "../src/error";
import { isSpeechApi, synthesizeOpenAiSpeech, synthesizeSpeech, synthesizeXaiSpeech } from "../src/speech";

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
	it("isSpeechApi recognizes speech APIs and rejects others", () => {
		expect(isSpeechApi("openai-speech")).toBe(true);
		expect(isSpeechApi("xai-tts")).toBe(true);
		expect(isSpeechApi("openai-completions")).toBe(false);
	});

	it("synthesizeOpenAiSpeech builds valid payload and rejects sampleRate/bitRate", async () => {
		let captured: { url: string; body: unknown } | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			captured = { url: String(input), body: JSON.parse(String(init?.body)) };
			return new Response(new Uint8Array([1, 2]), { status: 200 });
		};

		await synthesizeOpenAiSpeech(
			openaiModel,
			{ text: "Hello", format: "mp3", voice: "alloy", speed: 1.25, instructions: "cheerfully" },
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

		await expect(
			synthesizeOpenAiSpeech(openaiModel, { text: "err", format: "mp3", sampleRate: 16000 }, { apiKey: "k" }),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeOpenAiSpeech(openaiModel, { text: "err", format: "mp3", bitRate: 64000 }, { apiKey: "k" }),
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

		// Rejections: invalid format, speed, instructions, text length
		await expect(
			synthesizeXaiSpeech(xaiModel, { text: "t", format: "flac" }, { apiKey: "k" }),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(xaiModel, { text: "t", format: "mp3", speed: 1.5 }, { apiKey: "k" }),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(xaiModel, { text: "t", format: "mp3", instructions: "whisper" }, { apiKey: "k" }),
		).rejects.toThrow(ValidationError);
		await expect(
			synthesizeXaiSpeech(xaiModel, { text: "a".repeat(15001), format: "mp3" }, { apiKey: "k" }),
		).rejects.toThrow(ValidationError);
	});

	it("synthesizeSpeech routes to provider adapter and throws ConfigurationError on unsupported API", async () => {
		const fetchImpl: FetchImpl = async () => new Response(new Uint8Array([5, 6]), { status: 200 });

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

		const unsupported = { ...openaiModel, api: "anthropic-messages" as Api };
		await expect(
			synthesizeSpeech(unsupported, { text: "Fail", format: "mp3" }, { apiKey: "k", fetch: fetchImpl }),
		).rejects.toThrow(ConfigurationError);
	});
});
