import type { ImageContent } from "@veyyon/model";
import { isRecord } from "@veyyon/utils";

export * from "./format";
export * from "./transport";
export * from "./types";

// RFC 6838 restricted-name.
const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/i;
const IMAGE_DETAILS: Record<string, true> = {
	auto: true,
	low: true,
	high: true,
	original: true,
};

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && IMAGE_MIME_TYPE.test(value);
}

/**
 * Whether a MIME type survives a data URL intact: a raw `#` starts a URL fragment and
 * data-URL consumers leave a `%23` escape undecoded, so no data-URL transport preserves it.
 */
export function isDataUrlMimeType(mimeType: string): boolean {
	return !mimeType.includes("#");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Why base64 image data is unusable; `undefined` when it is canonical and non-empty. */
export type Base64ImageDataFailure = "invalid base64 image data" | "empty image data";

/**
 * Validate standard base64 image data without decoding it. Padding may be omitted, but
 * present padding must be canonical, the trailing bits must be zero, and the data non-empty.
 */
export function base64ImageDataFailureReason(data: string): Base64ImageDataFailure | undefined {
	if (data.length === 0) return "empty image data";

	const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(data);
	if (!match) return "invalid base64 image data";
	const encoded = match[1];
	const paddingLength = match[2].length;
	const remainder = encoded.length % 4;
	if (remainder === 1 || (paddingLength === 1 && remainder !== 3) || (paddingLength === 2 && remainder !== 2)) {
		return "invalid base64 image data";
	}

	const lastSextet = BASE64_ALPHABET.indexOf(encoded[encoded.length - 1]);
	if ((remainder === 2 && (lastSextet & 0b1111) !== 0) || (remainder === 3 && (lastSextet & 0b11) !== 0)) {
		return "invalid base64 image data";
	}
	return undefined;
}

function isEmbeddedImageShape(image: unknown): image is ImageContent {
	return (
		isRecord(image) &&
		image.type === "image" &&
		typeof image.data === "string" &&
		isImageMimeType(image.mimeType) &&
		isDataUrlMimeType(image.mimeType) &&
		(image.detail === undefined || (typeof image.detail === "string" && Object.hasOwn(IMAGE_DETAILS, image.detail)))
	);
}

/** Whether a value is an embedded image with valid base64 data, MIME type, and detail. */
export function isEmbeddedImageContent(image: unknown): image is ImageContent {
	return isEmbeddedImageShape(image) && base64ImageDataFailureReason(image.data) === undefined;
}
