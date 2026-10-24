/**
 * JSON-POST → SSE transport for OpenAI-wire streaming endpoints (chat
 * completions, responses, azure responses). Replaces the `openai` SDK client:
 *
 * - Retries: `fetchWithRetry` (Retry-After/quota-hint aware; 5xx/408/429 and
 *   transient network errors). Default 6 total attempts — parity with the
 *   SDK's former `maxRetries: 5`.
 * - SSE decode: `readSseJson` (spec-compliant framing, `[DONE]`-aware).
 *   `onSseEvent` observers now receive real wire frames instead of events
 *   re-synthesized from decoded SDK objects.
 * - Errors: {@link OpenAIHttpError} exposes `status`/`headers`/`code`
 *   structurally (ProviderHttpError contract — `extractHttpStatusFromError`,
 *   retry-after extraction, copilot transient classification) and carries the
 *   captured response body for the strict-tools fallback and the responses
 *   chain-state detectors, which regex over `error.message`.
 */

import { readSseJson, type SseEventObserver } from "@veyyon/utils/stream";
import * as AIError from "../error";
import { OpenAIHttpError } from "../error";

export { OpenAIHttpError };

import type { FetchImpl } from "../types";
import { captureHttpErrorResponse } from "./http-inspector";
import { fetchProviderWithRetry } from "./provider-fetch";

/**
 * Total attempts (initial + retries). Parity with the removed SDK clients'
 * `maxRetries: 5`, i.e. 6 requests. Callers arming a first-event watchdog
 * stay bounded: the watchdog aborts the request `signal`, which
 * `fetchWithRetry` races on every attempt and every backoff sleep, so
 * transient 408/429/5xx retries can never extend the caller's deadline.
 */
const DEFAULT_MAX_ATTEMPTS = 6;

/** Bound the `Error.message` allocation for proxy HTML error pages and the like. */
const MAX_DETAIL_CHARS = 4096;
/** The most of a body that is not an event stream read to describe it. */
const MAX_NON_STREAM_BODY_CHARS = 65_536;
/** An event stream opens with a field name or a comment, never with markup or a JSON value. */
const NON_STREAM_BODY_LEAD = /^[<{[]/;

export interface OpenAIStreamRequestInit {
	url: string;
	headers: Record<string, string>;
	/** Fallback JSON body used when no per-attempt initializer is supplied. */
	body: unknown;
	/** Optional physical-attempt initializer. Rejections escape before fetch and are never treated as network retries. */
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	signal: AbortSignal;
	fetch?: FetchImpl;
	/**
	 * The longest single retry wait the caller will tolerate. A server hint above
	 * it returns the refusal immediately instead of sleeping on it. Omitted, the
	 * retry helper's own 60s cap applies.
	 */
	maxRetryDelayMs?: number;
	/** Raw wire-frame observer (`onSseEvent` debug pipeline). */
	onSseEvent?: SseEventObserver;
}

export interface OpenAIStreamHandle<TEvent> {
	/** Decoded `data:` payloads; terminates on `[DONE]` or stream end. */
	events: AsyncGenerator<TEvent>;
	response: Response;
	/** `x-request-id` response header (the SDK's former `request_id`). */
	requestId: string | null;
}

/**
 * POST a JSON body and stream back decoded SSE events.
 *
 * Throws {@link OpenAIHttpError} on a non-2xx terminal response. Aborts on
 * `signal` propagate from `fetchWithRetry`/`readSseJson`; callers own the
 * watchdog timers and abort-reason bookkeeping.
 */
export async function postOpenAIStream<TEvent>(init: OpenAIStreamRequestInit): Promise<OpenAIStreamHandle<TEvent>> {
	const response = await fetchProviderWithRetry(init.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...init.headers },
		body: JSON.stringify(init.body),
		signal: init.signal,
		fetch: init.fetch,
		prepareInit: init.prepareInit,
		maxAttempts: DEFAULT_MAX_ATTEMPTS,
		maxDelayMs: init.maxRetryDelayMs,
		// Bun's native fetch enforces a hard ~300s pre-response timeout (issue #2422).
		// Cold large-context streams legitimately exceed it; the caller's
		// `firstEventTimeoutMs`/`AbortSignal` already govern stuck requests.
		timeout: false,
	});
	if (!response.ok) {
		throw await captureOpenAIHttpError(response);
	}
	if (!response.body) {
		// A 2xx with no body is an empty body, not a malformed envelope: nothing was
		// produced, so the request is safe to run again.
		throw new AIError.ProviderResponseError(`OpenAI stream response has no body (status ${response.status})`, {
			kind: "empty-body",
		});
	}
	return {
		events: readSseJson<TEvent>(
			await eventStreamBody(response, response.body, init.url),
			init.signal,
			init.onSseEvent,
		),
		response,
		requestId: response.headers.get("x-request-id"),
	};
}

/**
 * The body as an event stream, or the failure it is instead.
 *
 * A body labelled `text/event-stream` is read as it is. Any other body is read up to its first
 * non-blank byte: an event stream never opens with `<`, `{` or `[`, so a body that does is an HTML
 * page or a JSON document, and the endpoint answers it on every attempt. Read as an event stream it
 * held no events, and the turn was retried as a truncated stream until the retry budget ran out. A
 * mislabelled event stream is replayed from the bytes already read.
 */
async function eventStreamBody(
	response: Response,
	body: ReadableStream<Uint8Array>,
	url: string,
): Promise<ReadableStream<Uint8Array>> {
	const contentType = response.headers.get("content-type");
	if (contentType !== null && /^\s*text\/event-stream\b/i.test(contentType)) return body;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const held: Uint8Array[] = [];
	let text = "";
	while (text.trimStart().length === 0) {
		const { done, value } = await reader.read();
		if (done) break;
		held.push(value);
		text += decoder.decode(value, { stream: true });
	}
	if (!NON_STREAM_BODY_LEAD.test(text.trimStart())) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of held) controller.enqueue(chunk);
			},
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		});
	}
	while (text.length < MAX_NON_STREAM_BODY_CHARS) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	await reader.cancel().catch(() => {});
	throw nonStreamBodyError(response.status, url, text.trim());
}

/**
 * The failure a `2xx` body that is not an event stream states: the provider's own sentence when it
 * is an error envelope, which classifies as the same sentence would on a non-`2xx` answer, and what
 * came back and from where otherwise. Not retried unless that sentence reads as transient.
 */
function nonStreamBodyError(status: number, url: string, body: string): AIError.ProviderResponseError {
	let where = url;
	try {
		const parsed = new URL(url);
		where = `${parsed.origin}${parsed.pathname}`;
	} catch {}
	if (body.startsWith("<")) {
		const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
		const named = title ? ` titled "${title.slice(0, 120)}"` : "";
		return new AIError.ProviderResponseError(
			`${status} from ${where} is an HTML page${named}, not an event stream. Check the provider's baseUrl.`,
			{ kind: "envelope" },
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {}
	const { detail } = OpenAIHttpError.parseEnvelope(json, undefined);
	if (detail) {
		const bounded = detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail;
		return new AIError.ProviderResponseError(`${status} ${bounded}`, { kind: "envelope" });
	}
	return new AIError.ProviderResponseError(
		`${status} from ${where} is a JSON document, not an event stream. Check the provider's baseUrl and that the endpoint streams.`,
		{ kind: "envelope" },
	);
}

/** Decode a non-2xx response into an {@link OpenAIHttpError} without consuming it twice. */
export async function captureOpenAIHttpError(response: Response): Promise<AIError.OpenAIHttpError> {
	const captured = await captureHttpErrorResponse(response);
	const { detail, code } = OpenAIHttpError.parseEnvelope(captured.bodyJson, captured.bodyText);
	// "status code (no body)" matches the SDK's former APIError phrasing;
	// `finalizeErrorMessage` keys a repair path on that exact wording.
	const message = detail
		? `${response.status} ${detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail}`
		: `${response.status} status code (no body)`;
	return new AIError.OpenAIHttpError(message, captured, code);
}
