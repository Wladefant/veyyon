/**
 * WHY: a local summarization request built on `SUMMARIZATION_SYSTEM_PROMPT` sends
 * a prefix no later request repeats. It went out with the session's default cache
 * retention, so Anthropic wrote a cache entry that was never read (twice the input
 * rate for an hour-long entry on a subscription) and, because the request rode the
 * session's cache key, the tracker reported every one of them as "prompt cache
 * prefix changed: rewrote N of N+4 input tokens". A split-turn mid-run compaction
 * produced one per pass from its turn-prefix summary.
 *
 * The class: every standalone summarization request asks for no cache, and the
 * cache-aligned request, which replays the live session's prefix, keeps its
 * markers. The members are the turn-prefix summary, the history summary when the
 * cache-aligned path is unavailable, every staged segment and merge request, the
 * branch summary, and the server-side window port without a session prompt. The
 * Anthropic members are driven through the real provider over a scripted
 * transport and judged by the bytes each request put on the wire.
 *
 * Gap: a new standalone request path that none of these scenarios reaches is not
 * swept. The port is judged by the `cacheRetention` it hands the transport; how
 * the OpenAI providers honour "none" is pinned in the ai package.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionEntry,
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	SUMMARIZATION_SYSTEM_PROMPT,
	type SummaryOptions,
	summarizeRemoteCompactionWindow,
} from "@veyyon/agent-core/compaction";
import {
	type AssistantMessage,
	type Context,
	completeSimple,
	type FetchImpl,
	type Message,
	type ProviderSessionState,
	type SimpleStreamOptions,
	type Tool,
} from "@veyyon/ai";
import * as logger from "@veyyon/utils/logger";
import { anthropicModel, requireBundledModel } from "./helpers";
import { readResult, user } from "./support/compaction-session";

const SESSION_KEY = "live-session";
const SESSION_PROMPT = ["# Harness\nstable shared prefix", "# Project\nlocal rules"];
const TOOLS: Tool[] = [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }];

function assistantText(text: string, timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function assistantToolCall(id: string, timestamp = 3): AssistantMessage {
	return {
		...assistantText("", timestamp),
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
		stopReason: "toolUse",
	};
}

/** The live conversation a mid-run compaction runs inside: every tool call answered. */
function liveConversation(): Message[] {
	return [
		user("first question"),
		assistantToolCall("call-1"),
		readResult("call-1", "first file"),
		user("second question"),
		assistantToolCall("call-2"),
		readResult("call-2", "second file"),
	];
}

/** A cut through the second turn: the first turn is history, the second turn's start is its prefix. */
function splitTurn(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [user("first question"), assistantToolCall("call-1"), readResult("call-1", "first file")],
		turnPrefixMessages: [user("second question"), assistantToolCall("call-2")],
		recentMessages: [readResult("call-2", "second file")],
		isSplitTurn: true,
		tokensBefore: 100_000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

/** A complete Anthropic SSE turn reporting `usage`. */
function sseTurn(usage: { input: number; cacheRead: number; cacheWrite: number }): string {
	const reported = {
		input_tokens: usage.input,
		cache_read_input_tokens: usage.cacheRead,
		cache_creation_input_tokens: usage.cacheWrite,
	};
	const events: Array<[string, unknown]> = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_stub",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					usage: { ...reported, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The work so far." } },
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...reported, output_tokens: 5 } },
		],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function systemTexts(body: unknown): string[] {
	if (typeof body !== "object" || body === null || !("system" in body) || !Array.isArray(body.system)) return [];
	return body.system.flatMap((block: unknown) =>
		typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
			? [block.text]
			: [],
	);
}

interface SentRequest {
	/** The request opened with `SUMMARIZATION_SYSTEM_PROMPT` rather than the session's prompt. */
	standalone: boolean;
	/** The wire body carried at least one `cache_control` marker. */
	cacheMarked: boolean;
}

interface AnthropicEndpoint {
	fetch: FetchImpl;
	/** Every request the endpoint received, in arrival order. */
	sent: SentRequest[];
}

/**
 * The Anthropic endpoint, billing the way it does: a standalone prompt is never
 * in the cache, so a marker on it writes everything past the first few tokens;
 * a request that replays the session prefix reads the entry the live turns wrote.
 */
function anthropicEndpoint(): AnthropicEndpoint {
	const sent: SentRequest[] = [];
	const fetchImpl: FetchImpl = async (_input, init) => {
		const body = typeof init?.body === "string" ? init.body : "";
		const standalone = systemTexts(JSON.parse(body)).some(text => text.includes(SUMMARIZATION_SYSTEM_PROMPT));
		const cacheMarked = body.includes('"cache_control"');
		sent.push({ standalone, cacheMarked });
		const usage = !standalone
			? { input: 300, cacheRead: 200_000, cacheWrite: 0 }
			: cacheMarked
				? { input: 4, cacheRead: 0, cacheWrite: 11_004 }
				: { input: 11_008, cacheRead: 0, cacheWrite: 0 };
		return new Response(sseTurn(usage), { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch: fetchImpl, sent };
}

/**
 * A session that has already run a live turn on its cache key, so the tracker
 * judges each later request on that key against a cache it knows was read.
 */
async function warmSession(endpoint: AnthropicEndpoint): Promise<Map<string, ProviderSessionState>> {
	const providerSessionState = new Map<string, ProviderSessionState>();
	const live: Context = { systemPrompt: SESSION_PROMPT, messages: liveConversation(), tools: TOOLS };
	const reply = await completeSimple(anthropicModel(), live, {
		apiKey: "test-key",
		fetch: endpoint.fetch,
		promptCacheKey: SESSION_KEY,
		sessionId: SESSION_KEY,
		providerSessionState,
	});
	expect(reply.stopReason).toBe("stop");
	expect(endpoint.sent).toEqual([{ standalone: false, cacheMarked: true }]);
	endpoint.sent.length = 0;
	return providerSessionState;
}

/** Collects every cache verdict the provider reports while a test runs. */
function captureCacheWarnings(): string[] {
	const warnings: string[] = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string) => {
		if (message.includes("prompt cache")) warnings.push(message);
	});
	return warnings;
}

interface Scenario {
	name: string;
	/** Session fields the compaction receives on top of the cache identity. */
	options: SummaryOptions;
	expected: { standalone: number; aligned: number };
}

/**
 * The history half of `compact()` in each shape it takes. The turn-prefix half is
 * standalone in all of them, so every row carries one standalone request for it.
 */
const COMPACTION_SCENARIOS: Scenario[] = [
	{
		name: "a split turn on a session whose prefix the history summary replays",
		options: { sessionSystemPrompt: SESSION_PROMPT, sessionMessages: liveConversation(), tools: TOOLS },
		expected: { standalone: 1, aligned: 1 },
	},
	{
		name: "a split turn with no session prefix to replay",
		options: {},
		expected: { standalone: 2, aligned: 0 },
	},
	{
		name: "a split turn whose history is summarized in stages",
		options: { summaryStaging: "staged" },
		// One segment request and one merge request, plus the turn prefix.
		expected: { standalone: 3, aligned: 0 },
	},
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a summary request that no later turn repeats asks for no cache", () => {
	for (const scenario of COMPACTION_SCENARIOS) {
		it(`compact(): ${scenario.name}`, async () => {
			const endpoint = anthropicEndpoint();
			const providerSessionState = await warmSession(endpoint);
			const cacheWarnings = captureCacheWarnings();

			const result = await compact(splitTurn(), anthropicModel(), "test-key", undefined, undefined, {
				...scenario.options,
				sessionId: SESSION_KEY,
				promptCacheKey: SESSION_KEY,
				providerSessionState,
				fetch: endpoint.fetch,
			});

			// The symptom: a "prompt cache prefix changed" verdict on the session's key.
			expect(cacheWarnings).toEqual([]);
			expect(result.summary).toContain("**Turn Context (split turn):**");
			const standalone = endpoint.sent.filter(request => request.standalone);
			const aligned = endpoint.sent.filter(request => !request.standalone);
			expect({ standalone: standalone.length, aligned: aligned.length }).toEqual(scenario.expected);
			expect(standalone.filter(request => request.cacheMarked)).toEqual([]);
			// The request that replays the live prefix still reads the entry the live turns wrote.
			expect(aligned.filter(request => !request.cacheMarked)).toEqual([]);
		});
	}

	it("generateBranchSummary(): the abandoned branch is summarized without a cache marker", async () => {
		const endpoint = anthropicEndpoint();
		await generateBranchSummary(
			[
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					message: user("an abandoned branch"),
					timestamp: "2026-01-01T00:00:00.000Z",
				},
			],
			{
				model: anthropicModel(),
				apiKey: "test-key",
				signal: new AbortController().signal,
				sessionId: SESSION_KEY,
				promptCacheKey: SESSION_KEY,
				completeImpl: (model, context, options) =>
					completeSimple(model, context, { ...options, fetch: endpoint.fetch }),
			},
		);
		expect(endpoint.sent).toEqual([{ standalone: true, cacheMarked: false }]);
	});

	it("summarizeRemoteCompactionWindow(): the window port asks for a cache only behind the session's prompt", async () => {
		const model = requireBundledModel("openai", "gpt-5.1");
		const entry: CompactionEntry = {
			type: "compaction",
			id: "remote-compaction",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			summary: "Compacted on the server.",
			firstKeptEntryId: "kept-entry",
			tokensBefore: 100_000,
			preserveData: {
				remoteCompaction: {
					version: 1,
					provider: model.provider,
					api: model.api,
					model: model.id,
					window: [{ type: "compaction", encrypted_content: "opaque" }],
					compactedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		const sent: Array<{ standalone: boolean; cacheRetention: SimpleStreamOptions["cacheRetention"] }> = [];
		const options: SummaryOptions = {
			completeImpl: async (_model, context, streamOptions) => {
				sent.push({
					standalone: (context.systemPrompt ?? []).some(text => text.includes(SUMMARIZATION_SYSTEM_PROMPT)),
					cacheRetention: streamOptions.cacheRetention,
				});
				return assistantText("The ported window.");
			},
		};

		await summarizeRemoteCompactionWindow(entry, model, 16_384, "test-key", undefined, options);
		await summarizeRemoteCompactionWindow(entry, model, 16_384, "test-key", undefined, {
			...options,
			sessionSystemPrompt: SESSION_PROMPT,
		});

		expect(sent).toEqual([
			{ standalone: true, cacheRetention: "none" },
			{ standalone: false, cacheRetention: undefined },
		]);
	});
});
