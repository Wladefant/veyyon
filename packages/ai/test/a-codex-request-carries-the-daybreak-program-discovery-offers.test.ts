/**
 * WHY: ChatGPT Codex refused security work in veyyon sessions with `cyber_policy`, whose message
 * states that `access_programs.cyber` must be set to the appropriate tier. veyyon never sent the
 * field. codex-rs 0.163.0 reads `available_access_programs` from model discovery and sends the
 * advertised Daybreak program, `daybreak_blue` before `daybreak_red`, on every request of a turn.
 *
 * The programs belong to one ChatGPT account. A standard account is offered `standard`, a Daybreak
 * Blue account `daybreak_blue`, a Daybreak Red account `daybreak_red`, and only a Daybreak account is
 * listed the Daybreak-only models. The endpoint rejects a program the signing account is not offered
 * (400, 403 or `invalid_access_program`), so a program read from another account's listing fails the
 * turn. Discovery lists every signed-in account and records each account's entry on every model.
 *
 * Class closed: every request a turn makes carries the program the account that signs it is offered.
 * The suite drives the production path end to end: the `/codex/models` payload is read by
 * `fetchCodexModels`, merged with the bundled catalog and written to the model cache by
 * `resolveProviderModels`, read back from that cache as a launch reads it, and then sent as an HTTP
 * turn, a websocket `response.create` frame (the first frame and the stateful delta frame), and a
 * server-side compaction. Every advertised shape is swept against all three. Every account level is
 * swept as the signing account over every model any level is listed, after discovery lists every
 * level, and against every other level as the one account discovery listed. A model listed before its
 * account was recorded, a token that names no account, a listing that fails, a listing that never
 * answers, a caller abort, and the reuse and expiry of a listing are each driven.
 *
 * `ACCOUNT_LEVELS` is keyed by `CyberAccessProgram`, so a program added to the union fails the type
 * check until a level is recorded for it.
 *
 * Not caught: a Codex request built outside `transformRequestBody`, the compaction transport, web
 * search and image generation (those two are covered in coding-agent). A server that renames a
 * program, or that offers one account different programs per workspace header, is also not caught.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CODEX_ACCESS_PROGRAM_FAILURE_TTL_MS,
	CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS,
	CODEX_ACCESS_PROGRAM_LISTING_TTL_MS,
	resetCodexAccessProgramListings,
	resolveCodexAccessPrograms,
} from "@veyyon/ai/providers/openai-codex/access-programs";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
} from "@veyyon/ai/providers/openai-compaction";
import type { Context, CyberAccessProgram, FetchImpl, Model, ModelSpec, ProviderSessionState } from "@veyyon/ai/types";
import { fetchCodexAccountModels, fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import * as piUtils from "@veyyon/utils";
import { providerSessionStateForTest } from "./helpers";

const DISCOVERY_BASE_URL = "https://codex.example/backend-api";
const ACCOUNT_ID = "acc_test";
const originalWebSocket = global.WebSocket;

interface ListedModel {
	/** Model slug the discovery payload lists. */
	slug: string;
	/** The raw `available_access_programs` value, or `undefined` to leave the key out. */
	advertised: unknown;
	/** The `access_programs` every request for the model must carry, or `undefined` for none. */
	expected: { cyber: string } | undefined;
}

const CASES: readonly ListedModel[] = [
	{ slug: "gpt-daybreak-blue-latest", advertised: { cyber: ["daybreak_blue"] }, expected: { cyber: "daybreak_blue" } },
	{ slug: "gpt-5.6-sol", advertised: { cyber: ["standard", "daybreak_blue"] }, expected: { cyber: "daybreak_blue" } },
	{ slug: "gpt-red-tier", advertised: { cyber: ["standard", "daybreak_red"] }, expected: { cyber: "daybreak_red" } },
	{
		slug: "gpt-both-tiers",
		advertised: { cyber: ["daybreak_red", "standard", "daybreak_blue"] },
		expected: { cyber: "daybreak_blue" },
	},
	{
		slug: "gpt-new-tier",
		advertised: { cyber: ["daybreak_violet", "daybreak_red"] },
		expected: { cyber: "daybreak_red" },
	},
	{ slug: "gpt-6-astra", advertised: { cyber: ["standard"] }, expected: undefined },
	{ slug: "gpt-nothing-selectable", advertised: { cyber: [] }, expected: undefined },
	{ slug: "gpt-unknown-only", advertised: { cyber: ["daybreak_violet"] }, expected: undefined },
	{ slug: "gpt-unreadable", advertised: { cyber: "daybreak_blue" }, expected: undefined },
	{ slug: "gpt-no-metadata", advertised: undefined, expected: undefined },
];

interface AccountLevel {
	accountId: string;
	/** The models `/codex/models` lists the account, shaped as the live endpoint lists them at 0.163.0. */
	listing: readonly ListedModel[];
}

const ACCOUNT_LEVELS: Record<CyberAccessProgram, AccountLevel> = {
	standard: {
		accountId: "acc_standard",
		listing: [
			{ slug: "gpt-5.6-sol", advertised: { cyber: ["standard"] }, expected: undefined },
			{ slug: "gpt-6-astra", advertised: { cyber: ["standard"] }, expected: undefined },
		],
	},
	daybreak_blue: {
		accountId: "acc_blue",
		listing: [
			{
				slug: "gpt-5.6-sol",
				advertised: { cyber: ["standard", "daybreak_blue"] },
				expected: { cyber: "daybreak_blue" },
			},
			{ slug: "gpt-6-astra", advertised: { cyber: ["standard"] }, expected: undefined },
			{
				slug: "gpt-daybreak-blue-latest",
				advertised: { cyber: ["daybreak_blue"] },
				expected: { cyber: "daybreak_blue" },
			},
		],
	},
	daybreak_red: {
		accountId: "acc_red",
		listing: [
			{
				slug: "gpt-5.6-sol",
				advertised: { cyber: ["standard", "daybreak_red"] },
				expected: { cyber: "daybreak_red" },
			},
			{ slug: "gpt-6-astra", advertised: { cyber: ["standard"] }, expected: undefined },
		],
	},
};

const LEVELS = Object.keys(ACCOUNT_LEVELS) as CyberAccessProgram[];

let tempDirs: string[] = [];

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(async () => {
	global.WebSocket = originalWebSocket;
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetServerCompactionRouteCache();
	resetCodexAccessProgramListings();
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

function modelsPayload(listing: readonly ListedModel[]): string {
	return JSON.stringify({
		models: listing.map(({ slug, advertised }) => ({
			slug,
			display_name: slug,
			context_window: 272_000,
			default_reasoning_level: "medium",
			supported_reasoning_levels: ["low", "medium", "high"],
			input_modalities: ["text"],
			supported_in_api: true,
			...(advertised === undefined ? {} : { available_access_programs: advertised }),
		})),
	});
}

/** A Codex access token naming `accountId`, or naming no account for `null`. */
function codexToken(accountId: string | null = ACCOUNT_ID): string {
	const auth = accountId === null ? {} : { chatgpt_account_id: accountId };
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth }), "utf8").toBase64();
	return `aaa.${payload}.bbb`;
}

/** The models a launch resolves: discovered once through `fetchModels`, then read back from the model cache. */
async function resolveThroughCache(
	fetchModels: () => Promise<ModelSpec<"openai-codex-responses">[] | null>,
): Promise<Map<string, Model<"openai-codex-responses">>> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-access-programs-"));
	tempDirs.push(tempDir);
	let fetches = 0;
	const fetchDynamicModels = async () => {
		fetches++;
		return fetchModels();
	};
	const options = {
		providerId: "openai-codex",
		dynamicModelsAuthoritative: true,
		cacheDbPath: path.join(tempDir, "models.db"),
		fetchDynamicModels,
	} as const;
	await resolveProviderModels<"openai-codex-responses">(options);
	const cached = await resolveProviderModels<"openai-codex-responses">(options);
	expect(fetches).toBe(1);
	return new Map(cached.models.map(model => [model.id, model]));
}

/** The models a launch resolves when discovery lists the one account `accessToken` names. */
function discoverModels(
	listing: readonly ListedModel[] = CASES,
	accessToken = codexToken(),
): Promise<Map<string, Model<"openai-codex-responses">>> {
	return resolveThroughCache(async () => {
		const discovered = await fetchCodexModels({
			accessToken,
			baseUrl: DISCOVERY_BASE_URL,
			fetchFn: async () => new Response(modelsPayload(listing)),
		});
		return discovered?.models ?? null;
	});
}

/** The models a launch resolves when discovery lists an account of every level. */
function discoverEveryLevel(): Promise<Map<string, Model<"openai-codex-responses">>> {
	return resolveThroughCache(() =>
		fetchCodexAccountModels({
			accounts: LEVELS.map(level => ({
				accessToken: codexToken(ACCOUNT_LEVELS[level].accountId),
				accountId: ACCOUNT_LEVELS[level].accountId,
			})),
			baseUrl: DISCOVERY_BASE_URL,
			fetchFn: async (_input, init) => levelListing(new Headers(init?.headers).get("chatgpt-account-id")),
		}),
	);
}

async function discoveredModel(
	slug: string,
	listing: readonly ListedModel[] = CASES,
	accessToken = codexToken(),
): Promise<Model<"openai-codex-responses">> {
	const model = (await discoverModels(listing, accessToken)).get(slug);
	if (!model) throw new Error(`discovery resolved no model ${slug}`);
	return model;
}

function turnContext(text: string): Context {
	return { systemPrompt: ["You are a helpful assistant."], messages: [{ role: "user", content: text, timestamp: 1 }] };
}

const COMPLETED_SSE = `${[
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

function completedTurn(): Response {
	return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The listing of whichever account level the `chatgpt-account-id` header names; 500 for any other. */
function levelListing(accountId: string | null): Response {
	const level = LEVELS.map(name => ACCOUNT_LEVELS[name]).find(candidate => candidate.accountId === accountId);
	return level ? new Response(modelsPayload(level.listing)) : new Response("{}", { status: 500 });
}

interface CodexHost {
	fetch: FetchImpl;
	/** Every POST body, in order. */
	bodies: Array<Record<string, unknown>>;
	/** The `chatgpt-account-id` header of every `/codex/models` request, in order. */
	listings: Array<string | null>;
	/** The URL of every `/codex/models` request, without its query, in order. */
	listingUrls: string[];
}

/**
 * A Codex host: `/codex/models` (and its `/models` fallback) answers through `listing`, every POST is
 * recorded and answered through `respond`.
 */
function codexHost(
	respond: (body: Record<string, unknown> | undefined) => Response,
	listing: (accountId: string | null, signal: AbortSignal | null) => Response | Promise<Response> = levelListing,
): CodexHost {
	const bodies: Array<Record<string, unknown>> = [];
	const listings: Array<string | null> = [];
	const listingUrls: string[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		const { pathname } = new URL(url);
		if (pathname.endsWith("/models")) {
			const accountId = new Headers(init?.headers).get("chatgpt-account-id");
			if (pathname.endsWith("/codex/models")) {
				listings.push(accountId);
				listingUrls.push(url.split("?")[0] ?? url);
			}
			return listing(accountId, init?.signal ?? null);
		}
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		if (body) bodies.push(body);
		return respond(body);
	}) as FetchImpl;
	return { fetch: impl, bodies, listings, listingUrls };
}

/**
 * A host whose listing answers once `answer` is called, or rejects when the listing request's signal
 * aborts first, with `started` resolved when the listing is requested.
 */
function heldListingHost(respond: (body: Record<string, unknown> | undefined) => Response) {
	const started = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const host = codexHost(respond, async (accountId, signal) => {
		started.resolve();
		const aborted = Promise.withResolvers<never>();
		if (signal?.aborted) aborted.reject(signal.reason);
		signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
		await Promise.race([aborted.promise, answer.promise]);
		return levelListing(accountId);
	});
	return { host, started: started.promise, answer: answer.resolve };
}

/** A websocket that records each frame and answers it with a completed response. */
function installRecordingWebSocket(): Array<Record<string, unknown>> {
	const frames: Array<Record<string, unknown>> = [];
	class RecordingWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = RecordingWebSocket.CONNECTING;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;

		constructor(readonly url: string) {
			// The caller attaches `onopen` after the constructor returns, so the open event is queued.
			queueMicrotask(() => {
				this.readyState = RecordingWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			});
		}

		send(data: string): void {
			frames.push(JSON.parse(data) as Record<string, unknown>);
			const n = frames.length;
			const message = (payload: Record<string, unknown>) =>
				this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
			const item = { type: "message", id: `msg_${n}`, role: "assistant" };
			message({ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } });
			message({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
			message({ type: "response.output_text.delta", delta: `Answer ${n}` });
			message({
				type: "response.output_item.done",
				item: { ...item, status: "completed", content: [{ type: "output_text", text: `Answer ${n}` }] },
			});
			message({
				type: "response.done",
				response: {
					id: `resp_${n}`,
					status: "completed",
					usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
				},
			});
		}

		close(): void {
			this.readyState = RecordingWebSocket.CLOSED;
		}
	}
	global.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;
	return frames;
}

/** Runs one HTTP turn and one server-side compaction (answered 404), both signed with `accessToken`. */
async function turnAndCompaction(
	model: Model<"openai-codex-responses">,
	accessToken: string,
	host: CodexHost,
): Promise<void> {
	const turn = await streamOpenAICodexResponses(model, turnContext("Say hello"), {
		apiKey: accessToken,
		fetch: host.fetch,
		preferWebsockets: false,
	}).result();
	expect(turn.stopReason).toBe("stop");
	// The host answers the compaction 404 so the call ends after one request; the body is what was sent.
	await expect(
		openAIResponsesServerCompaction.compact({
			sessionId: `access-programs-${model.id}`,
			model,
			messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
			apiKey: accessToken,
			fetch: host.fetch,
		}),
	).rejects.toThrow("Server-side compaction is not available");
}

/** Answers a compaction (its last input item is the trigger) with 404 and a turn with a completed stream. */
function turnOrAbsentCompaction(body: Record<string, unknown> | undefined): Response {
	const input = Array.isArray(body?.input) ? body.input : [];
	const last = input.at(-1) as { type?: string } | undefined;
	return last?.type === "compaction_trigger"
		? new Response('{"detail":"Not Found"}', { status: 404 })
		: completedTurn();
}

describe("a Codex request carries the Daybreak program discovery offers", () => {
	it("resolves every advertised case to a discovered model", async () => {
		const models = await discoverModels();
		expect(CASES.filter(({ slug }) => !models.has(slug)).map(({ slug }) => slug)).toEqual([]);
	});

	for (const { slug, expected } of CASES) {
		describe(slug, () => {
			it("on the HTTP turn body", async () => {
				const model = await discoveredModel(slug);
				const host = codexHost(completedTurn);

				const result = await streamOpenAICodexResponses(model, turnContext("Say hello"), {
					apiKey: codexToken(),
					fetch: host.fetch,
					preferWebsockets: false,
				}).result();

				expect(result.stopReason).toBe("stop");
				expect(host.bodies).toHaveLength(1);
				expect(host.bodies[0]?.access_programs).toEqual(expected);
				// The account that signs the turn is the one discovery listed: no listing request.
				expect(host.listings).toEqual([]);
			});

			it("on the first websocket frame and the stateful delta frame", async () => {
				const model = await discoveredModel(slug);
				const frames = installRecordingWebSocket();
				const host = codexHost(completedTurn);
				const providerSessionState = new Map<string, ProviderSessionState>();
				const options = {
					apiKey: codexToken(),
					sessionId: `access-programs-${slug}`,
					providerSessionState,
					preferWebsockets: true,
					fetch: host.fetch,
				};

				const first = await streamOpenAICodexResponses(model, turnContext("First turn"), options).result();
				const second = await streamOpenAICodexResponses(
					model,
					{
						systemPrompt: ["You are a helpful assistant."],
						messages: [
							{ role: "user", content: "First turn", timestamp: 1 },
							first,
							{ role: "user", content: "Second turn", timestamp: 2 },
						],
					},
					options,
				).result();

				expect(second.stopReason).toBe("stop");
				expect(frames).toHaveLength(2);
				expect(frames[1]?.previous_response_id).toBe("resp_1");
				expect(frames.map(frame => frame.access_programs)).toEqual([expected, expected]);
				expect(host.listings).toEqual([]);
			});

			it("on the server-side compaction body", async () => {
				const model = await discoveredModel(slug);
				const host = codexHost(() => new Response('{"detail":"Not Found"}', { status: 404 }));

				await expect(
					openAIResponsesServerCompaction.compact({
						sessionId: `access-programs-${slug}`,
						model,
						messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
						apiKey: codexToken(),
						fetch: host.fetch,
					}),
				).rejects.toThrow("Server-side compaction is not available");

				expect(host.bodies).toHaveLength(1);
				expect(host.bodies[0]?.access_programs).toEqual(expected);
				expect(host.listings).toEqual([]);
			});
		});
	}
});

describe("after discovery lists every account, a request selects from the signing account's entry", () => {
	const slugs = LEVELS.flatMap(level => ACCOUNT_LEVELS[level].listing.map(({ slug }) => slug)).filter(
		(slug, index, all) => all.indexOf(slug) === index,
	);
	for (const slug of slugs) {
		for (const signedBy of LEVELS) {
			const signer = ACCOUNT_LEVELS[signedBy];
			const listedModel = signer.listing.find(listed => listed.slug === slug);
			it(`${slug} signed by a ${signedBy} account`, async () => {
				const model = (await discoverEveryLevel()).get(slug);
				if (!model) throw new Error(`discovery resolved no model ${slug}`);
				const host = codexHost(turnOrAbsentCompaction);

				await turnAndCompaction(model, codexToken(signer.accountId), host);

				expect(model.accountAccess?.[signer.accountId]?.listed).toBe(listedModel !== undefined);
				expect(host.bodies.map(body => body.access_programs)).toEqual([
					listedModel?.expected,
					listedModel?.expected,
				]);
				// Every account has an entry, so no request lists an account.
				expect(host.listings).toEqual([]);
			});
		}
	}
});

describe("a Codex request carries the program the account that signs it is offered", () => {
	for (const discoveredBy of LEVELS) {
		for (const { slug } of ACCOUNT_LEVELS[discoveredBy].listing) {
			for (const signedBy of LEVELS) {
				const signer = ACCOUNT_LEVELS[signedBy];
				// A model the signing account is not listed carries no program.
				const expected = signer.listing.find(listed => listed.slug === slug)?.expected;
				it(`${slug} discovered by a ${discoveredBy} account, signed by a ${signedBy} account`, async () => {
					const discoverer = ACCOUNT_LEVELS[discoveredBy];
					const model = await discoveredModel(slug, discoverer.listing, codexToken(discoverer.accountId));
					const host = codexHost(turnOrAbsentCompaction);

					await turnAndCompaction(model, codexToken(signer.accountId), host);

					expect(host.bodies.map(body => body.access_programs)).toEqual([expected, expected]);
					// The signing account is listed once, and the listing serves the turn and the compaction.
					expect(host.listings).toEqual(discoveredBy === signedBy ? [] : [signer.accountId]);
				});
			}
		}
	}

	it("selects from the signing account's listing for a model discovered before its account was recorded", async () => {
		// A cached row written before discovery recorded the account, and a bundled model, hold no account.
		const blue = ACCOUNT_LEVELS.daybreak_blue;
		const model = await discoveredModel("gpt-5.6-sol", blue.listing, codexToken(null));
		expect(model.accountAccess).toBeUndefined();
		const host = codexHost(turnOrAbsentCompaction);

		await turnAndCompaction(model, codexToken(blue.accountId), host);

		expect(host.bodies.map(body => body.access_programs)).toEqual([
			{ cyber: "daybreak_blue" },
			{ cyber: "daybreak_blue" },
		]);
		expect(host.listings).toEqual([blue.accountId]);
	});

	it("omits the field, with no listing, for a token that names no account", async () => {
		const blue = ACCOUNT_LEVELS.daybreak_blue;
		const model = await discoveredModel("gpt-5.6-sol", blue.listing, codexToken(blue.accountId));
		const host = codexHost(turnOrAbsentCompaction);

		await turnAndCompaction(model, codexToken(null), host);

		expect(host.bodies.map(body => body.access_programs)).toEqual([undefined, undefined]);
		expect(host.listings).toEqual([]);
	});

	it("omits the field and still sends the turn when the signing account's listing fails", async () => {
		const blue = ACCOUNT_LEVELS.daybreak_blue;
		const model = await discoveredModel("gpt-5.6-sol", blue.listing, codexToken(blue.accountId));
		const host = codexHost(turnOrAbsentCompaction, () => new Response("{}", { status: 503 }));

		await turnAndCompaction(model, codexToken(ACCOUNT_LEVELS.daybreak_red.accountId), host);

		expect(host.bodies.map(body => body.access_programs)).toEqual([undefined, undefined]);
		// The failure is reused: the compaction does not list the account again.
		expect(host.listings).toEqual([ACCOUNT_LEVELS.daybreak_red.accountId]);
	});

	it("ends the turn as aborted, with nothing sent, when the caller aborts during a listing", async () => {
		const blue = ACCOUNT_LEVELS.daybreak_blue;
		const model = await discoveredModel("gpt-5.6-sol", blue.listing, codexToken(blue.accountId));
		const { host, started, answer } = heldListingHost(completedTurn);
		const caller = new AbortController();

		const turn = streamOpenAICodexResponses(model, turnContext("Say hello"), {
			apiKey: codexToken(ACCOUNT_LEVELS.daybreak_red.accountId),
			fetch: host.fetch,
			preferWebsockets: false,
			signal: caller.signal,
		}).result();
		await started;
		caller.abort();
		const result = await turn;
		answer();

		expect(result.stopReason).toBe("aborted");
		expect(host.bodies).toEqual([]);
	});

	it("lists nothing and omits the field for a caller already aborted", async () => {
		const host = codexHost(completedTurn);
		const caller = new AbortController();
		caller.abort();

		const programs = await resolveCodexAccessPrograms(
			{ id: "gpt-5.6-sol", baseUrl: DISCOVERY_BASE_URL },
			codexToken(ACCOUNT_LEVELS.daybreak_red.accountId),
			{ fetch: host.fetch, signal: caller.signal },
		);

		expect(programs).toBeUndefined();
		expect(host.listings).toEqual([]);
	});

	it("sends a compaction no turn preceded without the field, and lists no account", async () => {
		const model = await discoveredModel("gpt-5.6-sol", ACCOUNT_LEVELS.daybreak_blue.listing, codexToken(null));
		const host = codexHost(turnOrAbsentCompaction);

		await expect(
			openAIResponsesServerCompaction.compact({
				sessionId: "access-programs-compaction-alone",
				model,
				messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
				apiKey: codexToken(ACCOUNT_LEVELS.daybreak_red.accountId),
				fetch: host.fetch,
			}),
		).rejects.toThrow("Server-side compaction is not available");

		expect(host.bodies.map(body => body.access_programs)).toEqual([undefined]);
		expect(host.listings).toEqual([]);
	});
});

describe("an account's listing is shared, reused for its lifetime and bounded", () => {
	const red = ACCOUNT_LEVELS.daybreak_red;
	/** A model no discovery recorded an account for, so every resolution reads the account's listing. */
	const unrecorded = { id: "gpt-5.6-sol", baseUrl: DISCOVERY_BASE_URL };

	it("lists an account once for concurrent requests", async () => {
		const host = codexHost(completedTurn);

		const programs = await Promise.all(
			[1, 2, 3].map(() => resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), { fetch: host.fetch })),
		);

		expect(programs).toEqual([{ cyber: "daybreak_red" }, { cyber: "daybreak_red" }, { cyber: "daybreak_red" }]);
		expect(host.listings).toEqual([red.accountId]);
	});

	it("lists under the backend root for every spelling of a Codex base URL, once", async () => {
		const host = codexHost(completedTurn);
		const spellings = [
			undefined,
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses/",
		];

		const programs = [];
		for (const baseUrl of spellings) {
			programs.push(
				await resolveCodexAccessPrograms({ id: "gpt-5.6-sol", baseUrl }, codexToken(red.accountId), {
					fetch: host.fetch,
				}),
			);
		}

		expect(programs).toEqual(spellings.map(() => ({ cyber: "daybreak_red" })));
		expect(host.listingUrls).toEqual(["https://chatgpt.com/backend-api/codex/models"]);
	});

	it("reuses a listing until its lifetime ends, then lists the account again", async () => {
		const host = codexHost(completedTurn);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const resolve = () => resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), { fetch: host.fetch });

		expect(await resolve()).toEqual({ cyber: "daybreak_red" });
		now.mockReturnValue(1_000_000 + CODEX_ACCESS_PROGRAM_LISTING_TTL_MS - 1);
		expect(await resolve()).toEqual({ cyber: "daybreak_red" });
		expect(host.listings).toEqual([red.accountId]);

		now.mockReturnValue(1_000_000 + CODEX_ACCESS_PROGRAM_LISTING_TTL_MS);
		expect(await resolve()).toEqual({ cyber: "daybreak_red" });
		expect(host.listings).toEqual([red.accountId, red.accountId]);
	});

	it("reuses a failed listing for the failure lifetime only", async () => {
		let healthy = false;
		const host = codexHost(completedTurn, accountId =>
			healthy ? levelListing(accountId) : new Response("{}", { status: 503 }),
		);
		const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
		const resolve = () => resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), { fetch: host.fetch });

		expect(await resolve()).toBeUndefined();
		healthy = true;
		now.mockReturnValue(2_000_000 + CODEX_ACCESS_PROGRAM_FAILURE_TTL_MS - 1);
		expect(await resolve()).toBeUndefined();
		expect(host.listings).toEqual([red.accountId]);

		now.mockReturnValue(2_000_000 + CODEX_ACCESS_PROGRAM_FAILURE_TTL_MS);
		expect(await resolve()).toEqual({ cyber: "daybreak_red" });
		expect(host.listings).toEqual([red.accountId, red.accountId]);
	});

	it("uses a listing that answers before the listing timeout", async () => {
		vi.useFakeTimers();
		const { host, started, answer } = heldListingHost(completedTurn);

		const programs = resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), { fetch: host.fetch });
		await started;
		vi.advanceTimersByTime(CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS - 1);
		answer();

		expect(await programs).toEqual({ cyber: "daybreak_red" });
	});

	it("abandons a listing that does not answer at the listing timeout and omits the field", async () => {
		vi.useFakeTimers();
		const { host, started, answer } = heldListingHost(completedTurn);

		const programs = resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), { fetch: host.fetch });
		await started;
		vi.advanceTimersByTime(CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS);
		answer();

		expect(await programs).toBeUndefined();
		expect(CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS).toBe(5_000);
	});

	it("omits the field for a caller that stops waiting, and serves the listing to the account's next request", async () => {
		vi.useFakeTimers();
		const answer = Promise.withResolvers<void>();
		const host = codexHost(completedTurn, async accountId => {
			await answer.promise;
			return levelListing(accountId);
		});
		const token = codexToken(red.accountId);

		const bounded = resolveCodexAccessPrograms(unrecorded, token, { fetch: host.fetch, waitMs: 500 });
		vi.advanceTimersByTime(500);
		expect(await bounded).toBeUndefined();

		answer.resolve();
		expect(await resolveCodexAccessPrograms(unrecorded, token, { fetch: host.fetch })).toEqual({
			cyber: "daybreak_red",
		});
		expect(host.listings).toEqual([red.accountId]);
	});

	it("waits for the listing when the caller's wait bound is off", async () => {
		vi.useFakeTimers();
		const answer = Promise.withResolvers<void>();
		const host = codexHost(completedTurn, async accountId => {
			await answer.promise;
			return levelListing(accountId);
		});

		const unbounded = resolveCodexAccessPrograms(unrecorded, codexToken(red.accountId), {
			fetch: host.fetch,
			waitMs: 0,
		});
		vi.advanceTimersByTime(CODEX_ACCESS_PROGRAM_LISTING_TIMEOUT_MS - 1);
		answer.resolve();

		expect(await unbounded).toEqual({ cyber: "daybreak_red" });
	});

	// Each listing answers right after the caller's bound passes: a caller that kept its bound has already
	// gone on without it, and a caller that waited for it sends the program it carries.
	it("sends a turn without the field once the listing outlasts the turn's first-event timeout", async () => {
		const model = await discoveredModel("gpt-5.6-sol", ACCOUNT_LEVELS.daybreak_blue.listing, codexToken(null));
		vi.useFakeTimers();
		const { host, started, answer } = heldListingHost(completedTurn);

		const turn = streamOpenAICodexResponses(model, turnContext("Say hello"), {
			apiKey: codexToken(red.accountId),
			fetch: host.fetch,
			preferWebsockets: false,
			streamFirstEventTimeoutMs: 500,
		}).result();
		await started;
		vi.advanceTimersByTime(500);
		answer();

		expect((await turn).stopReason).toBe("stop");
		expect(host.bodies.map(body => body.access_programs)).toEqual([undefined]);
	});

	it("ends a compaction at its timeout, with nothing sent, while its turn's listing has not answered", async () => {
		const model = await discoveredModel("gpt-5.6-sol", ACCOUNT_LEVELS.daybreak_blue.listing, codexToken(null));
		vi.useFakeTimers();
		const { host, started, answer } = heldListingHost(turnOrAbsentCompaction);
		const turn = streamOpenAICodexResponses(model, turnContext("Say hello"), {
			apiKey: codexToken(red.accountId),
			fetch: host.fetch,
			preferWebsockets: false,
			streamFirstEventTimeoutMs: 10_000,
		}).result();
		await started;

		const outcome = openAIResponsesServerCompaction
			.compact({
				sessionId: "access-programs-compaction-timeout",
				model,
				messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
				apiKey: codexToken(red.accountId),
				fetch: host.fetch,
				timeoutMs: 500,
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		vi.advanceTimersByTime(500);
		answer();

		expect(await outcome).toMatchObject({ name: "TimeoutError" });
		expect((await turn).stopReason).toBe("stop");
		// The turn alone was sent, with the program its listing offers.
		expect(host.bodies.map(body => body.access_programs)).toEqual([{ cyber: "daybreak_red" }]);
		expect(host.listings).toEqual([red.accountId]);
	});
});
