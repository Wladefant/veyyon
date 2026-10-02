import type { Api, Model } from "@veyyon/catalog/types";
import * as AIError from "../error";
import { postSpeechRequest } from "./transport";
import type { SpeechOptions, SpeechRequest, SpeechResult } from "./types";
export const DEFAULT_OPENAI_VOICE = "alloy";

export async function synthesizeOpenAiSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	if (request.sampleRate !== undefined) {
		throw new AIError.ValidationError("openai-speech does not support sampleRate");
	}
	if (request.bitRate !== undefined) {
		throw new AIError.ValidationError("openai-speech does not support bitRate");
	}
	const payload: Record<string, unknown> = {
		model: model.id,
		input: request.text,
		voice: request.voice ?? DEFAULT_OPENAI_VOICE,
		response_format: request.format,
		...(request.speed !== undefined ? { speed: request.speed } : {}),
		...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
	};
	return postSpeechRequest(model, "/audio/speech", payload, request.format, options);
}
