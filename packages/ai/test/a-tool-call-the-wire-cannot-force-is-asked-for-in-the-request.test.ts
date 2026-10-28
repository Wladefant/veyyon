/**
 * WHY THIS SUITE EXISTS. A caller that requires a tool call (the completion bridge's
 * `respond`, an executor's `yield`, plan mode, a guided goal) sets `toolChoice`, and
 * every provider maps it onto its wire. Many wires cannot honor it: a thinking model
 * rejects a forced choice and the request is downgraded to `auto`, an API has no
 * tool-choice field at all (Ollama `/api/chat`, Cursor, Devin, GitLab Duo), or a
 * gateway overrides it (Claude on Antigravity runs in VALIDATED mode). The request
 * then went out asking for nothing, and the model answered in prose: Kimi K3 did
 * so on three of eight bridge prompts.
 *
 * THE CLASS IT CLOSES. Every request that requires a tool call either forces it on
 * the wire or carries an instruction to make it, never both and never neither. The
 * sweep is keyed by `KnownApi`, so a new API fails to compile until it records how
 * its payload states a forced call and which setups reach a wire that cannot force
 * one; the runtime check pins the table against `BUILTIN_API_IDS`.
 *
 * NOT CAUGHT. Whether a model obeys the instruction (a live property), and a host
 * that accepts a forced field and then ignores it, which no payload shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import { streamDevin } from "@veyyon/ai/providers/devin";
import { type GitLabDuoWorkflowWebSocketLike, streamGitLabDuoWorkflow } from "@veyyon/ai/providers/gitlab-duo-workflow";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@veyyon/ai/providers/google-vertex";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { mapOptionsForApi, streamSimple } from "@veyyon/ai/stream";
import type { Context, KnownApi, Message, Model, SimpleStreamOptions, Tool, ToolChoice } from "@veyyon/ai/types";
import { carryRequiredToolCall, openAIToolCallForce, type WireToolCallForce } from "@veyyon/ai/utils/tool-choice";
import { buildModel } from "@veyyon/catalog/build";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { emptyUsage, getBundledModel } from "@veyyon/catalog/models";
import * as piUtils from "@veyyon/utils";
import { type as arkType } from "arktype";
import { restoreEnv } from "../../utils/test/helpers/restore-global";
import { mockFetch, sseResponse } from "./helpers/fetch-mock";

const NAMED_INSTRUCTION = "This turn must call the `respond` tool.";
const ANY_INSTRUCTION = "This turn must call one of the available tools.";

const RESPOND: Tool = {
	name: "respond",
	description: "Return the structured answer.",
	parameters: arkType({ answer: "string" }),
};

const LOOKUP: Tool = {
	name: "lookup",
	description: "Look a term up.",
	parameters: arkType({ term: "string" }),
};

function requestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "What is the capital of Australia?", timestamp: 1 }],
		tools: [RESPOND, LOOKUP],
	};
}

// ---------------------------------------------------------------------------
// Capture harness: the case installs `cap` as `onPayload`, and the capture is
// the first payload `wanted` accepts. A stream that settles first fails the case.
// ---------------------------------------------------------------------------

interface Streamish {
	result(): Promise<unknown>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
}

type Start = (onPayload: (payload: unknown) => undefined, signal: AbortSignal) => Streamish;

/** Never reached once the capture aborts, and answers without the network if a flow outruns it. */
const STUB_FETCH = mockFetch(async () => new Response("", { status: 503 }));

async function capture(start: Start, wanted: (payload: unknown) => boolean = () => true): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	let settled = false;
	const stream = start(payload => {
		if (!settled && wanted(payload)) {
			settled = true;
			resolve(payload);
			controller.abort();
		}
		return undefined;
	}, controller.signal);
	stream.result().then(
		() => {
			if (!settled) {
				settled = true;
				reject(new Error("stream ended without the payload being captured"));
			}
		},
		(error: unknown) => {
			if (!settled) {
				settled = true;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		},
	);
	return promise;
}

/** The options `stream.ts` maps `toolChoice` to for `model`, plus the capture hook and a signal. */
function mapped<TApi extends KnownApi>(
	model: Model<TApi>,
	toolChoice: ToolChoice,
	onPayload: (payload: unknown) => undefined,
	signal: AbortSignal,
	extra: Pick<SimpleStreamOptions, "apiKey" | "fetch"> = {},
) {
	return mapOptionsForApi(model, { apiKey: "test-key", fetch: STUB_FETCH, ...extra, toolChoice, signal, onPayload });
}

// ---------------------------------------------------------------------------
// Payload readers: how much of a tool call a captured payload forces.
// ---------------------------------------------------------------------------

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const openAIForce = (payload: unknown): WireToolCallForce => openAIToolCallForce(field(payload, "tool_choice"));

function anthropicForce(payload: unknown): WireToolCallForce {
	const type = field(field(payload, "tool_choice"), "type");
	return type === "tool" ? "named" : type === "any" ? "any" : "open";
}

function bedrockForce(payload: unknown): WireToolCallForce {
	const choice = field(field(payload, "toolConfig"), "toolChoice");
	if (field(choice, "tool") !== undefined) return "named";
	return field(choice, "any") !== undefined ? "any" : "open";
}

function geminiForce(toolConfig: unknown): WireToolCallForce {
	const config = field(toolConfig, "functionCallingConfig");
	if (field(config, "mode") !== "ANY") return "open";
	const names = field(config, "allowedFunctionNames");
	return Array.isArray(names) && names.length > 0 ? "named" : "any";
}

const neverForces = (): WireToolCallForce => "open";

// ---------------------------------------------------------------------------
// The registry: every API, how its payload states a forced call, and the
// request setups that reach it, each marked by whether its wire forces.
// ---------------------------------------------------------------------------

interface Setup {
	readonly label: string;
	/** Whether this setup's wire can force a required call. */
	readonly forces: boolean;
	start(toolChoice: ToolChoice): Promise<unknown>;
}

interface ApiCase {
	readonly force: (payload: unknown) => WireToolCallForce;
	readonly setups: readonly Setup[];
}

function anthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function anthropicSetup(label: string, id: string, forces: boolean): Setup {
	const model = anthropicModel(id);
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamAnthropic(model, requestContext(), mapped(model, toolChoice, onPayload, signal)),
			),
	};
}

function bedrockSetup(label: string, id: string, forces: boolean): Setup {
	const model: Model<"bedrock-converse-stream"> = buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "bedrock",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamBedrock(
					model,
					requestContext(),
					mapped(model, toolChoice, onPayload, signal, {
						fetch: mockFetch(async () => new Response("", { status: 200 })),
					}),
				),
			),
	};
}

function completionsSetup(label: string, model: Model<"openai-completions">, forces: boolean): Setup {
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamOpenAICompletions(
					model,
					requestContext(),
					mapped(model, toolChoice, onPayload, signal, {
						fetch: mockFetch(async () => sseResponse(["[DONE]"])),
					}),
				),
			),
	};
}

function responsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

function responsesSetup(label: string, model: Model<"openai-responses">, forces: boolean): Setup {
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamOpenAIResponses(
					model,
					requestContext(),
					mapped(model, toolChoice, onPayload, signal, {
						fetch: mockFetch(async () => sseResponse(["[DONE]"])),
					}),
				),
			),
	};
}

function openrouterSetup(label: string, model: Model, forces: boolean): Setup {
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamSimple(model, requestContext(), {
					apiKey: "test-key",
					fetch: mockFetch(async () => sseResponse(["[DONE]"])),
					signal,
					toolChoice,
					onPayload,
				}),
			),
	};
}

function geminiCliSetup(label: string, provider: string, id: string, forces: boolean): Setup {
	const model: Model<"google-gemini-cli"> = buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	return {
		label,
		forces,
		start: toolChoice =>
			capture((onPayload, signal) =>
				streamGoogleGeminiCli(
					model,
					requestContext(),
					mapped(model, toolChoice, onPayload, signal, {
						apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
						fetch: mockFetch(async () => sseResponse([{ response: genaiChunk("hi") }])),
					}),
				),
			),
	};
}

/** A model whose compat says the host rejects a forced `tool_choice`, so the request downgrades it to `auto`. */
function rejectingForcedChoice<TApi extends KnownApi>(model: Model<TApi>): Model<TApi> {
	return { ...model, compat: { ...model.compat, supportsForcedToolChoice: false } };
}

const kimiK3 = getBundledModel("kimi-code", "k3") as Model<"openai-completions">;

const CASES: Record<KnownApi, ApiCase> = {
	"anthropic-messages": {
		force: anthropicForce,
		setups: [
			anthropicSetup("claude-sonnet-4-5", "claude-sonnet-4-5", true),
			anthropicSetup("claude-sonnet-5-5, which rejects a forced choice", "claude-sonnet-5-5", false),
		],
	},
	"bedrock-converse-stream": {
		force: bedrockForce,
		setups: [
			bedrockSetup("claude-sonnet-4-5", "anthropic.claude-sonnet-4-5-20250929-v1:0", true),
			bedrockSetup("claude-sonnet-5-5, which rejects a forced choice", "anthropic.claude-sonnet-5-5-v1:0", false),
		],
	},
	"openai-completions": {
		force: openAIForce,
		setups: [
			completionsSetup(
				"an OpenAI-compatible host",
				buildModel({
					id: "tool-choice-carry",
					name: "Tool choice carry",
					api: "openai-completions",
					provider: "openai",
					baseUrl: "https://tool-choice-carry.invalid/v1",
					reasoning: false,
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 16_384,
					maxTokens: 1_024,
				}),
				true,
			),
			completionsSetup("kimi-code k3, which rejects a forced choice", kimiK3, false),
		],
	},
	"openai-responses": {
		force: openAIForce,
		setups: [
			responsesSetup("gpt-5", responsesModel(), true),
			responsesSetup("a host that rejects a forced choice", rejectingForcedChoice(responsesModel()), false),
		],
	},
	openrouter: {
		force: openAIForce,
		setups: [
			openrouterSetup("anthropic/claude-sonnet-4", getBundledModel("openrouter", "anthropic/claude-sonnet-4"), true),
			openrouterSetup(
				"a routed model that rejects a forced choice",
				rejectingForcedChoice(getBundledModel("openrouter", "anthropic/claude-sonnet-4")),
				false,
			),
		],
	},
	"azure-openai-responses": {
		force: openAIForce,
		setups: [
			{
				label: "gpt-5-mini",
				forces: true,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const model: Model<"azure-openai-responses"> = buildModel({
							id: "gpt-5-mini",
							name: "GPT-5 Mini",
							api: "azure-openai-responses",
							provider: "azure",
							baseUrl: "https://example.openai.azure.com/openai/v1",
							reasoning: false,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 400_000,
							maxTokens: 128_000,
						});
						return streamAzureOpenAIResponses(model, requestContext(), {
							...mapped(model, toolChoice, onPayload, signal),
							azureBaseUrl: model.baseUrl,
							azureApiVersion: "v1",
						});
					}),
			},
		],
	},
	"openai-codex-responses": {
		force: openAIForce,
		setups: [
			{
				label: "gpt-5.3-codex-spark",
				forces: true,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const tempDir = piUtils.TempDir.createSync("@tool-choice-carry-codex-");
						piUtils.setAgentDir(tempDir.path());
						const token = `aaa.${Buffer.from(
							JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
							"utf8",
						).toBase64()}.bbb`;
						const model: Model<"openai-codex-responses"> = {
							...buildModel({
								id: "gpt-5.3-codex-spark",
								name: "GPT-5.3 Codex Spark",
								api: "openai-codex-responses",
								provider: "openai-codex",
								baseUrl: "https://chatgpt.com/backend-api",
								reasoning: true,
								input: ["text"],
								cost: ZERO_COST,
								contextWindow: 128_000,
								maxTokens: 128_000,
							}),
							preferWebsockets: false,
						};
						return streamOpenAICodexResponses(
							model,
							requestContext(),
							mapped(model, toolChoice, onPayload, signal, {
								apiKey: token,
								fetch: mockFetch(async () =>
									sseResponse([{ type: "response.output_text.delta", delta: "hi" }]),
								),
							}),
						);
					}),
			},
		],
	},
	"google-generative-ai": {
		force: payload => geminiForce(field(field(payload, "config"), "toolConfig")),
		setups: [
			{
				label: "gemini-3-flash",
				forces: true,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const model: Model<"google-generative-ai"> = buildModel({
							id: "gemini-3-flash",
							name: "Gemini 3 Flash",
							api: "google-generative-ai",
							provider: "google",
							baseUrl: "",
							reasoning: true,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 200_000,
							maxTokens: 32_000,
						});
						return streamGoogle(
							model,
							requestContext(),
							mapped(model, toolChoice, onPayload, signal, {
								fetch: mockFetch(async () => sseResponse([genaiChunk("hi")])),
							}),
						);
					}),
			},
		],
	},
	"google-vertex": {
		force: payload => geminiForce(field(field(payload, "config"), "toolConfig")),
		setups: [
			{
				label: "gemini-3-flash on Vertex",
				forces: true,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const model: Model<"google-vertex"> = buildModel({
							id: "gemini-3-flash",
							name: "Gemini 3 Flash (Vertex)",
							api: "google-vertex",
							provider: "google",
							baseUrl: "",
							reasoning: true,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 200_000,
							maxTokens: 32_000,
						});
						const fetchImpl = mockFetch(async input => {
							const url = input instanceof Request ? input.url : String(input);
							if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
								return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
							}
							return sseResponse([genaiChunk("hi")]);
						});
						return streamGoogleVertex(model, requestContext(), {
							...mapped(model, toolChoice, onPayload, signal, { fetch: fetchImpl }),
							project: "project",
							location: "location",
						});
					}),
			},
		],
	},
	"google-gemini-cli": {
		force: payload => geminiForce(field(field(payload, "request"), "toolConfig")),
		setups: [
			geminiCliSetup("gemini-2.5-flash", "google-gemini-cli", "gemini-2.5-flash", true),
			geminiCliSetup(
				"Claude on Antigravity, which runs in VALIDATED mode",
				"google-antigravity",
				"claude-sonnet-4-5",
				false,
			),
		],
	},
	"ollama-chat": {
		force: neverForces,
		setups: [
			{
				label: "/api/chat, which has no tool-choice field",
				forces: false,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const model: Model<"ollama-chat"> = buildModel({
							id: "qwen3",
							name: "Qwen3",
							api: "ollama-chat",
							provider: "ollama",
							baseUrl: "http://localhost:11434/v1",
							reasoning: false,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 4_096,
							maxTokens: 4_096,
						});
						return streamOllama(
							model,
							requestContext(),
							mapped(model, toolChoice, onPayload, signal, {
								fetch: mockFetch(
									async () =>
										new Response(
											`${JSON.stringify({ message: { role: "assistant", content: "hi" }, done: true, done_reason: "stop" })}\n`,
										),
								),
							}),
						);
					}),
			},
		],
	},
	"cursor-agent": {
		force: neverForces,
		setups: [
			{
				label: "a run request, which has no tool-choice field",
				forces: false,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const model: Model<"cursor-agent"> = buildModel({
							id: "tool-choice-carry",
							name: "Tool choice carry Cursor",
							api: "cursor-agent",
							provider: "cursor",
							// The hook fires before any connection; an unroutable loopback port fails fast.
							baseUrl: "http://127.0.0.1:9",
							reasoning: false,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 16_384,
							maxTokens: 1_024,
						});
						return streamCursor(model, requestContext(), mapped(model, toolChoice, onPayload, signal));
					}),
			},
		],
	},
	"devin-agent": {
		force: neverForces,
		setups: [
			{
				label: "a Cascade request, which is always sent auto",
				forces: false,
				start: toolChoice =>
					capture((onPayload, signal) => {
						const authResponse = toBinary(
							GetUserJwtResponseSchema,
							create(GetUserJwtResponseSchema, { userJwt: "jwt" }),
						);
						const emptyFrame = new Uint8Array(5);
						new DataView(emptyFrame.buffer).setUint32(1, 0, false);
						const model: Model<"devin-agent"> = buildModel({
							id: "tool-choice-carry",
							name: "Tool choice carry Devin",
							api: "devin-agent",
							provider: "devin",
							baseUrl: "https://server.codeium.com",
							reasoning: false,
							input: ["text"],
							cost: ZERO_COST,
							contextWindow: 16_384,
							maxTokens: 1_024,
						});
						return streamDevin(
							model,
							requestContext(),
							mapped(model, toolChoice, onPayload, signal, {
								fetch: mockFetch(async input =>
									String(input).includes("GetUserJwt") ? new Response(authResponse) : new Response(emptyFrame),
								),
							}),
						);
					}),
			},
		],
	},
	"gitlab-duo-agent": {
		force: neverForces,
		setups: [
			{
				label: "a workflow start, which has no tool-choice field",
				forces: false,
				start: toolChoice =>
					capture(
						(onPayload, signal) => {
							const model: Model<"gitlab-duo-agent"> = buildModel({
								id: "claude_sonnet_4_6_vertex",
								name: "Claude Sonnet 4.6 - Vertex",
								api: "gitlab-duo-agent",
								provider: "gitlab-duo-agent",
								baseUrl: "https://gitlab.example.com",
								reasoning: false,
								input: ["text"],
								cost: ZERO_COST,
								contextWindow: 128_000,
								maxTokens: 8_192,
								supportsTools: true,
							});
							const fetchImpl = mockFetch(async input => {
								const url = String(input);
								if (url.includes("/api/graphql")) {
									return new Response(
										JSON.stringify({
											data: {
												aiChatAvailableModels: {
													defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
													selectableModels: [],
													pinnedModel: null,
												},
											},
										}),
									);
								}
								if (url.includes("/direct_access")) {
									return new Response(
										JSON.stringify({
											duo_workflow_service: {
												base_url: "https://workflow.example.com",
												token: "wf-token",
												headers: {},
											},
											gitlab_rails: { token: "rails-token" },
										}),
									);
								}
								if (url.includes("/api/v4/ai/duo_workflows/workflows")) {
									return new Response(JSON.stringify({ id: "workflow-1" }));
								}
								return new Response("{}");
							});
							// The start frame goes through `onPayload` once the socket opens.
							const webSocketFactory = (): GitLabDuoWorkflowWebSocketLike => {
								const socket: GitLabDuoWorkflowWebSocketLike = {
									onopen: null,
									onmessage: null,
									onerror: null,
									onclose: null,
									send() {},
									close() {},
								};
								setTimeout(() => socket.onopen?.(new Event("open")), 0);
								return socket;
							};
							return streamGitLabDuoWorkflow(model, requestContext(), {
								...mapped(model, toolChoice, onPayload, signal, { fetch: fetchImpl }),
								rootNamespaceId: "gid://gitlab/Group/1",
								workflowDefinition: "chat",
								webSocketFactory,
								idleTimeoutMs: 1_000,
							});
						},
						payload => field(payload, "startRequest") !== undefined,
					),
			},
		],
	},
};

function occurrences(payload: unknown, text: string): number {
	return JSON.stringify(payload).split(text).length - 1;
}

const originalAgentDir = piUtils.getAgentDir();
const originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
const originalProfileEnv = process.env.VEYYON_PROFILE;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	piUtils.setAgentDir(originalAgentDir);
	restoreEnv("VEYYON_CODING_AGENT_DIR", originalAgentDirEnv);
	restoreEnv("VEYYON_PROFILE", originalProfileEnv);
	piUtils.__resetDirsFromEnvForTests();
	vi.restoreAllMocks();
});

describe("a tool call the wire cannot force is asked for in the request", () => {
	it("has a case for every built-in api", () => {
		expect(Object.keys(CASES).sort()).toEqual([...BUILTIN_API_IDS].sort());
	});

	for (const [api, kase] of Object.entries(CASES)) {
		for (const setup of kase.setups) {
			describe(`${api}: ${setup.label}`, () => {
				it("forces a named tool or asks for it, never both", async () => {
					const payload = await setup.start({ type: "tool", name: "respond" });
					expect(kase.force(payload)).toBe(setup.forces ? "named" : "open");
					expect(occurrences(payload, NAMED_INSTRUCTION)).toBe(setup.forces ? 0 : 1);
					expect(occurrences(payload, ANY_INSTRUCTION)).toBe(0);
				});

				it("forces some tool or asks for one, never both", async () => {
					const payload = await setup.start("any");
					expect(kase.force(payload)).toBe(setup.forces ? "any" : "open");
					expect(occurrences(payload, ANY_INSTRUCTION)).toBe(setup.forces ? 0 : 1);
					expect(occurrences(payload, NAMED_INSTRUCTION)).toBe(0);
				});

				it("asks for nothing when the named tool is not offered", async () => {
					const payload = await setup.start({ type: "tool", name: "absent" });
					expect(occurrences(payload, "This turn must call")).toBe(0);
				});

				it("asks for nothing when the call is optional", async () => {
					const payload = await setup.start("auto");
					expect(kase.force(payload)).toBe("open");
					expect(occurrences(payload, "This turn must call")).toBe(0);
				});
			});
		}
	}
});

describe("the instruction closes the last turn without opening a new one", () => {
	const ASK: ToolChoice = { type: "tool", name: "respond" };
	const NAMED_TEXT =
		"<system-reminder>\nThis turn must call the `respond` tool. Put your whole answer in that call; a reply in text alone is not accepted.\n</system-reminder>";

	function carried(messages: Message[]): Message[] {
		return carryRequiredToolCall({ messages, tools: [RESPOND] }, ASK, "open").messages;
	}

	it("appends to a plain user turn's text", () => {
		expect(carried([{ role: "user", content: "Answer.", timestamp: 1 }])).toEqual([
			{ role: "user", content: `Answer.\n\n${NAMED_TEXT}`, timestamp: 1 },
		]);
	});

	it("adds a text block to a user turn with content blocks", () => {
		expect(carried([{ role: "user", content: [{ type: "text", text: "Answer." }], timestamp: 1 }])).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Answer." },
					{ type: "text", text: NAMED_TEXT },
				],
				timestamp: 1,
			},
		]);
	});

	it("adds a text block to a closing tool result", () => {
		const result: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "lookup",
			content: [{ type: "text", text: "Canberra" }],
			isError: false,
			timestamp: 2,
		};
		expect(carried([result])).toEqual([
			{
				...result,
				content: [
					{ type: "text", text: "Canberra" },
					{ type: "text", text: NAMED_TEXT },
				],
			},
		]);
	});

	it("opens a user turn after an assistant turn", () => {
		const reply: Message = {
			role: "assistant",
			content: [{ type: "text", text: "Canberra." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 2,
		};
		const out = carried([reply]);
		expect(out.slice(0, 1)).toEqual([reply]);
		expect(out.slice(1).map(message => ({ role: message.role, content: message.content }))).toEqual([
			{ role: "user", content: NAMED_TEXT },
		]);
	});

	it("leaves the earlier turns untouched", () => {
		const first: Message = { role: "user", content: "Earlier.", timestamp: 1 };
		const out = carried([first, { role: "user", content: "Answer.", timestamp: 2 }]);
		expect(out[0]).toBe(first);
	});
});
