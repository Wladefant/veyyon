/**
 * WHY: ChatGPT Codex refused security work in veyyon sessions with `cyber_policy`, whose message
 * states that `access_programs.cyber` must be set to the appropriate tier. veyyon never sent the
 * field. codex-rs 0.163.0 reads `available_access_programs` from model discovery and sends the
 * advertised Daybreak program, `daybreak_blue` before `daybreak_red`, on every request of a turn.
 *
 * Class closed: the program discovery advertises for a model reaches every request a turn makes.
 * The suite drives the production path end to end: the `/codex/models` payload is read by
 * `fetchCodexModels`, merged with the bundled catalog and written to the model cache by
 * `resolveProviderModels`, read back from that cache as a launch reads it, and then sent as an HTTP
 * turn, a websocket `response.create` frame (the first frame and the stateful delta frame), and a
 * server-side compaction. Every advertised shape is swept against all three: both Daybreak tiers,
 * either order, `standard` only, an empty list, unknown program names, a `cyber` value that is not
 * a list, and no metadata at all.
 *
 * Not caught: a Codex request built outside `transformRequestBody` and the compaction transport.
 * The web search provider is one; it reads only the bundled catalog, which never contains a
 * caller-specific program. A server that renames a program is also not caught.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
} from "@veyyon/ai/providers/openai-compaction";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import * as piUtils from "@veyyon/utils";

const DISCOVERY_BASE_URL = "https://codex.example/backend-api";
const originalWebSocket = global.WebSocket;

interface AdvertisedCase {
	/** Model slug the discovery payload lists. */
	slug: string;
	/** The raw `available_access_programs` value, or `undefined` to leave the key out. */
	advertised: unknown;
	/** The `access_programs` every request for the model must carry, or `undefined` for none. */
	expected: { cyber: string } | undefined;
}

const CASES: readonly AdvertisedCase[] = [
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

let tempDir: string | undefined;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(async () => {
	global.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
	resetServerCompactionRouteCache();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function discoveryPayload(): string {
	return JSON.stringify({
		models: CASES.map(({ slug, advertised }) => ({
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

/** The models a launch resolves: discovered once, then read back from the model cache. */
async function discoverModels(): Promise<Map<string, Model<"openai-codex-responses">>> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-access-programs-"));
	const cacheDbPath = path.join(tempDir, "models.db");
	let fetches = 0;
	const fetchDynamicModels = async () => {
		fetches++;
		const discovered = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: DISCOVERY_BASE_URL,
			fetchFn: Object.assign(async () => new Response(discoveryPayload()), { preconnect() {} }),
		});
		return discovered?.models ?? null;
	};
	const options = {
		providerId: "openai-codex",
		dynamicModelsAuthoritative: true,
		cacheDbPath,
		fetchDynamicModels,
	} as const;
	await resolveProviderModels<"openai-codex-responses">(options);
	const cached = await resolveProviderModels<"openai-codex-responses">(options);
	expect(fetches).toBe(1);
	return new Map(cached.models.map(model => [model.id, model]));
}

async function discoveredModel(slug: string): Promise<Model<"openai-codex-responses">> {
	const model = (await discoverModels()).get(slug);
	if (!model) throw new Error(`discovery resolved no model ${slug}`);
	return model;
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
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

/** Records every Codex POST body and answers each with `respond`. */
function recordingFetch(respond: () => Response): { fetch: FetchImpl; bodies: Array<Record<string, unknown>> } {
	const bodies: Array<Record<string, unknown>> = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
		return respond();
	}) as FetchImpl;
	return { fetch: impl, bodies };
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

describe("a Codex request carries the Daybreak program discovery offers", () => {
	it("resolves every advertised case to a discovered model", async () => {
		const models = await discoverModels();
		expect(CASES.filter(({ slug }) => !models.has(slug)).map(({ slug }) => slug)).toEqual([]);
	});

	for (const { slug, expected } of CASES) {
		describe(slug, () => {
			it("on the HTTP turn body", async () => {
				const model = await discoveredModel(slug);
				const { fetch, bodies } = recordingFetch(
					() => new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
				);

				const result = await streamOpenAICodexResponses(model, turnContext("Say hello"), {
					apiKey: codexToken(),
					fetch,
					preferWebsockets: false,
				}).result();

				expect(result.stopReason).toBe("stop");
				expect(bodies).toHaveLength(1);
				expect(bodies[0]?.access_programs).toEqual(expected);
			});

			it("on the first websocket frame and the stateful delta frame", async () => {
				const model = await discoveredModel(slug);
				const frames = installRecordingWebSocket();
				const providerSessionState = new Map<string, ProviderSessionState>();
				const options = {
					apiKey: codexToken(),
					sessionId: `access-programs-${slug}`,
					providerSessionState,
					preferWebsockets: true,
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
			});

			it("on the server-side compaction body", async () => {
				const model = await discoveredModel(slug);
				const { fetch, bodies } = recordingFetch(() => new Response('{"detail":"Not Found"}', { status: 404 }));

				// The host answers 404 so the call ends after one request; the body is what was sent.
				await expect(
					openAIResponsesServerCompaction.compact({
						sessionId: `access-programs-${slug}`,
						model,
						messages: [{ role: "user", content: "compact this span", timestamp: 1 }],
						apiKey: codexToken(),
						fetch,
					}),
				).rejects.toThrow("Server-side compaction is not available");

				expect(bodies).toHaveLength(1);
				expect(bodies[0]?.access_programs).toEqual(expected);
			});
		});
	}
});
