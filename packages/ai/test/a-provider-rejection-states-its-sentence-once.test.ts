/**
 * A provider's rejection reaches the operator with its sentence stated once.
 *
 * WHY: an OpenAI-shaped error is thrown as `<status> <sentence>` from the body the request captured,
 * and the message formatter then appended that body whenever the thrown message did not contain it
 * whole. A body that carries `type`, `param` or `code` renders with a `(type=… code=…)` suffix the
 * thrown message never contains, so every such rejection on the OpenAI-compatible paths printed its
 * sentence twice: `401 This API key has expired. …\nThis API key has expired. … (type=… code=…)`. A
 * 429 put the server-directed wait between the two copies.
 *
 * THE CLASS IT CLOSES: a provider sentence repeated in the message an operator reads, for every API
 * in the union at once, read from the registry at run time, across bodies with and without those
 * fields and with a server-directed wait. A new API is RED here until its row is decided.
 *
 * WHAT IT DOES NOT CATCH: a sentence the thrown message truncates at its bound still reads twice in
 * part, since the shortened copy is not the body's sentence; the wording around the sentence, which
 * `every-provider-refusal-names-what-to-do-about-it.test.ts` classifies; and whether a path shows the
 * body's fields at all, which the formatter's own cases in `http-inspector.test.ts` pin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import type { StreamOptions } from "@veyyon/ai/types";
import {
	API_PROBES,
	callStream,
	DEAD_ENDPOINT_URL,
	DEFAULT_PROBE_API_KEY,
	modelFor,
	pinProbeEnv,
	probeContext,
	restoreProbeEnv,
} from "./helpers/api-probes";
import { fetchThatRefuses, type RefusingHttp2Server, startRefusingHttp2Server } from "./helpers/refusing-transport";

const EXPIRED = "This API key has expired. Create a new API key in the console.";
const THROTTLED = "Too many requests in this window.";
const INVALID = "max_tokens must be positive.";

interface Rejection {
	arm: string;
	status: number;
	sentence: string;
	body: string;
	headers?: Record<string, string>;
}

const REJECTIONS: Rejection[] = [
	{
		arm: "401 with fields",
		status: 401,
		sentence: EXPIRED,
		body: JSON.stringify({ error: { message: EXPIRED, type: "authentication_error", code: "api_key_expired" } }),
	},
	{
		arm: "429 with fields and a wait",
		status: 429,
		sentence: THROTTLED,
		body: JSON.stringify({ error: { message: THROTTLED, type: "rate_limit_error", code: "rate_limited" } }),
		headers: { "retry-after": "120" },
	},
	{
		arm: "400 with fields",
		status: 400,
		sentence: INVALID,
		body: JSON.stringify({
			error: { message: INVALID, type: "invalid_request_error", param: "max_tokens", code: "invalid_value" },
		}),
	},
	{
		arm: "401 without fields",
		status: 401,
		sentence: EXPIRED,
		body: JSON.stringify({ error: { message: EXPIRED } }),
	},
];

/** Well above a rejection's real cost; a provider that retries a 429 is capped at 1 ms per wait. */
const BUDGET_MS = 20_000;
const BOUND_MS = 30_000;

let refusingHttp2 = new Map<string, RefusingHttp2Server>();

beforeAll(async () => {
	// Cursor speaks HTTP/2 directly and ignores `options.fetch`, so its rejection comes off a real socket.
	for (const rejection of REJECTIONS) {
		refusingHttp2.set(rejection.arm, await startRefusingHttp2Server(rejection.status, rejection.body));
	}
});

afterAll(async () => {
	for (const server of refusingHttp2.values()) await server.close();
	refusingHttp2 = new Map();
});

afterEach(() => {
	restoreProbeEnv();
});

/** The message an operator reads for `rejection` on `api`, or `OVERRAN` when none arrived in the bound. */
async function messageFor(api: string, rejection: Rejection): Promise<string> {
	const baseUrl = API_PROBES[api].http2
		? (refusingHttp2.get(rejection.arm)?.baseUrl ?? DEAD_ENDPOINT_URL)
		: DEAD_ENDPOINT_URL;
	const stopReading = new AbortController();
	const options: StreamOptions = {
		apiKey: API_PROBES[api].apiKey ?? DEFAULT_PROBE_API_KEY,
		fetch: fetchThatRefuses(rejection.status, rejection.body, rejection.headers),
		signal: stopReading.signal,
		streamFirstEventTimeoutMs: BUDGET_MS,
		streamIdleTimeoutMs: BUDGET_MS,
		maxRetryDelayMs: 1,
	};
	const settle = async (): Promise<string> => {
		try {
			const events = callStream(modelFor(api, baseUrl), probeContext, options);
			for await (const _event of events) {
				// A rejection arrives as an error event, a rejected result or a thrown call; all three end here.
			}
			const message = await events.result();
			return message.errorMessage ?? `stopReason:${message.stopReason}`;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	const overrun = Promise.withResolvers<string>();
	const timer = setTimeout(() => overrun.resolve("OVERRAN"), BOUND_MS);
	try {
		return await Promise.race([settle(), overrun.promise]);
	} finally {
		clearTimeout(timer);
		stopReading.abort();
	}
}

function timesStated(message: string, sentence: string): number {
	return message.split(sentence).length - 1;
}

/** Every API stating the sentence once. */
function onceOnEveryApi(): Record<string, number> {
	const table: Record<string, number> = {};
	for (const api of BUILTIN_API_IDS) table[api] = 1;
	return table;
}

/**
 * How many times each API states the provider's sentence, per rejection. A 0 is a path that answers
 * the rejection in its own words, recorded with its reason.
 */
const EXPECTED: Record<string, Record<string, number>> = {
	// GitLab Duo reaches a model through a namespace handshake, which answers a refusal with its own
	// remedy for the token or the namespace rather than the body's sentence.
	"401 with fields": { ...onceOnEveryApi(), "gitlab-duo-agent": 0 },
	// ChatGPT's 429 is a plan usage limit, stated in the path's own sentence with the wait it read.
	"429 with fields and a wait": { ...onceOnEveryApi(), "gitlab-duo-agent": 0, "openai-codex-responses": 0 },
	"400 with fields": { ...onceOnEveryApi(), "gitlab-duo-agent": 0 },
	"401 without fields": { ...onceOnEveryApi(), "gitlab-duo-agent": 0 },
};

describe("a provider rejection states its sentence once", () => {
	it("has a decision for every API in the union, on every rejection", () => {
		for (const rejection of REJECTIONS) {
			expect(Object.keys(EXPECTED[rejection.arm]).sort()).toEqual([...BUILTIN_API_IDS].sort());
		}
	});

	for (const rejection of REJECTIONS) {
		it(`states the sentence of a ${rejection.arm} once on every api`, async () => {
			pinProbeEnv();
			const observed: Record<string, number | string> = {};
			for (const api of BUILTIN_API_IDS) {
				const message = await messageFor(api, rejection);
				const times = timesStated(message, rejection.sentence);
				// A count that misses its row shows the message, so the diff reads as what the operator saw.
				observed[api] = times === EXPECTED[rejection.arm][api] ? times : `${times}x: ${message}`;
			}
			expect(observed).toEqual(EXPECTED[rejection.arm]);
		}, 180_000);
	}
});
