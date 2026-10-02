import type { FetchImpl, Model } from "@veyyon/catalog/types";
import type { ApiKey } from "../auth-retry";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { errorMessage, ImageApiError, USER_AGENT } from "./format";

export async function modelHeaders(model: Model, signal?: AbortSignal): Promise<Record<string, string>> {
	const resolve = Reflect.get(model, "resolveHeaders");
	if (typeof resolve === "function") {
		const dynamic = (await resolve(signal)) as Record<string, string> | undefined;
		return { ...model.headers, ...dynamic };
	}
	return { ...model.headers };
}

export function redactKey(text: string, key?: string): string {
	if (!key || key.length === 0) return text;
	return text.replaceAll(key, "[REDACTED]");
}

function sanitizeHeaders(raw: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		const lower = k.toLowerCase();
		if (lower !== "authorization" && lower !== "content-type" && lower !== "user-agent") out[k] = v;
	}
	return out;
}

async function parseImageApiResponse(model: Model, response: Response, key?: string): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		const sanitized = redactKey(errorMessage(text), key);
		throw new ImageApiError(
			`${model.provider}/${model.id} image request failed (${response.status}): ${sanitized}`,
			response.status,
			{ headers: response.headers },
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new AIError.ProviderResponseError("Image API returned malformed JSON", {
			provider: model.provider,
			kind: "envelope",
			cause,
		});
	}
}

export async function postJson(options: {
	model: Model;
	url: string;
	body: unknown;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const headers = sanitizeHeaders(await modelHeaders(options.model, options.signal));
			headers["Authorization"] = `Bearer ${key}`;
			headers["Content-Type"] = "application/json";
			headers["User-Agent"] = USER_AGENT;
			const response = await options.fetch(options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(options.body),
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response, key);
		},
		{ signal: options.signal },
	);
}

export async function postMultipart(options: {
	model: Model;
	url: string;
	body: FormData;
	apiKey: ApiKey;
	fetch: FetchImpl;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const headers = sanitizeHeaders(await modelHeaders(options.model, options.signal));
			headers["Authorization"] = `Bearer ${key}`;
			headers["User-Agent"] = USER_AGENT;
			const response = await options.fetch(options.url, {
				method: "POST",
				headers,
				body: options.body,
				signal: options.signal,
			});
			return parseImageApiResponse(options.model, response, key);
		},
		{ signal: options.signal },
	);
}
