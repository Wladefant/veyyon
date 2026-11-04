/**
 * DeepSeek Fetch client: a URL in, the page's title and Markdown content out.
 *
 * This is the Fetch half of DeepSeek's Search & Fetch API. It authenticates with the same bearer
 * key as the `deepseek` model provider, and DeepSeek bills each successful call once, so a caller
 * that runs it inside a fallback ladder must treat it as a remote reader rather than a free one.
 * https://api-docs.deepseek.com/api/fetch
 */
import type { FetchImpl } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { isRecord } from "@veyyon/utils/type-guards";
import type { CredentialStore } from "./credentials";
import { findCredential } from "./credentials";

export const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

/** The page DeepSeek returned. `title` is empty when the page has none. */
export interface DeepSeekFetchDocument {
	title: string;
	content: string;
}

export interface DeepSeekFetchOptions {
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/** A DeepSeek API refusal, carrying the HTTP status so a caller can classify it. */
export class DeepSeekApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "DeepSeekApiError";
		this.statusCode = statusCode;
	}
}

/**
 * Find the key the `deepseek` model provider would use: `DEEPSEEK_API_KEY` first, then the stored
 * `deepseek` api_key. One key serves chat, Search and Fetch, so a machine that can run the model
 * can read a page with this client.
 */
export function findDeepSeekApiKey(storage: CredentialStore | null | undefined): string | null {
	return findCredential(storage, getEnvApiKey("deepseek"), "deepseek");
}

/**
 * Read one page as Markdown through DeepSeek's Fetch API.
 *
 * The caller owns the deadline. The fetch tool runs every remote reader under its own bounded
 * signal (so one stalled endpoint cannot starve the local renderers), and this client adds no
 * second timer of its own on top of it.
 */
export async function fetchWithDeepSeek(
	url: string,
	apiKey: string,
	options: DeepSeekFetchOptions = {},
): Promise<DeepSeekFetchDocument> {
	const response = await (options.fetch ?? fetch)(DEEPSEEK_FETCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ url }),
		signal: options.signal,
	});

	if (!response.ok) {
		throw parseDeepSeekErrorResponse(response.status, await response.text());
	}

	return parseDeepSeekFetchPayload(await response.json());
}

/**
 * The `title`/`content` pair from a Fetch response.
 *
 * Empty content is returned as empty rather than thrown: the reader ladder treats a page it cannot
 * use as a reason to try the next backend, and only a payload that is not an object at all breaks
 * the documented contract.
 */
export function parseDeepSeekFetchPayload(payload: unknown): DeepSeekFetchDocument {
	if (!isRecord(payload)) {
		throw new DeepSeekApiError("DeepSeek Fetch returned an invalid response payload.");
	}

	return {
		title: typeof payload.title === "string" ? payload.title : "",
		content: typeof payload.content === "string" ? payload.content : "",
	};
}

/**
 * A refusal from either DeepSeek endpoint, as an error carrying its status.
 *
 * Search and Fetch both answer errors in the OpenAI-compatible shape
 * `{"error":{"message":…,"type":…,"code":…}}`, so the nested message is what a reader needs; a body
 * that is not that shape is reported verbatim instead of being swallowed.
 */
export function parseDeepSeekErrorResponse(statusCode: number, responseText: string): DeepSeekApiError {
	const trimmed = responseText.trim();
	if (trimmed.length === 0) {
		return new DeepSeekApiError(`DeepSeek API error (${statusCode})`, statusCode);
	}

	let detail = trimmed;
	try {
		const payload: unknown = JSON.parse(trimmed);
		const nested = isRecord(payload) ? payload.error : undefined;
		if (isRecord(nested) && typeof nested.message === "string") detail = nested.message;
	} catch {
		// Not JSON: the raw body is all the detail there is.
	}

	return new DeepSeekApiError(`DeepSeek API error (${statusCode}): ${detail}`, statusCode);
}
