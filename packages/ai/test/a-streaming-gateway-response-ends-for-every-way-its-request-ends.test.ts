/**
 * WHY THIS SUITE EXISTS. Every streaming completion route of the auth gateway encodes its wire
 * through one response body, `gatewayResponseStream`, which ends the body when the request ends:
 * a request that aborted before the body started closes it with no frames, a client that cancels
 * the body reaches `control.onCancel` (which aborts the upstream call), and an upstream stream that
 * throws ends the body with the format's error frame. Before that body existed each format kept its
 * own copy of this lifecycle, and a copy that drops one step leaves a client waiting on a body
 * that never closes or an upstream call that runs after its client left.
 *
 * The sweep is keyed by `AUTH_GATEWAY_COMPLETION_PATHS`, so a new completion route fails here until
 * its encoder joins the table. Every read is bounded, so a body that never ends fails by its bound
 * rather than by the test runner's timeout.
 *
 * NOT CAUGHT: frames written after a request abort while the client still reads (the gateway's
 * HTTP layer drops such a body), and the Anthropic keepalive ping, whose timer is not observable
 * on the wire within a test's lifetime.
 */
import { describe, expect, it } from "bun:test";
import { AUTH_GATEWAY_COMPLETION_PATHS, type AuthGatewayStreamControl } from "@veyyon/ai/auth-gateway";
import { gatewayResponseStream } from "@veyyon/ai/auth-gateway/response-stream";
import * as anthropicMessages from "@veyyon/ai/providers/anthropic-messages-server";
import * as openaiChat from "@veyyon/ai/providers/openai-chat-server";
import * as openaiResponses from "@veyyon/ai/providers/openai-responses-server";
import * as piNative from "@veyyon/ai/providers/pi-native-server";
import type { AssistantMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";


type EncodeStream = (
	events: AssistantMessageEventStream,
	requestedModelId: string,
	options: undefined,
	control: AuthGatewayStreamControl,
) => ReadableStream<Uint8Array>;

/** The encoder each completion route streams through. */
const ENCODERS: Record<string, EncodeStream> = {
	"/v1/chat/completions": openaiChat.encodeStream,
	"/v1/messages": anthropicMessages.encodeStream,
	"/v1/responses": openaiResponses.encodeStream,
	"/v1/pi/stream": piNative.encodeStream,
};

const ROUTES = Object.keys(ENCODERS).sort();

function encoderFor(route: string): EncodeStream {
	const encode = ENCODERS[route];
	if (!encode) throw new Error(`no encoder for ${route}`);
	return encode;
}
const BOUND_MS = 2_000;
const MODEL = "claude-sonnet-4-5";

function partial(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** Events through a first text delta, the point every format has written at least one frame. */
function startedEvents(): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	const message = partial();
	events.push({ type: "start", partial: message });
	events.push({ type: "text_start", contentIndex: 0, partial: message });
	events.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: message });
	return events;
}

async function within<T>(work: Promise<T>, what: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${what} did not settle within ${BOUND_MS} ms`)), BOUND_MS);
	try {
		return await Promise.race([work, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** The whole body as text, failing when it does not end within the bound. */
async function readToEnd(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await within(reader.read(), "the response body");
		if (done) return text + decoder.decode();
		text += decoder.decode(value, { stream: true });
	}
}

describe("a streaming gateway response ends for every way its request ends", () => {
	it("covers every completion route the gateway serves", () => {
		expect(ROUTES).toEqual([...AUTH_GATEWAY_COMPLETION_PATHS].sort());
	});

	it.each(ROUTES)("%s: a request aborted before the body starts closes it with no frames", async route => {
		const request = new AbortController();
		request.abort();
		const cancels: unknown[] = [];
		const body = encoderFor(route)(startedEvents(), MODEL, undefined, {
			signal: request.signal,
			onCancel: reason => cancels.push(reason),
		});

		expect({ body: await readToEnd(body), cancels }).toEqual({ body: "", cancels: [] });
	});

	it.each(ROUTES)("%s: a client that cancels the body hands its reason to onCancel", async route => {
		const cancels: unknown[] = [];
		const body = encoderFor(route)(startedEvents(), MODEL, undefined, {
			signal: new AbortController().signal,
			onCancel: reason => cancels.push(reason),
		});
		const reader = body.getReader();
		const first = await within(reader.read(), "the first frame");
		expect(first.done).toBe(false);

		await within(reader.cancel("client closed the connection"), "the cancel");

		expect(cancels).toEqual(["client closed the connection"]);
	});

	it.each(ROUTES)(
		"%s: an upstream stream that throws ends the body with an error frame naming the cause",
		async route => {
			const events = startedEvents();
			const cancels: unknown[] = [];
			const body = encoderFor(route)(events, MODEL, undefined, {
				signal: new AbortController().signal,
				onCancel: reason => cancels.push(reason),
			});
			const text = readToEnd(body);
			events.fail(new Error("upstream socket reset"));

			const written = await text;
			expect(written).toContain("hello");
			expect(written).toContain("upstream socket reset");
			expect(written.indexOf("upstream socket reset")).toBeGreaterThan(written.indexOf("hello"));
			expect(cancels).toEqual([]);
		},
	);

	it("an encoder that cannot be built errors the body instead of leaving it open", async () => {
		const body = gatewayResponseStream(undefined, () => {
			throw new Error("encoder state rejected the request");
		});

		await expect(readToEnd(body)).rejects.toThrow("encoder state rejected the request");
	});
});
