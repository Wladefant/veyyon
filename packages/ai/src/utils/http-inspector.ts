import * as path from "node:path";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { getLogsDir } from "@veyyon/utils/dirs";
import { isBunTestRuntime } from "@veyyon/utils/env";
import { asRecord, errorMessage, getNonBlankStringProperty, isRecord } from "@veyyon/utils/type-guards";
import {
	MAX_PROVIDER_ERROR_BODY_BYTES,
	type ProviderErrorBody,
	providerErrorEnvelopeMessage,
	readProviderErrorBody,
} from "../error/error-body";
import * as AIError from "../error/flags";
import { ProviderResponseError } from "../error/provider";
import { redactDiagnosticHeaders } from "./request-debug.js";
import { appendRetryAfterHint, errorText } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

/**
 * Attach the request body to a dump at error time. Providers retain only the
 * exact sent bytes for the life of a stream — holding the parsed object pinned
 * a full context-sized clone on every in-flight request just to serve a
 * hypothetical 400/413 dump. This parses those bytes back into `body` once,
 * when a dump is actually being built; bytes that never parse (never sent, or
 * truncated by an abort) leave `body` unset rather than fabricating one.
 */
export function materializeDumpBody(
	dump: RawHttpRequestDump | undefined,
	wireBodyJson: string | undefined,
): RawHttpRequestDump | undefined {
	if (!dump || wireBodyJson === undefined) return dump;
	if (dump.body !== undefined) return dump;
	try {
		dump.body = JSON.parse(wireBodyJson) as unknown;
	} catch {
		// Unparseable body: the dump still carries method/url/headers.
	}
	return dump;
}

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

/**
 * Capture a non-2xx response body for error reporting. The body is read once;
 * a JSON body is parsed opportunistically (a non-JSON or unreadable body still
 * yields a useful capture — the caller is already on an error path, so capture
 * failures degrade to a status-only record rather than masking the HTTP error).
 */
export async function captureHttpErrorResponse(response: Response): Promise<CapturedHttpErrorResponse> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim().length > 0) {
			try {
				bodyJson = JSON.parse(bodyText) as unknown;
			} catch {
				// Non-JSON error body: keep the raw text.
			}
		} else {
			bodyText = undefined;
		}
	} catch {
		// Body unreadable (already consumed / stream fault): status-only capture.
	}
	return { status: response.status, headers: response.headers, bodyText, bodyJson };
}

/** An event stream opens with a field name, a comment or a blank line, never with markup or a JSON value. */
const NON_EVENT_STREAM_LEAD = /^[<{[]/;
/** The most of an HTML page's title a failure quotes. */
const MAX_QUOTED_TITLE_CHARS = 120;

/**
 * `body` as an event stream, or a stream that fails with what the body is instead.
 *
 * A body labelled `text/event-stream` is returned as it is. Any other body is read on its first pull
 * up to its first non-blank byte, within the provider error-body byte ceiling. A prefix that exhausts
 * that ceiling is cancelled and rejected rather than buffered indefinitely. An event stream never
 * opens with `<`, `{` or `[`. Such a body is HTML or JSON, returned on every attempt: decoded as
 * an event stream it held no events, the turn failed as a truncated stream, and the truncated stream
 * was retried until the retry budget ran out. Such a body fails the stream with what it is and where
 * it came from; a mislabelled event stream is replayed from the bytes already read. The check runs
 * inside the stream, so the caller's first-event and idle deadlines cover it.
 */
export function eventStreamBody(
	response: Response,
	body: ReadableStream<Uint8Array>,
	url: string | undefined,
): ReadableStream<Uint8Array> {
	const contentType = response.headers.get("content-type");
	if (contentType !== null && /^\s*text\/event-stream\b/i.test(contentType)) return body;
	const reader = body.getReader();
	let checked = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (checked) {
					const { done, value } = await reader.read();
					if (done) controller.close();
					else controller.enqueue(value);
					return;
				}
				checked = true;
				const held: Uint8Array[] = [];
				let heldBytes = 0;
				const decoder = new TextDecoder();
				let lead = "";
				let ended = false;
				while (lead.length === 0) {
					const { done, value } = await reader.read();
					if (done) {
						ended = true;
						break;
					}
					if (value.byteLength === 0) continue;
					const room = MAX_PROVIDER_ERROR_BODY_BYTES - heldBytes;
					lead = decoder.decode(value.subarray(0, room), { stream: true }).trimStart();
					if (lead.length === 0 && value.byteLength >= room) {
						await reader.cancel().catch(() => {});
						throw new ProviderResponseError(
							`${response.status} response has no event-stream content within the first ${MAX_PROVIDER_ERROR_BODY_BYTES} bytes. Check the provider's baseUrl.`,
							{ kind: "envelope" },
						);
					}
					held.push(value);
					heldBytes += value.byteLength;
				}
				if (NON_EVENT_STREAM_LEAD.test(lead)) {
					const read = await readProviderErrorBody({
						body: replayed(
							held,
							() => reader.read(),
							reason => reader.cancel(reason),
						),
						headers: response.headers,
						text: () => Promise.resolve(""),
					});
					throw nonEventStreamError(response.status, url, read);
				}
				for (const chunk of held) controller.enqueue(chunk);
				if (ended) controller.close();
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

/** `held`, then what `next` reads; cancelling it calls `cancel`. */
function replayed(
	held: Uint8Array[],
	next: () => Promise<{ done: boolean; value?: Uint8Array }>,
	cancel: (reason: unknown) => Promise<void>,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of held) controller.enqueue(chunk);
		},
		async pull(controller) {
			const { done, value } = await next();
			if (done || value === undefined) controller.close();
			else controller.enqueue(value);
		},
		cancel,
	});
}

/**
 * The failure a `2xx` body that is not an event stream states: the provider's own sentence when it
 * is a JSON error envelope, which classifies as that sentence does on any other answer, and what came
 * back and from where otherwise. The endpoint is stated without its query string, which can hold a
 * key. Not retried unless the provider's sentence reads as transient.
 */
function nonEventStreamError(status: number, url: string | undefined, read: ProviderErrorBody): ProviderResponseError {
	let from = "";
	if (url) {
		try {
			const parsed = new URL(url);
			from = ` from ${parsed.origin}${parsed.pathname}`;
		} catch {}
	}
	const text = read.text.trimStart();
	if (text.startsWith("<")) {
		const title = collapseWhitespace(/<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]);
		const named = title ? ` titled "${title.slice(0, MAX_QUOTED_TITLE_CHARS)}"` : "";
		return new ProviderResponseError(
			`${status}${from} is an HTML page${named}, not an event stream. Check the provider's baseUrl.`,
			{ kind: "envelope" },
		);
	}
	const sentence = providerErrorEnvelopeMessage(read);
	if (sentence) return new ProviderResponseError(`${status} ${sentence}`, { kind: "envelope" });
	return new ProviderResponseError(
		`${status}${from} is a JSON document, not an event stream. Check the provider's baseUrl and that the endpoint streams.`,
		{ kind: "envelope" },
	);
}

/**
 * Build the JSON persisted for a rejected request. Request fields stay at the
 * top level (so existing dump parsers still read `body`); the provider's error
 * is added under `errorResponse` so a failed request is diagnosable from the
 * dump file rather than the request alone.
 */
export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

/** HTTP statuses whose rejected request we persist for post-hoc diagnosis: the
 *  request-content rejections that wedge a session. 400 (bad request) and 413
 *  (payload too large — an oversized image payload that 413s
 *  and empties the turn). Auth (401/403), not-found (404), rate limits and 5xx
 *  are excluded: 429/5xx are retried, so persisting them here would write one
 *  dump per attempt. */
export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	// Never persist dumps under the test runner: providers exercise the 400 path
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(payload)).toString(36)}.json`;
	const filePath = path.join(getLogsDir(), "http-400-requests", fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		return `${message}\nraw-http-request-save-failed=${errorMessage(writeError)}`;
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	const message = appendRetryAfterHint(
		withCapturedBody(errorText(error), capturedErrorResponse),
		error,
		capturedErrorResponse?.headers,
	);
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

/**
 * `message` with what the captured body states that it does not. A provider error is usually thrown
 * as `<status> <sentence>` from the same body, so when `message` ends with the body's sentence only
 * the body's `type`/`param`/`code` fields are added to it; a body whose sentence `message` does not
 * end with (an `HTTP 401 from <url>`, or a body embedded as JSON) is added on its own line.
 */
function withCapturedBody(message: string, captured: CapturedHttpErrorResponse | undefined): string {
	const body = readCapturedHttpError(captured);
	if (!body) return message;
	const stated = body.fields === undefined ? body.sentence : `${body.sentence} (${body.fields})`;
	if (/\bstatus code\s*\(no body\)/i.test(message)) return `${captured?.status ?? "HTTP"} status code: ${stated}`;
	if (message.includes(stated)) return message;
	if (body.fields !== undefined && message.endsWith(body.sentence)) return `${message} (${body.fields})`;
	return `${message}\n${stated}`;
}

/**
 * Rewrite error message for GitHub Copilot request failures.
 * Must run AFTER finalizeErrorMessage since it replaces the message entirely.
 *
 * 400 `model_not_supported` = Copilot routing rollout gap for our OAuth client.
 *        A preview model (gpt-5.3-codex, gpt-5.4*, ...) flaps between 200 and
 *        400 because only some of Copilot's backends have the model. After the
 *        in-request retry exhausts, surface guidance rather than the raw error.
 * 401 = token invalid/expired → credential removal is safe, prompt re-login.
 * 403 = token valid but access denied (plan, model policy, org restriction) →
 *       do NOT reuse the auth-failed string (which triggers credential removal).
 */
export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your account may not have access to this model or feature. Check your Copilot plan or model policy settings.`;
	}
	if (AIError.isCopilotTransientModelError(error)) {
		return `GitHub Copilot rejected this model (HTTP 400 model_not_supported) after retries. This is a known intermittent rollout gap for preview models on OAuth clients other than VS Code. Try again in a few seconds, switch to a GA model (gpt-5-mini, gpt-5.2), or run this model from VS Code.`;
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		headers: redactHeaders(dump.headers),
	};
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	return redactDiagnosticHeaders(Object.entries(headers));
}

/** A captured error body as an operator reads it: the provider's sentence and its machine fields. */
interface CapturedHttpErrorText {
	sentence: string;
	/** `type=… param=… code=…`, or undefined when the body states none of them. */
	fields: string | undefined;
}

function readCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): CapturedHttpErrorText | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return { sentence: bodyText, fields: undefined };

	const errorPayload = asRecord(payload.error) ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getNonBlankStringProperty(payload, "error") : undefined;
	const sentence =
		getNonBlankStringProperty(errorPayload, "message") ??
		getNonBlankStringProperty(payload, "message") ??
		stringError ??
		bodyText;
	const fields = (["type", "param", "code"] as const)
		.map(field => {
			const value = getNonBlankStringProperty(errorPayload, field) ?? getNonBlankStringProperty(payload, field);
			return value === undefined ? undefined : `${field}=${value}`;
		})
		.filter((entry): entry is string => entry !== undefined);
	return { sentence, fields: fields.length > 0 ? fields.join(" ") : undefined };
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isRecord(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		// Data tolerance: an error body is provider-controlled text; non-JSON
		// falls through to the raw-bodyText rendering above.
		return asRecord(JSON.parse(captured.bodyText)) ?? undefined;
	} catch {
		return undefined;
	}
}
