import type { FetchImpl, Model, Usage } from "@veyyon/catalog/types";
import { parseImageMetadata, VERSION } from "@veyyon/utils";
import * as AIError from "../error";
import type { GeneratedImage } from "./types";

export const USER_AGENT = `veyyon/${VERSION}`;

export class ImageApiError extends AIError.ProviderHttpError {
	override readonly name = "ImageApiError";
}

export function emptyUsage(input = 0, output = 0, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export function usageFromWire(value: unknown): Usage {
	if (value === null || typeof value !== "object") return emptyUsage();
	const read = (key: string): number => {
		const val = Reflect.get(value, key);
		return typeof val === "number" ? val : 0;
	};
	return emptyUsage(
		read("input_tokens") || read("prompt_tokens"),
		read("output_tokens") || read("completion_tokens"),
		read("cost"),
	);
}

export function imageBaseUrl(model: Model): string {
	if (!model.baseUrl)
		throw new AIError.ValidationError(
			`Image model ${model.provider}/${model.id} has no base URL`,
		);
	return model.baseUrl.replace(/\/+$/, "");
}

export function errorMessage(rawText: string): string {
	try {
		const parsed = JSON.parse(rawText);
		if (parsed && typeof parsed === "object") {
			const detail = Reflect.get(parsed, "detail");
			if (typeof detail === "string") return detail;
			const error = Reflect.get(parsed, "error");
			if (error && typeof error === "object") {
				const message = Reflect.get(error, "message");
				if (typeof message === "string") return message;
			}
		}
		return rawText;
	} catch {
		return rawText;
	}
}

export async function imageFromUrl(
	url: string,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		const text = await response.text();
		throw new ImageApiError(
			`Image download failed (${response.status}): ${text}`,
			response.status,
			{
				headers: response.headers,
			},
		);
	}
	const mimeType = response.headers.get("content-type")?.split(";")[0];
	if (!mimeType?.startsWith("image/")) {
		throw new AIError.ProviderResponseError(
			`Image URL returned unsupported content type: ${mimeType ?? "missing"}`,
			{
				kind: "envelope",
			},
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

export async function decodeImageResponse(
	value: unknown,
	fetch: FetchImpl,
	signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; usage: Usage }> {
	if (value === null || typeof value !== "object") {
		throw new AIError.ProviderResponseError(
			"Image API returned a malformed response",
			{ kind: "envelope" },
		);
	}
	const data = Reflect.get(value, "data");
	if (!Array.isArray(data)) {
		throw new AIError.ProviderResponseError(
			"Image API response is missing data",
			{ kind: "envelope" },
		);
	}
	const images: GeneratedImage[] = [];
	for (const item of data) {
		if (item === null || typeof item !== "object") continue;
		const b64Json = Reflect.get(item, "b64_json");
		const url = Reflect.get(item, "url");
		const mediaType = Reflect.get(item, "media_type");
		if (typeof b64Json === "string" && b64Json.length > 0) {
			const bytes = Buffer.from(b64Json, "base64");
			const mimeType =
				typeof mediaType === "string"
					? mediaType
					: (parseImageMetadata(bytes)?.mimeType ?? "image/png");
			images.push({ data: b64Json, mimeType });
		} else if (typeof url === "string" && url.length > 0) {
			images.push(await imageFromUrl(url, fetch, signal));
		}
	}
	const usage = Reflect.get(value, "usage");
	return { images, usage: usageFromWire(usage) };
}

export function toDataUrl(image: GeneratedImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

export function resolveOpenAIImageSize(
	aspectRatio?: string,
	imageSize?: string,
): string | undefined {
	if (imageSize) return imageSize;
	if (aspectRatio === "1:1") return "1024x1024";
	if (aspectRatio === "3:4" || aspectRatio === "9:16") return "1024x1536";
	if (aspectRatio === "4:3" || aspectRatio === "16:9") return "1536x1024";
	return undefined;
}
