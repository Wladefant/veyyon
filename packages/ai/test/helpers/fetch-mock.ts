import type { FetchImpl } from "../../src/types";

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

/** Wrap a fetch handler as a {@link FetchImpl}, normalizing sync `Response` returns. */
export function mockFetch(fn: FetchHandler): FetchImpl {
	return async (input, init) => fn(input, init);
}

/** A 200 `text/event-stream` response holding one `data:` frame per event: a string is sent as is, anything else as JSON. */
export function sseResponse(events: readonly unknown[], headers: Record<string, string> = {}): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

/** A fetch that answers every request with a fresh {@link sseResponse} of `events`. */
export function sseFetch(events: readonly unknown[]): FetchImpl {
	return mockFetch(() => sseResponse(events));
}
