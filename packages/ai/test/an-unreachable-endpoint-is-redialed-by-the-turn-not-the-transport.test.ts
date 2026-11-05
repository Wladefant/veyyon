/**
 * WHY. A dial that reached no peer -- nothing listening on the port, no route to the host or its
 * network, a resolver that could not answer for now -- was redialed by the provider's own transport
 * ladder, which nothing on screen shows, and the turn ladder then ran that whole ladder again inside
 * every one of its own attempts. A local server that was not running held a turn on "Working..." for
 * minutes before the error appeared, and Anthropic's error read "Connection error." with the errno
 * gone, so the operator could not tell a stopped server from a mistyped host.
 *
 * The class this closes: an API whose transport stage redials an unreachable peer, an API whose
 * failure reaches the turn without the errno that names it, and an API whose unreachable failure the
 * turn does not retry. The APIs are swept from `BUILTIN_API_IDS` and the errnos from
 * `UNREACHABLE_PEER_ERRNOS` at run time, so a new API or a new errno is covered the day it lands, and
 * an API this transport double cannot drive is pinned by exact equality and given its own test.
 *
 * Both sides of the boundary are pinned with it: a reset socket is still redialed by the transport
 * stage, because the peer was there and the next attempt can differ, and a name that does not resolve
 * is redialed by nobody, because it fails the same way on every attempt.
 *
 * What it does not catch: how long the turn ladder waits between its attempts, which belongs to the
 * session's retry settings; and an unreachable failure on an HTTP/2 transport other than Cursor's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { classify, classifyMessage, Flag, is, retriable, UNREACHABLE_PEER_ERRNOS } from "@veyyon/ai/error/flags";
import { AnthropicConnectionError, AnthropicMessagesClient } from "@veyyon/ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@veyyon/ai/providers/anthropic-wire";
import type { AssistantMessage, StreamOptions } from "@veyyon/ai/types";
import { fetchProviderWithRetry } from "@veyyon/ai/utils/provider-fetch";
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
import type { CountingFetch } from "./helpers/silent-transport";

/** The error Bun's `fetch` throws for a failed dial: a `TypeError` whose `code` is the errno. */
function bunDialError(code: string, sentence: string): TypeError {
	return Object.assign(new TypeError(`${code}: ${sentence}`), { code, errno: 0 });
}

function fetchThatFailsToDial(failure: () => Error): CountingFetch {
	const impl: CountingFetch = async () => {
		impl.calls += 1;
		throw failure();
	};
	impl.calls = 0;
	return impl;
}

/** What the turn sees of one stream whose every dial failed. */
interface DeadTurn {
	readonly dials: number;
	readonly message: AssistantMessage;
	readonly id: number | undefined;
}

async function streamAgainstDeadPeer(api: string, failure: () => Error): Promise<DeadTurn> {
	const transport = fetchThatFailsToDial(failure);
	const options: StreamOptions = {
		apiKey: API_PROBES[api].apiKey ?? DEFAULT_PROBE_API_KEY,
		fetch: transport,
		maxRetryDelayMs: 1,
		providerRetryWait: async () => {},
	};
	const events = callStream(modelFor(api, DEAD_ENDPOINT_URL), probeContext, options);
	for await (const _ of events) void _;
	const message = await events.result();
	return { dials: transport.calls, message, id: classifyMessage(message) };
}

/** Every API this transport double drives: the ones that dial through `fetch`. */
const FETCH_APIS = BUILTIN_API_IDS.filter(api => !API_PROBES[api].http2);

afterEach(() => {
	restoreProbeEnv();
});

describe("an unreachable peer is redialed by the turn and never by the transport", () => {
	it("leaves exactly the HTTP/2 APIs to their own test", () => {
		expect(BUILTIN_API_IDS.filter(api => API_PROBES[api].http2)).toEqual(["cursor-agent"]);
	});

	it("dials once, names the errno, and hands the turn a failure it retries, for every API and errno", async () => {
		pinProbeEnv();
		const wrong: string[] = [];
		for (const code of UNREACHABLE_PEER_ERRNOS) {
			for (const api of FETCH_APIS) {
				const turn = await streamAgainstDeadPeer(api, () => bunDialError(code, "Unable to connect."));
				const errorMessage = turn.message.errorMessage ?? "";
				if (turn.dials !== 1) wrong.push(`${api} ${code}: dialed ${turn.dials} times`);
				if (turn.message.stopReason !== "error") wrong.push(`${api} ${code}: stopped ${turn.message.stopReason}`);
				if (!errorMessage.includes(code)) wrong.push(`${api} ${code}: message lost the errno: ${errorMessage}`);
				if (!is(turn.id, Flag.PeerUnreachable)) wrong.push(`${api} ${code}: not classified unreachable`);
				if (!retriable(turn.id)) wrong.push(`${api} ${code}: the turn does not retry it`);
			}
		}
		expect(wrong).toEqual([]);
	}, 120_000);

	it("redials a name that does not resolve nowhere, and still names it", async () => {
		pinProbeEnv();
		const wrong: string[] = [];
		for (const api of FETCH_APIS) {
			const turn = await streamAgainstDeadPeer(api, () =>
				bunDialError("ENOTFOUND", "getaddrinfo ENOTFOUND no-such-host.invalid"),
			);
			const errorMessage = turn.message.errorMessage ?? "";
			if (turn.dials !== 1) wrong.push(`${api}: dialed ${turn.dials} times`);
			if (!errorMessage.includes("ENOTFOUND")) wrong.push(`${api}: message lost the errno: ${errorMessage}`);
			if (retriable(turn.id)) wrong.push(`${api}: the turn retries a name that does not exist`);
		}
		expect(wrong).toEqual([]);
	}, 120_000);

	it("still lets the turn retry a reset socket, and names it", async () => {
		pinProbeEnv();
		const wrong: string[] = [];
		for (const api of FETCH_APIS) {
			const turn = await streamAgainstDeadPeer(api, () =>
				bunDialError("ECONNRESET", "The socket connection was closed unexpectedly."),
			);
			const errorMessage = turn.message.errorMessage ?? "";
			if (!errorMessage.includes("ECONNRESET")) wrong.push(`${api}: message lost the errno: ${errorMessage}`);
			if (is(turn.id, Flag.PeerUnreachable)) wrong.push(`${api}: a reset classified unreachable`);
			if (!retriable(turn.id)) wrong.push(`${api}: the turn does not retry a reset`);
		}
		expect(wrong).toEqual([]);
	}, 120_000);

	it("hands the turn a refused Cursor dial it retries, naming the errno", async () => {
		pinProbeEnv();
		const port = await closedPort();
		const events = callStream(modelFor("cursor-agent", `http://127.0.0.1:${port}`), probeContext, {
			apiKey: API_PROBES["cursor-agent"].apiKey ?? DEFAULT_PROBE_API_KEY,
		});
		for await (const _ of events) void _;
		const message = await events.result();
		const id = classifyMessage(message);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("ECONNREFUSED");
		expect(is(id, Flag.PeerUnreachable)).toBe(true);
		expect(retriable(id)).toBe(true);
	});
});

/** A port on loopback that nothing listens on: bound by the kernel, then released. */
async function closedPort(): Promise<number> {
	const server = net.createServer();
	const { promise: listening, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => resolve());
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback listener reported no port");
	const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
	server.close(() => onClose());
	await closed;
	return address.port;
}

describe("the transport stage asks the registry about a thrown failure", () => {
	/** `[errno, dials]`: a peer that was there is redialed to the attempt bound; anything else is not. */
	const cases: readonly (readonly [string, number])[] = [
		...UNREACHABLE_PEER_ERRNOS.map(code => [code, 1] as const),
		["ENOTFOUND", 1],
		["CERT_HAS_EXPIRED", 1],
		["ECONNRESET", 3],
	];

	for (const [code, dials] of cases) {
		it(`dials ${dials} time(s) through the shared provider fetch for ${code}`, async () => {
			const transport = fetchThatFailsToDial(() => bunDialError(code, "dial failed."));
			const settled = fetchProviderWithRetry("http://127.0.0.1:9/v1/chat", {
				fetch: transport,
				maxAttempts: 3,
				defaultDelayMs: 0,
			});
			await expect(settled).rejects.toThrow(code);
			expect(transport.calls).toBe(dials);
		});

		it(`dials ${dials} time(s) through the Anthropic client for ${code}`, async () => {
			const transport = fetchThatFailsToDial(() => bunDialError(code, "dial failed."));
			const client = new AnthropicMessagesClient({
				apiKey: "sk-ant-probe",
				baseURL: "http://127.0.0.1:9",
				maxRetries: 2,
				fetch: transport,
			});
			const params = {
				model: "claude-sonnet-4-6",
				max_tokens: 1,
				messages: [],
				stream: true,
			} as MessageCreateParamsStreaming;
			const failure = await client.messages
				.create(params)
				.asResponse()
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(failure).toBeInstanceOf(AnthropicConnectionError);
			// The errno reaches the operator rather than a fixed "Connection error.".
			expect((failure as Error).message).toContain(code);
			expect(transport.calls).toBe(dials);
		});
	}

	it("lets a provider veto a retry the registry would allow, and never widen one", async () => {
		const vetoed = fetchThatFailsToDial(() => bunDialError("ECONNRESET", "dial failed."));
		await expect(
			fetchProviderWithRetry("http://127.0.0.1:9/v1/chat", {
				fetch: vetoed,
				maxAttempts: 3,
				defaultDelayMs: 0,
				shouldRetryError: () => false,
			}),
		).rejects.toThrow("ECONNRESET");
		expect(vetoed.calls).toBe(1);

		const widened = fetchThatFailsToDial(() => bunDialError("ECONNREFUSED", "dial failed."));
		await expect(
			fetchProviderWithRetry("http://127.0.0.1:9/v1/chat", {
				fetch: widened,
				maxAttempts: 3,
				defaultDelayMs: 0,
				shouldRetryError: () => true,
			}),
		).rejects.toThrow("ECONNREFUSED");
		expect(widened.calls).toBe(1);
	});

	it("reads a proxy's report of its upstream as a live peer, not an unreachable one", () => {
		// The proxy answered: its next attempt may route to an upstream that is up.
		const upstream = classify(new Error("upstream connect error: ECONNREFUSED"));
		expect(is(upstream, Flag.PeerUnreachable)).toBe(false);
		expect(is(upstream, Flag.Transient)).toBe(true);
		// A status says a peer answered, whatever its body says about a dial.
		const answered = classify(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { status: 502 }));
		expect(is(answered, Flag.PeerUnreachable)).toBe(false);
	});

	it("reads the errno from `code` when a wrapper reworded the sentence", () => {
		const reworded = classify(Object.assign(new Error("Unable to connect."), { code: "EHOSTUNREACH" }));
		expect(is(reworded, Flag.PeerUnreachable)).toBe(true);
		expect(retriable(reworded)).toBe(true);
	});
});
