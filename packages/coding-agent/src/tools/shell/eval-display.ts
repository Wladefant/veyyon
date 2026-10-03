import { EVAL_DISPLAY_VERSION } from "@veyyon/kernel/session/session-migrations";
import { truncateHeadBytes } from "../../session/streaming-output";

export { EVAL_DISPLAY_VERSION };
const MAX_DISPLAY_TEXT_BYTES = 8000;
const DISPLAY_ELISION_RESERVE_BYTES = 64;

export interface FormattedDisplayJson {
	fullText: string;
	previewText: string;
	detailsValue: unknown;
	truncated: boolean;
}

export function formatDisplayJson(value: unknown): FormattedDisplayJson {
	let fullText: string;
	try {
		fullText = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		fullText = String(value);
	}
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= MAX_DISPLAY_TEXT_BYTES) {
		return { fullText, previewText: fullText, detailsValue: value, truncated: false };
	}
	const head = truncateHeadBytes(fullText, MAX_DISPLAY_TEXT_BYTES - DISPLAY_ELISION_RESERVE_BYTES);
	let elidedCodePoints = 0;
	for (let index = head.text.length; index < fullText.length; elidedCodePoints++) {
		index += (fullText.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
	}
	const previewText = `${head.text}\n[…${elidedCodePoints}ch elided…]`;
	return {
		fullText,
		previewText,
		detailsValue: { version: EVAL_DISPLAY_VERSION, preview: previewText, truncated: true, totalBytes },
		truncated: true,
	};
}

export function formatDisplayJsonForText(value: unknown): string {
	return formatDisplayJson(value).previewText;
}
