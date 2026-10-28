/**
 * A Claude model that rejects a forced `tool_choice` is sent `auto`, and an Anthropic-messages
 * endpoint that rejects a forced choice is retried once with `auto` and remembered for the session.
 *
 * WHY THIS SUITE EXISTS. Claude Opus 5.5 answers a `tool_choice` of type `tool` or `any` with
 * `400 tool_choice: type "tool" and "any" are not supported for this model.`. The catalog sent
 * `auto` in place of a forced choice only for Fable and Mythos, so every forced call to Opus 5.5
 * (the `yield` and `resolve` reminders an agent turn sends) failed with that 400 and ended the
 * turn. Kimi's Anthropic-compatible endpoint rejects the same request as `tool_choice 'specified'
 * is incompatible with thinking enabled`. The OpenAI-shaped transports retried a rejected choice;
 * the Anthropic transport had no recovery for either wording.
 *
 * THE CLASS THIS CLOSES. A forced `tool_choice` decision made from a static list on the Claude
 * transports, in either direction, and a forced-choice rejection the static list does not foresee
 * on the Anthropic-messages transport.
 *
 * WHAT IS SWEPT FROM SOURCE. Every bundled Claude row on the Anthropic-messages and Bedrock
 * transports is driven through its stream function, and its generation must have a recorded
 * decision in `DECISIONS`: a generation the catalog adds is red until someone records one. Every
 * recorded generation is also driven as a synthetic row on both transports, which covers the
 * generations a session reaches through model discovery rather than through the bundled catalog.
 *
 * WHAT IT DOES NOT CATCH. Whether Anthropic still rejects these generations, which needs a live
 * request. Claude behind an OpenAI-shaped gateway, whose reactive drop is covered by
 * `a-tool-choice-the-endpoint-rejects-is-dropped-once-and-remembered`. Claude behind the Cloud Code
 * Assist transport, which has recorded no rejection. A rejection that arrives after the first
 * token, which the transport does not retry because the turn already streamed content.
 */
import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { Api, AssistantMessage, Context, FetchImpl, Model, ProviderSessionState, Tool } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { bareModelId, parseAnthropicModel } from "@veyyon/catalog/identity";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { type } from "arktype";

type AnthropicChoice = "auto" | "any" | "none" | { type: "tool"; name: string };
type WireKind = "auto" | "none" | "forced" | undefined;
type ClaudeTransport = "anthropic-messages" | "bedrock-converse-stream";

const CLAUDE_TRANSPORTS: readonly ClaudeTransport[] = ["anthropic-messages", "bedrock-converse-stream"];

/**
 * What a forced choice becomes on the wire, per Claude generation (`<kind> <major>.<minor>`).
 * Opus and Sonnet from 5.5 and every Fable and Mythos reject forced tool use; later Opus and
 * Sonnet generations are recorded as inheriting it.
 */
const DECISIONS: Readonly<Record<string, "forced" | "auto">> = {
	"opus 3.0": "forced",
	"opus 4.0": "forced",
	"opus 4.1": "forced",
	"opus 4.5": "forced",
	"opus 4.6": "forced",
	"opus 4.7": "forced",
	"opus 4.8": "forced",
	"opus 5.0": "forced",
	"opus 5.5": "auto",
	"opus 6.0": "auto",
	"sonnet 3.0": "forced",
	"sonnet 3.5": "forced",
	"sonnet 3.7": "forced",
	"sonnet 4.0": "forced",
	"sonnet 4.5": "forced",
	"sonnet 4.6": "forced",
	"sonnet 5.0": "forced",
	"sonnet 5.5": "auto",
	"sonnet 6.0": "auto",
	"fable 5.0": "auto",
	"fable 5.1": "auto",
	"mythos 5.0": "auto",
	"mythos 5.1": "auto",
};

const respondTool: Tool = {
	name: "respond",
	description: "Answer with structured fields",
	parameters: type({ text: "string" }),
};

function context(): Context {
	return {
		messages: [{ role: "user", content: "start the interview", timestamp: 0 }],
		tools: [respondTool],
	};
}

function generationOf(modelId: string): string | undefined {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed ? `${parsed.kind} ${parsed.version.major}.${parsed.version.minor}` : undefined;
}

/** A model id Anthropic would publish for a recorded generation, e.g. `claude-opus-5-5`. */
function syntheticClaudeId(generation: string): string {
	const [kind, version] = generation.split(" ") as [string, string];
	const [major, minor] = version.split(".") as [string, string];
	return minor === "0" ? `claude-${kind}-${major}` : `claude-${kind}-${major}-${minor}`;
}

function syntheticModel(transport: ClaudeTransport, generation: string): Model<Api> {
	const claudeId = syntheticClaudeId(generation);
	return buildModel({
		id: transport === "bedrock-converse-stream" ? `anthropic.${claudeId}` : claudeId,
		name: claudeId,
		api: transport,
		provider: transport === "bedrock-converse-stream" ? "amazon-bedrock" : "anthropic",
		baseUrl: transport === "bedrock-converse-stream" ? "" : "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	}) as Model<Api>;
}

function anthropicKind(choice: unknown): WireKind {
	if (choice === undefined) return undefined;
	const choiceType = (choice as { type?: unknown }).type;
	if (choiceType === "auto" || choiceType === "none") return choiceType;
	return "forced";
}

function bedrockKind(toolConfig: unknown): WireKind {
	const choice = (toolConfig as { toolChoice?: Record<string, unknown> } | undefined)?.toolChoice;
	if (choice === undefined) return undefined;
	if ("auto" in choice) return "auto";
	return "forced";
}

/** Read the request the transport assembles for a forced named choice, without sending it. */
async function wireKindFor(model: Model<Api>): Promise<WireKind> {
	const { promise, resolve } = Promise.withResolvers<WireKind>();
	const aborted = new AbortController();
	aborted.abort();
	if (model.api === "anthropic-messages") {
		streamAnthropic(model as Model<"anthropic-messages">, context(), {
			apiKey: "test-key",
			signal: aborted.signal,
			toolChoice: { type: "tool", name: "respond" },
			onPayload: payload => resolve(anthropicKind((payload as { tool_choice?: unknown }).tool_choice)),
		});
	} else if (model.api === "bedrock-converse-stream") {
		streamBedrock(model as Model<"bedrock-converse-stream">, context(), {
			apiKey: "test-key",
			signal: aborted.signal,
			toolChoice: { type: "tool", name: "respond" },
			fetch: async () => new Response("", { status: 200 }),
			onPayload: payload => {
				resolve(bedrockKind((payload as { toolConfig?: unknown }).toolConfig));
				return undefined;
			},
		});
	} else {
		throw new Error(`no request builder wired for ${model.api}`);
	}
	return promise;
}

const BUNDLED_CLAUDE: readonly { provider: string; model: Model<Api>; generation: string }[] =
	getBundledProviders().flatMap(provider =>
		getBundledModels(provider).flatMap(model => {
			if (!(CLAUDE_TRANSPORTS as readonly Api[]).includes(model.api)) return [];
			const generation = generationOf(model.id);
			return generation ? [{ provider, model, generation }] : [];
		}),
	);

describe("a forced tool choice reaches a Claude model only when its generation takes one", () => {
	it("sweeps a non-empty bundled Claude catalog on both transports, every generation decided", () => {
		expect([...new Set(BUNDLED_CLAUDE.map(({ model }) => model.api))].sort()).toEqual([...CLAUDE_TRANSPORTS]);
		const undecided = [...new Set(BUNDLED_CLAUDE.map(({ generation }) => generation))].filter(
			generation => DECISIONS[generation] === undefined,
		);
		expect(undecided).toEqual([]);
	});

	it("sends every bundled Claude row the decision recorded for its generation", async () => {
		const wrong: string[] = [];
		for (const { provider, model, generation } of BUNDLED_CLAUDE) {
			const kind = await wireKindFor(model);
			if (kind !== DECISIONS[generation]) wrong.push(`${provider}/${model.id} (${model.api}): ${kind}`);
		}
		expect(wrong).toEqual([]);
	}, 30_000);

	for (const transport of CLAUDE_TRANSPORTS) {
		it(`${transport}: sends every recorded generation its decision, bundled or discovered`, async () => {
			const wrong: string[] = [];
			for (const [generation, decision] of Object.entries(DECISIONS)) {
				const model = syntheticModel(transport, generation);
				expect(generationOf(model.id), model.id).toBe(generation);
				const kind = await wireKindFor(model);
				if (kind !== decision) wrong.push(`${model.id}: ${kind}`);
			}
			expect(wrong).toEqual([]);
		});
	}
});

const PROXY_BASE_URL = "https://llm-proxy.example/anthropic";

/** The two upstream wordings the sessions recorded for a forced choice on this transport. */
const REJECTIONS: readonly { label: string; message: string }[] = [
	{ label: "Claude", message: 'tool_choice: type "tool" and "any" are not supported for this model.' },
	{ label: "Kimi", message: "tool_choice 'specified' is incompatible with thinking enabled" },
];

const FORCED_FORMS: readonly { label: string; value: AnthropicChoice }[] = [
	{ label: "a named pin", value: { type: "tool", name: "respond" } },
	{ label: "any", value: "any" },
];

/** A custom provider whose id says nothing about forced tool use, so only the endpoint can. */
function proxyModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "my-proxy",
		baseUrl: PROXY_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	});
}

const ANTHROPIC_SUCCESS = [
	{
		type: "message_start",
		message: {
			id: "msg_tool_choice",
			type: "message",
			role: "assistant",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

function success(): Response {
	return new Response(ANTHROPIC_SUCCESS, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rejection(message: string, status: number): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message },
			request_id: "req_011C00000000000000000000",
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

/**
 * An endpoint that answers `message` with `status` for every request `rejects` matches and serves
 * the rest. Records each request body, and aborts the turn once it sends more than `cap` requests,
 * so a retry that does not end is observed as a count rather than as a hung test.
 */
class FakeEndpoint {
	readonly bodies: Record<string, unknown>[] = [];
	#controller = new AbortController();

	constructor(
		readonly rejects: (body: Record<string, unknown>) => boolean,
		readonly message: string,
		readonly status = 400,
		readonly cap = 6,
	) {}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Start a new turn: clear the request log and re-arm the runaway cap. */
	turn(): void {
		this.bodies.length = 0;
		this.#controller = new AbortController();
	}

	kinds(): WireKind[] {
		return this.bodies.map(body => anthropicKind(body.tool_choice));
	}

	readonly fetch: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			this.bodies.push(body);
			if (this.bodies.length > this.cap) {
				this.#controller.abort();
				return rejection("runaway retry", 400);
			}
			return this.rejects(body) ? rejection(this.message, this.status) : success();
		},
		{ preconnect: fetch.preconnect },
	);
}

function rejectsForced(body: Record<string, unknown>): boolean {
	return anthropicKind(body.tool_choice) === "forced";
}

async function runTurn(
	endpoint: FakeEndpoint,
	model: Model<"anthropic-messages">,
	toolChoice: AnthropicChoice | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): Promise<AssistantMessage> {
	endpoint.turn();
	return streamAnthropic(model, context(), {
		apiKey: "test-key",
		fetch: endpoint.fetch,
		signal: endpoint.signal,
		toolChoice,
		sessionId: "tool-choice-session",
		providerSessionState,
	}).result();
}

describe("an Anthropic-messages endpoint that rejects a forced tool choice is retried with auto and remembered", () => {
	it("starts from a model the catalog sends a forced choice", () => {
		expect(proxyModel("opus-latest").compat.supportsForcedToolChoice).toBe(true);
	});

	for (const { label: rejectionLabel, message } of REJECTIONS) {
		for (const { label: formLabel, value } of FORCED_FORMS) {
			it(`retries ${formLabel} with auto after the ${rejectionLabel} rejection, then sends auto for the session`, async () => {
				const endpoint = new FakeEndpoint(rejectsForced, message);
				const model = proxyModel("opus-latest");
				const session = new Map<string, ProviderSessionState>();

				const first = await runTurn(endpoint, model, value, session);
				expect(first.stopReason, first.errorMessage).toBe("stop");
				expect(endpoint.kinds()).toStrictEqual(["forced", "auto"]);
				expect(JSON.stringify(endpoint.bodies[1]?.tools ?? []), "the retry still offers the tool").toContain(
					"respond",
				);

				const second = await runTurn(endpoint, model, value, session);
				expect(second.stopReason, second.errorMessage).toBe("stop");
				expect(endpoint.kinds()).toStrictEqual(["auto"]);
			});
		}
	}

	it("remembers forced forms only, so none and auto still reach the wire", async () => {
		const endpoint = new FakeEndpoint(rejectsForced, REJECTIONS[0]!.message);
		const model = proxyModel("opus-latest");
		const session = new Map<string, ProviderSessionState>();

		await runTurn(endpoint, model, { type: "tool", name: "respond" }, session);
		expect(endpoint.bodies).toHaveLength(2);

		for (const choice of ["none", "auto"] as const) {
			const result = await runTurn(endpoint, model, choice, session);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(endpoint.kinds()).toStrictEqual([choice]);
		}
	});

	it("remembers the rejection for that model only", async () => {
		const endpoint = new FakeEndpoint(
			body => body.model === "opus-latest" && rejectsForced(body),
			REJECTIONS[0]!.message,
		);
		const session = new Map<string, ProviderSessionState>();

		await runTurn(endpoint, proxyModel("opus-latest"), "any", session);
		expect(endpoint.bodies).toHaveLength(2);

		const other = await runTurn(endpoint, proxyModel("sonnet-latest"), "any", session);
		expect(other.stopReason, other.errorMessage).toBe("stop");
		expect(endpoint.kinds()).toStrictEqual(["forced"]);
	});

	it("forgets the rejection when the session closes", async () => {
		const endpoint = new FakeEndpoint(rejectsForced, REJECTIONS[0]!.message);
		const model = proxyModel("opus-latest");
		const session = new Map<string, ProviderSessionState>();

		await runTurn(endpoint, model, "any", session);
		for (const state of session.values()) state.close();

		await runTurn(endpoint, model, "any", session);
		expect(endpoint.kinds()).toStrictEqual(["forced", "auto"]);
	});

	it("without a session, each turn pays its own single retry", async () => {
		const endpoint = new FakeEndpoint(rejectsForced, REJECTIONS[1]!.message);
		const model = proxyModel("k3");

		for (let turn = 0; turn < 2; turn++) {
			const result = await runTurn(endpoint, model, "any", undefined);
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(endpoint.kinds()).toStrictEqual(["forced", "auto"]);
		}
	});

	it("retries once and stops when the endpoint rejects auto too", async () => {
		const endpoint = new FakeEndpoint(() => true, REJECTIONS[0]!.message);

		const result = await runTurn(endpoint, proxyModel("opus-latest"), { type: "tool", name: "respond" }, undefined);

		expect(result.stopReason).toBe("error");
		expect(endpoint.kinds()).toStrictEqual(["forced", "auto"]);
	});

	it("does not retry a 400 that names no tool_choice", async () => {
		const endpoint = new FakeEndpoint(() => true, "The model does not support image input");

		const result = await runTurn(endpoint, proxyModel("opus-latest"), { type: "tool", name: "respond" }, undefined);

		expect(result.stopReason).toBe("error");
		expect(endpoint.bodies).toHaveLength(1);
	});

	it("does not retry a tool_choice 400 for a request that sent no forced choice", async () => {
		const endpoint = new FakeEndpoint(() => true, REJECTIONS[0]!.message);

		const result = await runTurn(endpoint, proxyModel("opus-latest"), "auto", undefined);

		expect(result.stopReason).toBe("error");
		expect(endpoint.kinds()).toStrictEqual(["auto"]);
	});

	it("does not retry a tool_choice rejection that arrives with a status other than 400", async () => {
		const endpoint = new FakeEndpoint(() => true, REJECTIONS[0]!.message, 422);

		const result = await runTurn(endpoint, proxyModel("opus-latest"), { type: "tool", name: "respond" }, undefined);

		expect(result.stopReason).toBe("error");
		expect(endpoint.kinds()).toStrictEqual(["forced"]);
	});
});

/**
 * BACKTEST: the recorded failure was an agent turn's `_resolve` pin to `claude-opus-5-5` on the
 * first-party endpoint, answered with the Claude rejection. The model comes from discovery, so the
 * bundled catalog never held it.
 */
describe("backtest: the recorded Opus 5.5 resolve pin", () => {
	it("sends auto on the first request, so the endpoint never answers with the 400", async () => {
		const endpoint = new FakeEndpoint(rejectsForced, REJECTIONS[0]!.message);
		const model = buildModel({
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});

		const result = await runTurn(endpoint, model, { type: "tool", name: "respond" }, undefined);

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(endpoint.kinds()).toStrictEqual(["auto"]);
	});
});
