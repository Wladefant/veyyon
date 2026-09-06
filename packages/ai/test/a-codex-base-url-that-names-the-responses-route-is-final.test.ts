/**
 * WHY THIS SUITE EXISTS.
 *
 * `resolveCodexResponsesUrl` appends `/codex/responses` to a Codex base URL,
 * because that is where OpenAI serves it. A Codex-COMPATIBLE server does not
 * have to: the `codex-chatgpt-web` bridge installs itself into a Codex config as
 * `openai_base_url = "http://127.0.0.1:17841/v1"` and serves `POST
 * /v1/responses`, with a 404 for anything else. Before the `/responses` clause
 * existed, pointing a model at that base produced
 * `http://127.0.0.1:17841/v1/responses/codex/responses` and every turn on that
 * provider 404'd. A 404 from a base-URL bug and a 404 from a daemon that is not
 * running are indistinguishable at the call site, which is why the resolution
 * has to be pinned at the wire rather than inferred from a passing session.
 *
 * THE CLASS THIS CLOSES: a Codex-family request reaching the wrong route, or
 * reaching it without the turn identity that a compatible server keys its
 * session on. Both are checked against a REAL HTTP server on loopback, so the
 * URL, the headers and the body are observed as bytes rather than through a
 * fetch spy, and the shapes below are enumerated so the official host's
 * resolution is asserted by the same test that asserts the bridge's.
 *
 * WHY THE TURN IDENTITY IS PART OF THIS SUITE. The bridge REFUSES a turn whose
 * body carries no `client_metadata["x-codex-turn-metadata"].turn_id`
 * ("ChatGPT web requires native Codex turn_id metadata for browser-session
 * replay"), derives the trace id it cancels by from `thread_id`+`turn_id`, and
 * binds one browser tab per thread. So "isolated sessions" for that provider is
 * exactly this body field, and a change that dropped or shared it would leave
 * two Veyyon sessions driving one ChatGPT tab.
 *
 * WHY THE FIXTURE REFUSES. The turn metadata blob is only half of what the
 * daemon validates. `chatGptTurnExecutionKey` — derived for every turn before
 * any browser work — also demands the CURRENT-TURN USER ITEM carry
 * `type: "message"` plus `internal_chat_message_metadata_passthrough.turn_id`
 * matching that blob, because the other alternative it accepts (a server-owned
 * item `id`) is stripped from every input item by the Codex request
 * transformer. This suite's first version answered 200 to any POST and asserted
 * the blob alone, so the transport shipped `{ role, content }` items that the
 * daemon refuses outright and the whole file stayed green. The server now gates
 * every request on {@link bridgeTurnRefusal} and answers 400 with the daemon's
 * own message, which makes acceptance evidence instead of a default.
 *
 * WHAT IT DOES NOT CATCH. The server here speaks the Responses SSE protocol; it
 * is not the bridge, and nothing here proves a browser turn produces an answer.
 * That needs an authenticated ChatGPT profile on the machine, which is a
 * separate, missing prerequisite — as is the daemon's trusted-sandbox envelope,
 * which its FULL-mode tool path requires and this transport does not send, so a
 * full-mode tool round trip stays refused for a reason nothing here forges. The
 * catalog half of the boundary is covered in
 * `packages/catalog/test/the-chatgpt-web-bridge-publishes-only-what-its-daemon-reports.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import * as piUtils from "@veyyon/utils";
import { asRecord } from "@veyyon/utils/type-guards";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
const originalProfileEnv = process.env.VEYYON_PROFILE;
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";

/** A Codex-shaped bearer: the account id is read out of the JWT payload. */
const TOKEN = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_bridge_test" } }),
	"utf8",
).toBase64()}.bbb`;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) delete Bun.env.VEYYON_CODING_AGENT_DIR;
	else Bun.env.VEYYON_CODING_AGENT_DIR = originalAgentDirEnv;
	if (originalProfileEnv === undefined) delete Bun.env.VEYYON_PROFILE;
	else Bun.env.VEYYON_PROFILE = originalProfileEnv;
	piUtils.__resetDirsFromEnvForTests();
	vi.restoreAllMocks();
});

interface ObservedRequest {
	method: string;
	url: string;
	body: Record<string, unknown>;
	/** Set when the client hung up before the response finished. */
	clientHungUp: boolean;
	/**
	 * The bridge contract's refusal for this body, or `undefined` when the body
	 * satisfied it. The server answers 400 rather than SSE whenever this is set.
	 */
	refusal?: string;
}

interface TestServer {
	origin: string;
	requests: ObservedRequest[];
	close: () => Promise<void>;
	/** Resolves once a request has been observed hanging up. */
	hangUp: Promise<void>;
	/** Resolves once the server has read a complete request body. */
	received: Promise<void>;
}

/**
 * The bridge's turn contract, specified here and enforced fail-closed.
 *
 * This is a deliberate reimplementation of what `codex-chatgpt-web` does in
 * `adapters/chatgpt-web/environment.ts` (`extractChatGptTurnIdentity` plus
 * `latestChatGptTurnUserRevision`, reached from `chatGptTurnExecutionKey`,
 * which `runTurn` derives for EVERY turn before any browser work). Its
 * messages are the daemon's own, byte for byte, because those strings are what
 * an operator sees in `response.failed` when this contract is not met.
 *
 * It is a SPECIFICATION, not a stub: every path that cannot positively prove
 * the body satisfies the contract returns a refusal, and the server below
 * answers 400 instead of SSE whenever it does. The previous fixture accepted
 * any POST and asserted only the `client_metadata` blob, so a body the daemon
 * refuses outright passed the whole suite — which is exactly how the missing
 * per-item turn provenance shipped.
 *
 * WHAT IT DOES NOT MODEL. The daemon also skips a user item holding one of its
 * own compaction-summary texts (`isReadableCompactionSummaryText`,
 * `OPAQUE_COMPACTION_NOTE`) before accepting it as the revision. Those strings
 * are daemon-internal and nothing in this repo produces them, so they are left
 * out rather than approximated. It also does not model the compaction route
 * (`_compactionRequest`), which keys off the whole input array instead.
 */
function bridgeTurnRefusal(body: Record<string, unknown>): string | undefined {
	const clientMetadata = asRecord(body.client_metadata);
	const encoded = clientMetadata?.["x-codex-turn-metadata"];
	if (typeof encoded !== "string") return "ChatGPT web requires native Codex turn_id metadata for browser-session replay";
	let blob: Record<string, unknown> | null = null;
	try {
		blob = asRecord(JSON.parse(encoded));
	} catch {
		blob = null;
	}
	const turnId = blob?.turn_id;
	if (typeof turnId !== "string" || turnId.length === 0) {
		return "ChatGPT web requires native Codex turn_id metadata for browser-session replay";
	}
	const input = Array.isArray(body.input) ? body.input : [];
	for (let index = input.length - 1; index >= 0; index -= 1) {
		const item = asRecord(input[index]);
		if (item?.type !== "message" || item.role !== "user") continue;
		if (isContextualUserItem(item)) continue;
		const itemTurnId = asRecord(item.internal_chat_message_metadata_passthrough)?.turn_id;
		const serverOwnedId = typeof item.id === "string" && item.id.length > 0;
		if (typeof itemTurnId !== "string" && !serverOwnedId) continue;
		if (typeof itemTurnId === "string" && itemTurnId !== turnId) {
			return "ChatGPT web current user message conflicts with native Codex turn_id metadata";
		}
		return undefined;
	}
	return "ChatGPT web requires a current-turn user message for browser-session replay";
}

/** The daemon's two XML envelopes, which are context rather than an instruction. */
function isContextualUserItem(item: Record<string, unknown>): boolean {
	const content = item.content;
	const text = (
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map(part => asRecord(part)?.text)
						.filter((value): value is string => typeof value === "string")
						.join("\n")
				: ""
	).trim();
	return (
		/^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ||
		/^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
	);
}

/** The user items of a request body, in wire order. */
function userItems(body: Record<string, unknown>): Record<string, unknown>[] {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.map(item => asRecord(item)).filter((item): item is Record<string, unknown> => item?.role === "user");
}

/**
 * The same body with the bridge stamp removed from every user item — i.e. the
 * payload this transport sent BEFORE the stamp existed. Pinned against the
 * untouched message converter in the suite below, so it is the original wire
 * shape rather than a hand-written stand-in for it.
 */
function withoutBridgeStamp(body: Record<string, unknown>): Record<string, unknown> {
	const input = Array.isArray(body.input) ? body.input : [];
	return {
		...body,
		input: input.map(entry => {
			const item = asRecord(entry);
			if (item?.role !== "user") return entry;
			const { type: _type, internal_chat_message_metadata_passthrough: _passthrough, ...rest } = item;
			return rest;
		}),
	};
}

/**
 * One complete Responses turn.
 *
 * The `response.created` and `response.output_item.added` frames are not
 * decoration: without them the assistant message finishes with EMPTY content,
 * `withEmptyCompletionRetry` re-runs the whole turn three times, and every
 * request-count assertion below reads 3 instead of 1. Measured, not assumed.
 */
const COMPLETED_SSE = `${[
	`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
	`data: ${JSON.stringify({
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	})}`,
	`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
	`data: ${JSON.stringify({
		type: "response.output_item.done",
		item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] },
	})}`,
	`data: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
		},
	})}`,
].join("\n\n")}\n\n`;

/**
 * A real loopback HTTP server speaking the Responses SSE protocol, gated on
 * {@link bridgeTurnRefusal}.
 *
 * A body the bridge contract refuses gets HTTP 400 carrying the daemon's own
 * message — the same shape `server.ts` turns that throw into — so a regression
 * in the outgoing wire shape fails every assertion in this file instead of
 * passing against a server that answers 200 to anything.
 *
 * `mode: "stall"` answers with headers and then nothing, which is what lets the
 * abort assertion observe a hang-up on the SERVER side rather than trusting the
 * client's own bookkeeping.
 */
async function startServer(mode: "complete" | "stall" = "complete"): Promise<TestServer> {
	const requests: ObservedRequest[] = [];
	const hangUp = Promise.withResolvers<void>();
	const received = Promise.withResolvers<void>();
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", chunk => chunks.push(chunk as Buffer));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			} catch {
				body = {};
			}
			const refusal = bridgeTurnRefusal(body);
			const observed: ObservedRequest = {
				method: req.method ?? "",
				url: req.url ?? "",
				body,
				clientHungUp: false,
				...(refusal === undefined ? {} : { refusal }),
			};
			requests.push(observed);
			received.resolve();
			if (refusal !== undefined) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: refusal, type: "invalid_request_error" } }));
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			// Both halves, because the two runtimes disagree about which one
			// reports a client disconnect: node emits `close` on the RESPONSE with
			// `writableFinished === false`, and Bun's node:http shim reports it on
			// the REQUEST. Watching one of them made a real hang-up invisible.
			const noteHangUp = (): void => {
				if (res.writableFinished) return;
				observed.clientHungUp = true;
				hangUp.resolve();
			};
			res.on("close", noteHangUp);
			req.on("close", noteHangUp);
			req.on("aborted", noteHangUp);
			if (mode === "complete") {
				res.end(COMPLETED_SSE);
				return;
			}
			res.flushHeaders();
			res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "thinking" })}\n\n`);
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not bind a port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		hangUp: hangUp.promise,
		received: received.promise,
		// `closeAllConnections()` can settle the listener before `close()` runs
		// under Bun's node:http shim, which then answers ERR_SERVER_NOT_RUNNING.
		// Teardown must not turn that into the test's failure.
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(error => (error ? reject(error) : resolve()));
			}),
	};
}

function bridgeModel(baseUrl: string): Model<"openai-codex-responses"> {
	return buildModel({
		id: "chatgpt-web/high",
		name: "ChatGPT Web — High",
		api: "openai-codex-responses",
		provider: "chatgpt-web",
		baseUrl,
		reasoning: true,
		// Exactly what the bridge's catalog reader produces.
		preferWebsockets: false,
		thinking: { mode: "effort", efforts: [Effort.High], defaultLevel: Effort.High },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricing: "unknown",
		contextWindow: 111_193,
		maxTokens: null,
	});
}

function askContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say ok", timestamp: Date.now() }],
	};
}

/**
 * A tool-return continuation: the request the transport issues after the model
 * called a tool and the tool answered. Its input ends in
 * `function_call_output`, so the current-turn user instruction is no longer the
 * last item — the case the bridge stamp has to reach as well as a fresh turn.
 */
function toolReturnContext(): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "true" } }],
		api: "openai-codex-responses",
		provider: "chatgpt-web",
		model: "chatgpt-web/high",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{ role: "user", content: "Say ok", timestamp: Date.now() },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

function turnMetadata(body: Record<string, unknown>): Record<string, unknown> {
	const clientMetadata = body.client_metadata;
	if (!clientMetadata || typeof clientMetadata !== "object" || Array.isArray(clientMetadata)) {
		throw new Error("request carried no client_metadata");
	}
	const encoded = (clientMetadata as Record<string, unknown>)["x-codex-turn-metadata"];
	if (typeof encoded !== "string") throw new Error("request carried no x-codex-turn-metadata");
	const parsed: unknown = JSON.parse(encoded);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("x-codex-turn-metadata is not an object");
	}
	return parsed as Record<string, unknown>;
}

describe("a Codex base URL that already names the responses route is used verbatim", () => {
	it("reaches /v1/responses on a bridge base and never appends /codex/responses", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			const result = await streamOpenAICodexResponses(model, askContext(), { apiKey: TOKEN }).result();

			expect(result.stopReason).toBe("stop");
			expect(server.requests).toHaveLength(1);
			// The literal path, because it is the whole defect: the bridge serves
			// this and 404s `/v1/responses/codex/responses`.
			expect(server.requests[0]?.method).toBe("POST");
			expect(server.requests[0]?.url).toBe("/v1/responses");
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});

	it("still appends the official route for every base shape that does not name it", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		// The negative control for the clause above: the official provider's own
		// base shapes must resolve exactly as they did, or the bridge's needs were
		// met by moving OpenAI's traffic.
		const requestedUrls: string[] = [];
		const sentBodies: Record<string, unknown>[] = [];
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			requestedUrls.push(typeof input === "string" ? input : input.toString());
			sentBodies.push(asRecord(JSON.parse(String(init?.body))) ?? {});
			return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		try {
			for (const baseUrl of [
				"https://chatgpt.com/backend-api",
				"https://chatgpt.com/backend-api/codex",
				"https://chatgpt.com/backend-api/codex/responses",
				"https://chatgpt.com/backend-api/codex/responses///",
			]) {
				const model = { ...bridgeModel(baseUrl), provider: "openai-codex" };
				const result = await streamOpenAICodexResponses(model, askContext(), {
					apiKey: TOKEN,
					fetch: fetchMock as FetchImpl,
				}).result();
				expect(result.stopReason).toBe("stop");
			}

			expect(requestedUrls).toEqual([
				"https://chatgpt.com/backend-api/codex/responses",
				"https://chatgpt.com/backend-api/codex/responses",
				"https://chatgpt.com/backend-api/codex/responses",
				"https://chatgpt.com/backend-api/codex/responses",
			]);
			// And the bridge's per-item turn provenance is NOT sent to OpenAI's
			// host. `internal_chat_message_metadata_passthrough` is a field the
			// official backend never receives from this transport, and a `type` the
			// converter did not emit is the observable half of the same mistake.
			expect(sentBodies).toHaveLength(4);
			for (const body of sentBodies) {
				const items = userItems(body);
				expect(items).toHaveLength(1);
				expect(items[0]?.internal_chat_message_metadata_passthrough).toBeUndefined();
				expect(items[0]?.type).toBeUndefined();
			}
			// The whole input array, byte for byte, is still what the untouched
			// message converter produces for this turn.
			expect(sentBodies[0]?.input).toEqual(
				convertCodexResponsesMessages(
					{ ...bridgeModel("https://chatgpt.com/backend-api"), provider: "openai-codex" },
					askContext(),
				),
			);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("every turn carries the identity a Codex-compatible server keys its session on", () => {
	it("sends thread_id, turn_id and request_kind in the canonical turn-metadata blob", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			await streamOpenAICodexResponses(model, askContext(), { apiKey: TOKEN, sessionId: "session-a" }).result();

			const metadata = turnMetadata(server.requests[0]?.body ?? {});
			// The bridge refuses a turn without turn_id and derives the trace it
			// cancels by from thread_id + turn_id, so all three are load-bearing.
			expect(typeof metadata.thread_id).toBe("string");
			expect(typeof metadata.turn_id).toBe("string");
			expect(typeof metadata.session_id).toBe("string");
			expect(metadata.request_kind).toBe("turn");
			expect(metadata.installation_id).toBe(TEST_INSTALLATION_ID);
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});

	it("gives two sessions different threads and one session a new turn per request", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			for (const sessionId of ["session-a", "session-b", "session-a"]) {
				await streamOpenAICodexResponses(model, askContext(), {
					apiKey: TOKEN,
					sessionId,
					providerSessionState,
				}).result();
			}

			expect(server.requests).toHaveLength(3);
			const [first, second, third] = server.requests.map(request => turnMetadata(request.body));
			// One browser tab is bound per thread on the bridge side, so two Veyyon
			// sessions sharing a thread would share a tab and interleave turns.
			expect(first?.thread_id).not.toBe(second?.thread_id);
			// The same session keeps its thread across turns; that is what makes it
			// one conversation rather than three.
			expect(third?.thread_id).toBe(first?.thread_id);
			// A new turn each time: the bridge treats a repeated turn_id as a replay
			// of the same browser turn.
			expect(third?.turn_id).not.toBe(first?.turn_id);
			expect(new Set(server.requests.map(request => String(turnMetadata(request.body).turn_id))).size).toBe(3);
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});
});

describe("cancelling a turn hangs up on the server", () => {
	it("closes the request and ends the stream as aborted, without waiting for the server", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		// A server that answers with headers and then never sends a terminal
		// event. The bridge cancels its browser turn when the HTTP request goes
		// away, so the abort contract is "the socket closes", not "the client
		// stops reading".
		const server = await startServer("stall");
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			const controller = new AbortController();
			const response = streamOpenAICodexResponses(model, askContext(), {
				apiKey: TOKEN,
				sessionId: "session-cancel",
				signal: controller.signal,
			});
			// Drain in the background: the turn never completes on its own, so the
			// iterator must not be what decides when to cancel.
			const drained = (async () => {
				for await (const _event of response) {
					// Events are irrelevant here; the contract is the socket.
				}
			})();

			// Cancel once the request is genuinely in flight, observed on the
			// server rather than inferred from a delta the transport may buffer.
			await server.received;
			controller.abort();

			// A real deadline, not a sleep: the awaited signal is the server's own
			// `close` event on a real socket, and fake timers cannot advance a TCP
			// FIN. Nothing waits for this timer on the passing path — it exists so
			// a socket that never closes fails HERE, naming the missing hang-up,
			// instead of expiring the whole file with no reason attached.
			await Promise.race([
				server.hangUp,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("server never observed the client hanging up")), 5_000),
				),
			]);

			// It ENDS: an aborted turn must not leave the iterator parked on a
			// stream the server will never terminate.
			await drained;
			const result = await response.result();
			expect(result.stopReason).toBe("aborted");
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.clientHungUp).toBe(true);
		} finally {
			await server.close();
			tempDir.removeSync();
		}
		// The per-test budget: this one drives a real socket and a real abort, so
		// it needs more than the 5s default the deadline above sits inside.
	}, 20_000);
});

describe("a bridge-routed turn carries the per-item turn provenance the daemon validates", () => {
	it("stamps the current-turn user item, and the same body without the stamp is refused", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			const result = await streamOpenAICodexResponses(model, askContext(), { apiKey: TOKEN }).result();

			// Accepted: the fixture answers SSE only when the contract holds.
			expect(result.stopReason).toBe("stop");
			expect(server.requests).toHaveLength(1);
			const sent = server.requests[0]?.body ?? {};
			expect(server.requests[0]?.refusal).toBeUndefined();
			expect(bridgeTurnRefusal(sent)).toBeUndefined();

			// The stamp is the turn's own id, not a constant: a passthrough that
			// disagrees with the blob is a refusal, not an acceptance.
			const items = userItems(sent);
			expect(items).toHaveLength(1);
			expect(items[0]?.type).toBe("message");
			expect(items[0]?.internal_chat_message_metadata_passthrough).toEqual({
				turn_id: turnMetadata(sent).turn_id,
			});

			// Exactly one item carries turn provenance, because the field ASSERTS
			// that the item belongs to that turn and only the current instruction
			// does. The daemon's rolling-checkpoint boundary is the FIRST item
			// bearing the current turn id, so stamping a second one moves that
			// boundary to the start of the conversation and silently disables it.
			const input = Array.isArray(sent.input) ? sent.input : [];
			expect(
				input.filter(entry => asRecord(entry)?.internal_chat_message_metadata_passthrough !== undefined),
			).toHaveLength(1);

			// THE DIFFERENTIAL. Take the stamp off the body that was just accepted
			// and the same contract refuses it, with the daemon's own words.
			const original = withoutBridgeStamp(sent);
			expect(bridgeTurnRefusal(original)).toBe(
				"ChatGPT web requires a current-turn user message for browser-session replay",
			);
			// And that stripped body is not a stand-in: its input array is exactly
			// what the message converter — untouched by this fix — produces, so it
			// IS the payload this transport used to send.
			expect(original.input).toEqual(convertCodexResponsesMessages(model, askContext()));
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});

	it("reaches the user item on a tool-return continuation, where it is not the last item", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			const result = await streamOpenAICodexResponses(model, toolReturnContext(), { apiKey: TOKEN }).result();

			expect(result.stopReason).toBe("stop");
			const sent = server.requests[0]?.body ?? {};
			// The premise of the test: the input really does end in a tool result,
			// so a stamp applied to "the last item" would have missed.
			const input = Array.isArray(sent.input) ? sent.input : [];
			expect(asRecord(input.at(-1))?.type).toBe("function_call_output");
			expect(server.requests[0]?.refusal).toBeUndefined();
			expect(userItems(sent)[0]?.internal_chat_message_metadata_passthrough).toEqual({
				turn_id: turnMetadata(sent).turn_id,
			});
			expect(bridgeTurnRefusal(withoutBridgeStamp(sent))).toBe(
				"ChatGPT web requires a current-turn user message for browser-session replay",
			);
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});

	it("refuses a turn whose metadata blob names a different turn than the stamped item", async () => {
		// The fixture is not satisfied by the mere presence of a passthrough key,
		// which is the way a future "just add the field somewhere" fix would pass
		// a permissive stub while the daemon still refuses the turn.
		const conflicting = {
			client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-a", thread_id: "thread-a" }) },
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Say ok" }],
					internal_chat_message_metadata_passthrough: { turn_id: "turn-b" },
				},
			],
		};
		expect(bridgeTurnRefusal(conflicting)).toBe(
			"ChatGPT web current user message conflicts with native Codex turn_id metadata",
		);

		// And it is fail-closed on the two inputs it cannot vouch for at all.
		expect(bridgeTurnRefusal({ input: [] })).toBe(
			"ChatGPT web requires native Codex turn_id metadata for browser-session replay",
		);
		expect(
			bridgeTurnRefusal({
				client_metadata: { "x-codex-turn-metadata": "{not json" },
				input: [{ type: "message", role: "user", content: "Say ok" }],
			}),
		).toBe("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
	});

	it("does not stamp a chatgpt-web row that is not pointed at loopback", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		// The other half of the gate. The daemon binds 127.0.0.1 only and
		// discovery refuses to hand it the ChatGPT bearer anywhere else, so a
		// `chatgpt-web` row on a remote base is NOT the daemon and must not be
		// sent daemon-specific fields — a provider-id-only gate would send them.
		const sentBodies: Record<string, unknown>[] = [];
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			sentBodies.push(asRecord(JSON.parse(String(init?.body))) ?? {});
			return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		try {
			const model = bridgeModel("https://bridge.example.com/v1/responses");
			const result = await streamOpenAICodexResponses(model, askContext(), {
				apiKey: TOKEN,
				fetch: fetchMock as FetchImpl,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(model.provider).toBe("chatgpt-web");
			const items = userItems(sentBodies[0] ?? {});
			expect(items).toHaveLength(1);
			expect(items[0]?.internal_chat_message_metadata_passthrough).toBeUndefined();
			expect(items[0]?.type).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});

	it("leaves the session's stored history items untouched while stamping the outgoing copy", async () => {
		const tempDir = TempDir.createSync("@pi-codex-bridge-");
		setAgentDir(tempDir.path());
		const server = await startServer();
		// A replayed input item reaches the request body BY REFERENCE: the
		// converter pushes `providerPayload.items` straight through, and the
		// transformer only copies an item when it has an `id` to strip. Writing
		// the stamp into that object would outlive this request, put a stale turn
		// id in the stored conversation, and follow it onto another provider.
		const storedItem: Record<string, unknown> = {
			role: "user",
			content: [{ type: "input_text", text: "Say ok" }],
		};
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{
					role: "user",
					content: "Say ok",
					timestamp: Date.now(),
					providerPayload: { type: "openaiResponsesHistory", provider: "chatgpt-web", items: [storedItem] },
				},
			],
		};
		try {
			const model = bridgeModel(`${server.origin}/v1/responses`);
			const result = await streamOpenAICodexResponses(model, context, { apiKey: TOKEN }).result();

			// The outgoing copy is stamped and accepted...
			expect(result.stopReason).toBe("stop");
			const sent = server.requests[0]?.body ?? {};
			expect(server.requests[0]?.refusal).toBeUndefined();
			expect(userItems(sent)[0]?.internal_chat_message_metadata_passthrough).toEqual({
				turn_id: turnMetadata(sent).turn_id,
			});
			// ...and the object the session still owns is byte-identical to before.
			expect(storedItem).toEqual({ role: "user", content: [{ type: "input_text", text: "Say ok" }] });
		} finally {
			await server.close();
			tempDir.removeSync();
		}
	});
});
