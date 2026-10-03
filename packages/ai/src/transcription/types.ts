import type { Usage } from "@veyyon/catalog/types";

export type TranscriptionResponseFormat = "json" | "verbose_json";
export type TranscriptionTimestampGranularity = "word" | "segment";

export interface TranscriptionRequest {
	audio: Uint8Array;
	mimeType: string;
	fileName?: string;
	language?: string;
	prompt?: string;
	temperature?: number;
	responseFormat: TranscriptionResponseFormat;
	timestampGranularities?: TranscriptionTimestampGranularity[];
}

export type TranscriptionSegment = {
	id?: number | string;
	start: number;
	end: number;
	text: string;
	speaker?: number | string;
} & Record<string, unknown>;

export type TranscriptionWord = {
	word: string;
	start: number;
	end: number;
	speaker?: number | string;
	confidence?: number;
} & Record<string, unknown>;

export interface TranscriptionResult {
	text: string;
	language?: string;
	duration?: number;
	segments?: TranscriptionSegment[];
	words?: TranscriptionWord[];
	seconds?: number;
	usage: Usage;
}
