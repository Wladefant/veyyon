import { retryResetTimezoneOffsetFor } from "@veyyon/catalog/compat/behavior";
import { extractRetryHint } from "@veyyon/utils/fetch-retry";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

/** Extracts retry timing using the provider's catalog-declared timestamp timezone. */
export function extractProviderRetryHint(
	provider: string | undefined,
	message: string | undefined,
): number | undefined {
	const naiveResetTimezoneOffset = provider === undefined ? undefined : retryResetTimezoneOffsetFor(provider);
	return extractRetryHint(undefined, message, { naiveResetTimezoneOffset });
}

const RETRY_AFTER_HINT = "retry-after-ms=";

export function formatErrorMessageWithRetryAfter(error: unknown, headers?: HeadersLike): string {
	let message: string;
	if (error instanceof Error) {
		message = error.message;
	} else {
		try {
			message = JSON.stringify(error) ?? String(error);
		} catch {
			try {
				message = String(error);
			} catch {
				message = "Unknown error";
			}
		}
	}
	if (message.includes(RETRY_AFTER_HINT)) {
		return message;
	}

	const retryAfterMs = getRetryAfterMsFromHeaders(headers ?? getHeadersFromError(error));
	if (retryAfterMs === undefined) {
		return message;
	}

	return `${message} ${RETRY_AFTER_HINT}${retryAfterMs}`;
}

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	try {
		let normalized: Headers;
		if (headers instanceof Headers) {
			normalized = headers;
		} else {
			normalized = new Headers();
			for (const [key, value] of Object.entries(headers)) {
				if (typeof value === "string") normalized.set(key, value);
			}
		}
		return extractRetryHint(normalized);
	} catch {
		// Header bags are provider-controlled and occasionally Proxy-backed. A
		// malformed bag must not replace the request error we are formatting.
		return undefined;
	}
}

export function getHeadersFromError(error: unknown): HeadersLike {
	const seen = new Set<object>();
	let current = error;
	while (current !== null && typeof current === "object") {
		if (seen.has(current)) return undefined;
		seen.add(current);
		try {
			const direct =
				("headers" in current ? extractHeaders(current.headers) : undefined) ?? responseHeaders(current);
			if (direct) return direct;
			current = "cause" in current ? current.cause : undefined;
		} catch {
			// Exotic errors can expose throwing getters or Proxy traps. Header
			// discovery is advisory and must never mask the original failure.
			return undefined;
		}
	}
	return undefined;
}

function responseHeaders(value: object): HeadersLike {
	if (!("response" in value)) return undefined;
	const response = value.response;
	if (response === null || typeof response !== "object" || !("headers" in response)) return undefined;
	return extractHeaders(response.headers);
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (!isHeaderRecord(value)) return undefined;
	return value;
}

function isHeaderRecord(value: unknown): value is Record<string, string | undefined> {
	if (value === null || typeof value !== "object") return false;
	return Object.values(value).every(entry => entry === undefined || typeof entry === "string");
}

