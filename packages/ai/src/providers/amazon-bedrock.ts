/**
 * Amazon Bedrock Converse Stream provider.
 *
 * Talks directly to `bedrock-runtime.{region}.amazonaws.com` over HTTPS with
 * SigV4 signing and decodes the `application/vnd.amazon.eventstream` response.
 * No `@aws-sdk/*`, no `@smithy/*`, no `proxy-agent`. Proxies are honored via
 * Bun's native `HTTPS_PROXY` support.
 *
 * A `models.yml` `baseUrl` is the request origin verbatim (VPC endpoint, gateway, …);
 * only AWS's own regional host is re-pointed at the resolved region. SigV4 unaffected.
 */

import type { Effort } from "@veyyon/catalog/effort";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "@veyyon/catalog/model-thinking";
import { calculateCost } from "@veyyon/catalog/models";
import { USER_AGENT } from "../images/format";
import { $env, $flag } from "@veyyon/utils/env";
import { parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { logger } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { AUTHENTICATED_API_KEY_SENTINEL } from "../provider-env-keys";
import { BEDROCK_CLAUDE_THINKING_BUDGETS, resolveThinkingBudget } from "../reasoning-budget";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
	VideoContent,
} from "../types";
import { normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { resolveAwsAmbientRegion } from "../utils/aws-profile";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import { notifyProviderResponse } from "../utils/provider-response";
import { toolWireSchema } from "../utils/schema/wire";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream, type EventStreamMessage } from "./aws-eventstream";
import { type AwsCredentials, signRequest } from "./aws-sigv4";
import { isThinkingPrefixBindingError } from "./anthropic";
import { isAnthropicNarrationSignature } from "./anthropic-signature";
import { parseAnthropicInputTransformations, THINKING_BINDING_CONTROLS_BETA } from "./anthropic-wire";
import { supportsBedrockPromptCaching } from "./bedrock-prompt-cache";
import { isBedrockRequestMetadataValue } from "./bedrock-request-metadata";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import { transformMessages } from "./transform-messages";
import { NON_VIDEO_MODEL_PLACEHOLDER } from "./vision-content";

/**
 * Headers SigV4 generates for itself. A caller cannot be allowed to supply these:
 * `signRequest` would sign the caller's value but return its own, so the signature
 * would not match what goes on the wire.
 */
const SIGNER_OWNED_HEADERS: Record<string, true> = {
	host: true,
	"x-amz-date": true,
	"x-amz-content-sha256": true,
	"x-amz-security-token": true,
};

/** Headers the Bedrock request sets itself; a caller copy in any casing duplicates them. */
// `content-length` included: the fetch layer recomputes it from the serialized
// body, so a caller value would be signed but not sent, and AWS rejects the
// mismatch.
const BEDROCK_RESERVED_HEADERS: Record<string, true> = {
	"content-type": true,
	accept: true,
	authorization: true,
	"content-length": true,
};

/**
 * HTTP status for a ConverseStream in-stream failure, keyed by lowercased
 * exception shape name. Exception and error frames ride inside an HTTP 200
 * event stream, so the shape name in `:exception-type` / `:error-code` is the
 * only evidence of what actually failed upstream. Values come from the
 * bedrock-runtime service model (the same source the AWS SDKs deserialize
 * against): without them every in-stream failure would be stamped 400, which
 * the retry classifier reads as a deterministic client rejection and refuses
 * to replay — making a transient `internalServerException` (500) terminal.
 * Shapes absent from the map keep 400 so an unrecognized rejection is never
 * retried by accident.
 */
const BEDROCK_STREAM_EXCEPTION_STATUS: Record<string, number> = {
	accessdeniedexception: 403,
	conflictexception: 400,
	internalserverexception: 500,
	modelerrorexception: 424,
	modelnotreadyexception: 429,
	modelstreamerrorexception: 424,
	modeltimeoutexception: 408,
	resourcenotfoundexception: 404,
	servicequotaexceededexception: 400,
	serviceunavailableexception: 503,
	throttlingexception: 429,
	validationexception: 400,
};

/**
 * Resolve the service-model status for an in-stream exception/error code.
 * Frame headers carry the bare shape name in either camelCase
 * (`internalServerException`) or PascalCase (`InternalServerException`); both
 * normalize to the same map key. Unknown shapes default to 400.
 */
export function bedrockStreamExceptionStatus(code: string): number {
	return BEDROCK_STREAM_EXCEPTION_STATUS[code.trim().toLowerCase()] ?? 400;
}

export type BedrockThinkingDisplay = "summarized" | "omitted";

/** Bedrock guardrail trace verbosity, mirrors the Converse `guardrailConfig.trace` values. */
export type BedrockGuardrailTrace = "enabled" | "disabled" | "enabled_full";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	/** Amazon Bedrock API key sent as `Authorization: Bearer`, ahead of SigV4 credential resolution. */
	bearerToken?: string;
	/**
	 * Amazon Bedrock Guardrail id or ARN. When set, the Converse request carries a
	 * `guardrailConfig` so accounts that gate `bedrock:InvokeModel*` on the
	 * `bedrock:GuardrailIdentifier` condition key stop returning an explicit deny.
	 */
	guardrailIdentifier?: string;
	/** Guardrail version to apply. Defaults to `"DRAFT"` when a guardrail is set. */
	guardrailVersion?: string;
	/** Guardrail trace verbosity. Left unset (Bedrock default) unless provided. */
	guardrailTrace?: BedrockGuardrailTrace;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: Effort;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude returns thinking content in Bedrock responses.
	 * - `"summarized"`: thinking blocks include human-readable summaries (default here).
	 * - `"omitted"`: thinking content is suppressed; the encrypted signature still
	 *   travels back for multi-turn continuity.
	 *
	 * Starting with Claude Opus 4.7 and Claude Fable/Mythos 5 the Anthropic API
	 * default is `"omitted"`, which leaves callers waiting on a silent stream during
	 * long reasoning runs (issue #1373). We default to `"summarized"` so adaptive-
	 * thinking models that accept the field keep producing visible thinking deltas.
	 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field, so
	 * we omit it for them.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/**
	 * Per-request Bedrock invocation-log tags. Merged over `model.requestMetadata`
	 * (per-call entries win on key collision). AWS caps the result at 16 entries;
	 * keys 1-256 chars, values 0-256 chars, both limited to
	 * `[a-zA-Z0-9\s:_@$#=/+,-.]`. Entries outside those limits are dropped.
	 */
	requestMetadata?: Record<string, string>;
}

function resolveBearerToken(options: BedrockOptions): string | undefined {
	const apiKey = options.apiKey === AUTHENTICATED_API_KEY_SENTINEL ? undefined : options.apiKey;
	return options.bearerToken || apiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}

function inferRegionFromBedrockArn(modelId: string): string | undefined {
	const parts = modelId.split(":", 6);
	if (parts[0] !== "arn" || parts[2] !== "bedrock") return undefined;
	const region = parts[3];
	return region || undefined;
}

/**
 * Default AWS region for each Bedrock cross-region inference-profile geo prefix.
 * A geo-prefixed profile (e.g. `eu.anthropic.claude-…`) is only servable from
 * regions in its own geo, so routing one to `us-east-1` yields HTTP 400 "The
 * provided model identifier is invalid." `global.` profiles are anchored in the
 * us regions and intentionally absent here (they resolve fine via `us-east-1`).
 */
const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

/**
 * AWS's own regional host, which every bundled catalog entry carries as a required
 * placeholder `baseUrl` — no routing info, so its region segment is re-derived.
 * FIPS, VPC-endpoint and gateway hosts don't match and are used as configured.
 */
const AWS_REGIONAL_BEDROCK_HOST = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

/** Geo prefix of a cross-region inference-profile id, e.g. `eu.anthropic.…` → `eu`. */
function inferenceProfileGeo(modelId: string): string | undefined {
	const dot = modelId.indexOf(".");
	if (dot <= 0) return undefined;
	const prefix = modelId.slice(0, dot);
	return prefix in INFERENCE_PROFILE_GEO_DEFAULT_REGION ? prefix : undefined;
}

/**
 * Whether a concrete AWS region can serve a given inference-profile geo. The
 * `ap-` regions overlap across `apac`/`au`/`jp` profiles, so the Australia and
 * Japan geos pin their specific source regions rather than matching all `ap-*`.
 */
function regionServesGeo(region: string, geo: string): boolean {
	switch (geo) {
		case "us-gov":
			return region.startsWith("us-gov-");
		case "us":
			return region.startsWith("us-") && !region.startsWith("us-gov-");
		case "eu":
			return region.startsWith("eu-");
		case "apac":
			return region.startsWith("ap-");
		case "au":
			return region === "ap-southeast-2" || region === "ap-southeast-4";
		case "jp":
			return region === "ap-northeast-1" || region === "ap-northeast-3";
		default:
			return false;
	}
}

/**
 * Resolve the Bedrock runtime region for a request. An explicit per-request
 * region and an ARN-embedded model region win outright. Otherwise, for a
 * geo-prefixed cross-region inference profile (`us.`/`eu.`/`apac.`/`au.`/`jp.`/
 * `us-gov.`), an ambient region (`AWS_REGION` / `AWS_DEFAULT_REGION`) is honored
 * only when it can serve the profile's geo. If the ambient region is absent or
 * mismatched, a same-geo guardrail ARN region is used when available; otherwise
 * the geo default is used. `global.` profiles have no geo entry, so the ambient
 * region (or, when absent, a guardrail ARN's region or `us-east-1`) is used
 * unchanged.
 */
function resolveBedrockRegion(modelId: string, options: BedrockOptions): string {
	const explicit = options.region || inferRegionFromBedrockArn(modelId);
	if (explicit) return explicit;
	const ambient = resolveAwsAmbientRegion(options.profile);
	const guardrailRegion = inferRegionFromBedrockArn(options.guardrailIdentifier ?? "");
	const geo = inferenceProfileGeo(modelId);
	if (geo) {
		if (ambient && regionServesGeo(ambient, geo)) return ambient;
		if (guardrailRegion && regionServesGeo(guardrailRegion, geo)) return guardrailRegion;
		return INFERENCE_PROFILE_GEO_DEFAULT_REGION[geo];
	}
	return ambient || guardrailRegion || "us-east-1";
}

type Block = (TextContent | ThinkingContent | ToolCall) & {
	[kStreamingBlockIndex]?: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
};

// ---------- Bedrock wire-format types ----------
// Mirrors only what we actually consume from `ConverseStreamRequest` /
// `ConverseStreamOutput`. Keeps us decoupled from `@aws-sdk/client-bedrock-runtime`.

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "5m" | "1h" };
}
interface TextBlockWire {
	text: string;
}
interface ImageBlockWire {
	image: { format: "jpeg" | "png" | "gif" | "webp"; source: { bytes: string } };
}
interface ToolUseBlockWire {
	toolUse: { toolUseId: string; name: string; input: unknown };
}
interface ToolResultBlockWire {
	toolResult: {
		toolUseId: string;
		content: Array<TextBlockWire | ImageBlockWire>;
		status: "success" | "error";
	};
}
interface ReasoningBlockWire {
	reasoningContent: { reasoningText: { text: string; signature?: string } };
}

type UserContent = TextBlockWire | ImageBlockWire | ToolResultBlockWire | CachePoint;
type AssistantContent = TextBlockWire | ToolUseBlockWire | ReasoningBlockWire;
type SystemContent = TextBlockWire | CachePoint;

interface WireMessage {
	role: "user" | "assistant";
	content: Array<UserContent | AssistantContent>;
}

interface WireToolSpec {
	toolSpec: { name: string; description?: string; inputSchema: { json: unknown } };
}
interface WireToolChoice {
	auto?: Record<string, never>;
	any?: Record<string, never>;
	tool?: { name: string };
}
interface WireToolConfig {
	tools: WireToolSpec[];
	toolChoice?: WireToolChoice;
}

/**
 * Bedrock validates that requests carrying any `toolUse`/`toolResult` history
 * include a `toolConfig`. For no-tool ephemeral turns (`/btw`, IRC auto-replies)
 * we have nothing real to send, so we inject this placeholder. Its presence is
 * tracked by a per-request flag — never the wire name — so callers who happen
 * to register a real tool literally called `__no_tools__` are not affected.
 */
const NO_TOOLS_SENTINEL_NAME = "__no_tools__";

const NO_TOOLS_SENTINEL: WireToolSpec = {
	toolSpec: {
		name: NO_TOOLS_SENTINEL_NAME,
		description: "Placeholder required by Bedrock validation. Do not call; answer with text.",
		inputSchema: { json: { type: "object", properties: {} } },
	},
};

interface BedrockToolPlan {
	toolConfig: WireToolConfig | undefined;
	sentinelInjected: boolean;
}

interface WireGuardrailConfig {
	guardrailIdentifier: string;
	guardrailVersion: string;
	trace?: BedrockGuardrailTrace;
}

interface ConverseStreamRequest {
	messages: WireMessage[];
	system?: SystemContent[];
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: WireToolConfig;
	guardrailConfig?: WireGuardrailConfig;
	additionalModelRequestFields?: Record<string, unknown>;
	requestMetadata?: Record<string, string>;
	additionalModelResponseFieldPaths?: string[];
}

// Streaming events (snake_case matches the JSON envelope key, but Bedrock uses camelCase).
interface MessageStartEvent {
	role: "user" | "assistant";
}
interface ContentBlockStartEvent {
	contentBlockIndex: number;
	start?: { toolUse?: { toolUseId?: string; name?: string } };
}
interface ContentBlockDeltaEvent {
	contentBlockIndex: number;
	delta?: {
		text?: string;
		toolUse?: { input?: string };
		reasoningContent?: { text?: string; signature?: string };
	};
}
interface ContentBlockStopEvent {
	contentBlockIndex: number;
}
interface MessageStopEvent {
	stopReason?: string;
	additionalModelResponseFields?: unknown;
}
interface MetadataEvent {
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
		totalTokens?: number;
	};
}

const REQUEST_METADATA_MAX_ENTRIES = 16;

/**
 * Bedrock rejects the whole invocation on a malformed `requestMetadata` entry.
 * Attribution tags must never cost a turn, so invalid and excess entries are
 * dropped with a warning instead of failing the request. Returns `undefined`
 * for an empty result so the field is omitted from the body entirely.
 */
function sanitizeRequestMetadata(raw: unknown): Record<string, string> | undefined {
	if (!isRecord(raw)) return undefined;
	const out: Record<string, string> = {};
	const dropped: string[] = [];
	let kept = 0;
	for (const [key, value] of Object.entries(raw)) {
		if (
			typeof value !== "string" ||
			key.length < 1 ||
			!isBedrockRequestMetadataValue(key) ||
			!isBedrockRequestMetadataValue(value) ||
			kept >= REQUEST_METADATA_MAX_ENTRIES
		) {
			dropped.push(key);
			continue;
		}
		out[key] = value;
		kept++;
	}
	if (dropped.length > 0) logger.warn("Bedrock requestMetadata entries dropped", { keys: dropped });
	return kept > 0 ? out : undefined;
}

/** One Converse Stream turn: its signed request, its event stream and the assistant message they build. */
class BedrockTurn {
	readonly stream = new AssistantMessageEventStream();
	readonly #model: Model<"bedrock-converse-stream">;
	readonly #context: Context;
	readonly #options: BedrockOptions;
	readonly #startTime = performance.now();
	readonly #output: AssistantMessage;
	readonly #blocks: Block[];
	readonly #region: string;
	#firstTokenTime: number | undefined;
	#rawRequestDump: RawHttpRequestDump | undefined;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	#wireBodyJson: string | undefined;
	/** The built Converse request; replaced in place when a bound-thinking retry strips reasoning. */
	#request: ConverseStreamRequest | undefined;
	#bearerToken: string | undefined;
	#sentinelInjected = false;
	#prefixBindingRetryAttempted = false;
	#sawMessageStop = false;
	#responseHookFailed = false;
	#responseHookError: unknown;

	constructor(model: Model<"bedrock-converse-stream">, context: Context, options: BedrockOptions) {
		this.#model = model;
		this.#context = context;
		this.#options = options;
		this.#output = createInitialResponsesAssistantMessage("bedrock-converse-stream" as Api, model.provider, model.id);
		this.#blocks = this.#output.content as Block[];
		this.#region = resolveBedrockRegion(model.id, options);
	}

	async run(): Promise<void> {
		try {
			const body = await this.#open();
			for await (const frame of decodeEventStream(body)) this.#onFrame(frame);
			this.#finish();
		} catch (error) {
			await this.#fail(error);
		}
	}

	async #open(): Promise<ReadableStream<Uint8Array>> {
		let response = await this.#send();
		if (!response.ok) {
			const refusal = await this.#refusal(response);
			if (
				this.#prefixBindingRetryAttempted ||
				this.#options.anthropicPrefixMismatchBehavior === "error" ||
				!isThinkingPrefixBindingError(refusal.message)
			) {
				throw refusal;
			}
			this.#retryWithoutBoundThinking();
			response = await this.#send();
			if (!response.ok) throw await this.#refusal(response);
		}
		if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);
		return response.body;
	}

	#retryWithoutBoundThinking(): void {
		this.#prefixBindingRetryAttempted = true;
		logger.warn("bedrock: thinking prefix changed, stripping bound thinking and retrying", {
			provider: this.#model.provider,
			model: this.#model.id,
			baseUrl: this.#model.baseUrl,
		});
		const request = this.#request;
		if (request) this.#request = { ...request, messages: dropBedrockReasoningContent(request.messages) };
	}

	async #send(): Promise<Response> {
		const options = this.#options;
		// `baseUrl` is the origin verbatim, path prefix (and query, for gateways
		// that authenticate via a query parameter) included, so a gateway mounted
		// under a path works. AWS's own host is re-pointed: the catalog can't know the region.
		const base = new URL(this.#model.baseUrl || `https://bedrock-runtime.${this.#region}.amazonaws.com`);
		if (AWS_REGIONAL_BEDROCK_HOST.test(base.host)) base.host = `bedrock-runtime.${this.#region}.amazonaws.com`;
		const host = base.host;
		const path = `${base.pathname.replace(/\/+$/, "")}/model/${encodeURIComponent(this.#model.id)}/converse-stream`;
		const query = base.search.slice(1) || undefined;
		const url = `${base.origin}${path}${base.search}`;
		// Bun's native fetch ceiling is disabled below (`timeout: false`) so
		// configurable watchdogs govern slow-prefill streams (issue #2422).
		// Direct callers that bypass `register-builtins` (which installs the
		// iterator-level first-event watchdog) still need a pre-response
		// timer, otherwise a Bedrock/proxy that accepts the POST and never
		// sends headers would hang forever.
		const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
		// Clear the pre-response timer the instant headers arrive (below): an
		// absolute `AbortSignal.timeout` would keep aborting the actively
		// streaming body, not just a stalled time-to-first-byte (issue #2422).
		const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
		const prepareInit = () => this.#prepareRequest(url, host, path, query);
		try {
			// Preserve the provider's payload-capture contract for an
			// already-aborted call without creating a physical attempt.
			if (watchdog.signal?.aborted) await prepareInit();
			const response = await fetchProviderWithRetry(url, {
				method: "POST",
				signal: watchdog.signal,
				fetch: this.#observedFetch(),
				timeout: false,
				prepareInit,
				maxDelayMs: options?.maxRetryDelayMs,
			});
			if (this.#responseHookFailed) throw this.#responseHookError;
			return response;
		} finally {
			watchdog.clear();
		}
	}

	/** The transport fetch, reporting each attempt's response to the caller's response hook. */
	#observedFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
		const transportFetch = this.#options.fetch ?? globalThis.fetch.bind(globalThis);
		return async (input, init) => {
			const attemptResponse = await transportFetch(input, init);
			try {
				await notifyProviderResponse(
					this.#options,
					attemptResponse,
					this.#model,
					attemptResponse.headers.get("x-amzn-requestid") ?? attemptResponse.headers.get("x-request-id"),
				);
			} catch (error) {
				// A response hook is part of the request contract, not a transport
				// failure. Return a non-retryable sentinel so fetchWithRetry cannot
				// multiply the callback failure into more physical attempts.
				this.#responseHookFailed = true;
				this.#responseHookError = error;
				return new Response(null, { status: 400 });
			}
			return attemptResponse;
		};
	}

	async #prepareRequest(url: string, host: string, path: string, query: string | undefined): Promise<RequestInit> {
		const credentials = await this.#resolveCredentials();
		const request = (this.#request ??= await this.#buildRequest());
		this.#rawRequestDump = {
			provider: this.#model.provider,
			api: this.#output.api,
			model: this.#model.id,
			method: "POST",
			url,
		};
		// Retain the exact sent BYTES, not the parsed object: a dump body is
		// read only on the 400/413 path.
		this.#wireBodyJson = JSON.stringify(request);
		const body = new TextEncoder().encode(this.#wireBodyJson);
		const headers = this.#requestHeaders();
		if (!credentials) {
			return { headers: { ...headers, Authorization: `Bearer ${this.#bearerToken}` }, body };
		}
		const signed = await signRequest({
			method: "POST",
			host,
			path,
			query,
			body,
			region: this.#region,
			service: "bedrock",
			credentials,
			headers,
		});
		return { headers: { ...headers, ...signed }, body };
	}

	/**
	 * Caller headers merged BEFORE signing, so SigV4 covers them and they reach the
	 * wire. `model.headers` first, `options.headers` second: `StreamOptions.headers`
	 * is merged ON TOP of model-defined headers. Signer-owned and request-owned names
	 * are dropped in any casing: a caller `Host` or `Content-Type` beside the fixed
	 * value would leave two keys that fetch joins into one wire header SigV4 never signed.
	 */
	#requestHeaders(): Record<string, string> {
		const callerHeaders: Record<string, string> = {};
		for (const source of [this.#model.headers, this.#options.headers]) {
			for (const [name, value] of Object.entries(source ?? {})) {
				const field = name.toLowerCase();
				if (SIGNER_OWNED_HEADERS[field] || BEDROCK_RESERVED_HEADERS[field]) continue;
				callerHeaders[field] = value;
			}
		}
		// SigV4 never signs `user-agent` (UNSIGNABLE in aws-sigv4.ts), so this default
		// cannot break the signature. Without it Bun's fetch sends `Bun/<version>`.
		callerHeaders["user-agent"] ??= USER_AGENT;
		return {
			...callerHeaders,
			"content-type": "application/json",
			accept: "application/vnd.amazon.eventstream",
		};
	}

	/** SigV4 credentials, or undefined when a bearer token authenticates the request instead. */
	async #resolveCredentials(): Promise<AwsCredentials | undefined> {
		this.#bearerToken = resolveBearerToken(this.#options);
		if (this.#bearerToken) return undefined;
		if ($flag("AWS_BEDROCK_SKIP_AUTH")) {
			return { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
		}
		return resolveAwsCredentials({
			profile: this.#options.profile,
			region: this.#region,
			signal: this.#options.signal,
			fetch: this.#options.fetch,
		});
	}

	async #buildRequest(): Promise<ConverseStreamRequest> {
		const model = this.#model;
		const context = this.#context;
		const options = this.#options;
		const cacheRetention = resolveCacheRetention(options.cacheRetention);
		const messages = convertMessages(context, model, cacheRetention);
		const { toolConfig: rawToolConfig, sentinelInjected } = planToolConfig(context.tools, options.toolChoice, messages);
		this.#sentinelInjected = sentinelInjected;
		let toolConfig = rawToolConfig;
		let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);
		const thinking = additionalModelRequestFields?.thinking;
		const thinkingDisabled = isRecord(thinking) && thinking.type === "disabled";
		const prefixMismatchBehavior =
			!thinkingDisabled && model.thinking?.prefixBinding && model.compat.supportsThinkingBindingControls
				? (options.anthropicPrefixMismatchBehavior ?? "drop_block")
				: undefined;

		// Some models (Opus/Sonnet 5.5) reject forced tool use outright; keep the
		// tools offered under `auto` and leave thinking intact.
		const forcedChoice = toolConfig?.toolChoice?.any || toolConfig?.toolChoice?.tool;
		if (toolConfig && forcedChoice && !model.compat.supportsForcedToolChoice) {
			toolConfig = { ...toolConfig, toolChoice: { auto: {} } };
		} else if (toolConfig && forcedChoice && !thinkingDisabled) {
			// Bedrock rejects thinking + forced tool_choice. Prefix-bound lines (Fable)
			// think adaptively even when no thinking field is sent, so downgrade their
			// forced choice regardless of the binding controls; elsewhere drop thinking.
			if (model.thinking?.prefixBinding) toolConfig = { ...toolConfig, toolChoice: { auto: {} } };
			else additionalModelRequestFields = undefined;
		}
		if (prefixMismatchBehavior) {
			additionalModelRequestFields = applyBedrockThinkingBinding(additionalModelRequestFields, prefixMismatchBehavior);
		}

		const request: ConverseStreamRequest = {
			messages,
			system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
			inferenceConfig: {
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				topP: options.topP,
			},
			toolConfig,
			guardrailConfig: buildGuardrailConfig(options),
			additionalModelRequestFields,
			requestMetadata:
				model.requestMetadata || options.requestMetadata
					? { ...model.requestMetadata, ...options.requestMetadata }
					: undefined,
			...(prefixMismatchBehavior ? { additionalModelResponseFieldPaths: ["/input_transformations"] } : {}),
		};
		const replacement = await options.onPayload?.(request, model);
		const final = replacement === undefined ? request : (replacement as ConverseStreamRequest);
		// After the hook so extension-injected tags are validated too, and before the
		// raw dump so the inspector shows exactly what was sent.
		return { ...final, requestMetadata: sanitizeRequestMetadata(final.requestMetadata) };
	}

	/** The error a non-2xx response stands for. A 401 or 403 also drops cached SigV4 credentials. */
	async #refusal(response: Response): Promise<AIError.BedrockApiError> {
		if (!this.#bearerToken && (response.status === 401 || response.status === 403)) {
			// Stale cached credentials (e.g. rotated session keys in ~/.aws/credentials) —
			// drop the cache entry so the next attempt re-resolves from scratch.
			invalidateAwsCredentialCache({ profile: this.#options.profile, region: this.#region });
		}
		// The STATUS is the failure; the body is Bedrock's explanation of it. Losing an unreadable body still
		// leaves the status, which is what the error below is built from. The shared reader replaces a local
		// 1000-character slice, so the read is bounded too and truncation says so.
		const detail = await AIError.readProviderErrorDetail(response);
		return new AIError.BedrockApiError(`Bedrock HTTP ${response.status}: ${detail}`, response.status, {
			headers: response.headers,
		});
	}

	#onFrame(frame: EventStreamMessage): void {
		const error = frameError(frame);
		if (error) throw error;
		if (frame.headers[":message-type"] !== "event") return;
		const payload = safeParsePayload(frame.payload);
		if (payload) this.#onEvent(frame.headers[":event-type"], payload);
	}

	#onEvent(eventType: string | undefined, payload: unknown): void {
		switch (eventType) {
			case "messageStart":
				if ((payload as MessageStartEvent).role !== "assistant") {
					throw new AIError.BedrockApiError(
						"Unexpected assistant message start but got user message start instead",
						0,
					);
				}
				this.stream.push({ type: "start", partial: this.#output });
				break;
			case "contentBlockStart":
				this.#firstTokenTime ??= performance.now();
				this.#onContentBlockStart(payload as ContentBlockStartEvent);
				break;
			case "contentBlockDelta":
				this.#firstTokenTime ??= performance.now();
				this.#onContentBlockDelta(payload as ContentBlockDeltaEvent);
				break;
			case "contentBlockStop":
				this.#onContentBlockStop(payload as ContentBlockStopEvent);
				break;
			case "messageStop":
				this.#onMessageStop(payload as MessageStopEvent);
				break;
			case "metadata":
				this.#onMetadata(payload as MetadataEvent);
				break;
			// Unknown event types (Bedrock may add new ones) are ignored.
		}
	}

	/** Appends a block to the message and announces it; returns its position. */
	#openBlock(block: Block, type: "text_start" | "thinking_start" | "toolcall_start"): number {
		this.#output.content.push(block);
		const position = this.#blocks.length - 1;
		this.stream.push({ type, contentIndex: position, partial: this.#output });
		return position;
	}

	#onContentBlockStart(event: ContentBlockStartEvent): void {
		const toolUse = event.start?.toolUse;
		// Drop the sentinel call only when we injected it ourselves. A caller that
		// registers a real tool named `__no_tools__` would otherwise lose its
		// legitimate tool-use events on normal turns.
		if (!toolUse || (this.#sentinelInjected && toolUse.name === NO_TOOLS_SENTINEL_NAME)) return;
		this.#openBlock(
			{
				type: "toolCall",
				id: normalizeToolCallId(toolUse.toolUseId || ""),
				name: toolUse.name || "",
				arguments: {},
				[kStreamingPartialJson]: "",
				[kStreamingBlockIndex]: event.contentBlockIndex,
			},
			"toolcall_start",
		);
	}

	#onContentBlockDelta(event: ContentBlockDeltaEvent): void {
		const { contentBlockIndex, delta } = event;
		const position = this.#blocks.findIndex(b => b[kStreamingBlockIndex] === contentBlockIndex);
		const block = this.#blocks[position];
		if (delta?.text !== undefined) {
			// `contentBlockStart` is not sent for text blocks, so the first delta opens one.
			const textPosition = block
				? position
				: this.#openBlock({ type: "text", text: "", [kStreamingBlockIndex]: contentBlockIndex }, "text_start");
			this.#appendText(textPosition, delta.text);
		} else if (delta?.toolUse && block?.type === "toolCall") {
			this.#appendToolInput(block, position, delta.toolUse.input || "");
		} else if (delta?.reasoningContent) {
			const thinkingPosition = block
				? position
				: this.#openBlock(
						{ type: "thinking", thinking: "", thinkingSignature: "", [kStreamingBlockIndex]: contentBlockIndex },
						"thinking_start",
					);
			this.#appendReasoning(thinkingPosition, delta.reasoningContent);
		}
	}

	#appendText(position: number, text: string): void {
		const block = this.#blocks[position];
		if (block.type !== "text") return;
		block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: position, delta: text, partial: this.#output });
	}

	#appendToolInput(block: Extract<Block, { type: "toolCall" }>, position: number, input: string): void {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] || "") + input;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		this.stream.push({ type: "toolcall_delta", contentIndex: position, delta: input, partial: this.#output });
	}

	#appendReasoning(position: number, reasoning: { text?: string; signature?: string }): void {
		const block = this.#blocks[position];
		if (block.type !== "thinking") return;
		if (reasoning.text) {
			block.thinking += reasoning.text;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: position,
				delta: reasoning.text,
				partial: this.#output,
			});
		}
		if (reasoning.signature) block.thinkingSignature = (block.thinkingSignature || "") + reasoning.signature;
	}

	#onContentBlockStop(event: ContentBlockStopEvent): void {
		const position = this.#blocks.findIndex(b => b[kStreamingBlockIndex] === event.contentBlockIndex);
		const block = this.#blocks[position];
		const { stream } = this;
		const output = this.#output;
		switch (block?.type) {
			case "text":
				stream.push({ type: "text_end", contentIndex: position, content: block.text, partial: output });
				break;
			case "thinking":
				// Claude on Bedrock carries Anthropic's signature format, narration kind included.
				if (block.thinkingSignature && isAnthropicNarrationSignature(block.thinkingSignature)) block.narration = true;
				stream.push({ type: "thinking_end", contentIndex: position, content: block.thinking, partial: output });
				break;
			case "toolCall":
				block.arguments = parseToolCallArguments(block[kStreamingPartialJson]);
				clearStreamingPartialJson(block);
				stream.push({ type: "toolcall_end", contentIndex: position, toolCall: block, partial: output });
				break;
		}
	}

	#onMetadata(event: MetadataEvent): void {
		const usage = event.usage;
		if (!usage) return;
		const total = this.#output.usage;
		total.input = usage.inputTokens || 0;
		total.output = usage.outputTokens || 0;
		total.cacheRead = usage.cacheReadInputTokens || 0;
		total.cacheWrite = usage.cacheWriteInputTokens || 0;
		total.totalTokens = usage.totalTokens || total.input + total.output;
		calculateCost(this.#model, total);
	}

	#onMessageStop(event: MessageStopEvent): void {
		this.#sawMessageStop = true;
		const output = this.#output;
		this.#recordInputTransformations(isRecord(event.additionalModelResponseFields) ? event.additionalModelResponseFields : undefined);
		// A sentinel-only request must never surface a tool-use stop:
		// no real tool exists for the agent to dispatch.
		output.stopReason =
			this.#sentinelInjected && event.stopReason === "tool_use" ? "stop" : mapStopReason(event.stopReason);
		if (output.stopReason === "error") {
			// A guardrail block ends the turn with `guardrail_intervened` and often no
			// content — surface it explicitly so it never reads as an empty completion.
			output.errorMessage =
				event.stopReason === "guardrail_intervened"
					? `Response blocked by Amazon Bedrock guardrail (stop reason: ${event.stopReason}).`
					: event.stopReason === "content_filtered"
						? `Response filtered by Amazon Bedrock content filters (stop reason: ${event.stopReason}).`
						: AIError.providerFinishErrorMessage(event.stopReason);
		}
	}

	/** Records the response's input transformations; a dropped thinking block is logged, not silent. */
	#recordInputTransformations(responseFields: Record<string, unknown> | undefined): void {
		const transformations = parseAnthropicInputTransformations(responseFields?.input_transformations);
		if (transformations.length === 0) return;
		this.#output.inputTransformations = transformations;
		for (const transformation of transformations) {
			if (transformation.reason !== "prefix_binding_mismatch") continue;
			logger.warn("bedrock: dropped thinking block after conversation prefix changed", {
				model: this.#model.id,
				path: transformation.path,
			});
		}
	}

	#finish(): void {
		if (this.#options.signal?.aborted) throw new AIError.RequestAbortError();
		const output = this.#output;
		if (!this.#sawMessageStop) output.stopReason = this.#terminallessStopReason();
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			throw new AIError.BedrockApiError(output.errorMessage ?? "An unknown error occurred", 0);
		}
		this.#stampTiming();
		this.stream.push({ type: "done", reason: output.stopReason, message: output });
		this.stream.end();
	}

	/**
	 * The stop reason of an event stream that ended without a `messageStop`.
	 *
	 * Nothing in the response said the turn was over, so `output.stopReason` is
	 * still the optimistic seed it was given before the first byte arrived, and
	 * pushing `done` with it reported an empty body as a finished answer. The
	 * shared rule decides what the accumulated content can stand as; a tool batch
	 * counts only when every call parsed, which on this dialect means every one of
	 * them reached `contentBlockStop`.
	 */
	#terminallessStopReason(): StopReason {
		const toolBatchIsComplete = this.#blocks.every(
			block => block.type !== "toolCall" || getStreamingPartialJson(block) === undefined,
		);
		const stopReason = stopReasonForTerminallessEof(this.#output.content, toolBatchIsComplete);
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"Bedrock event stream ended without a messageStop (connection dropped or response truncated)",
				{ provider: this.#model.provider, kind: "incomplete-stream" },
			);
		}
		return stopReason;
	}

	#stampTiming(): void {
		this.#output.duration = performance.now() - this.#startTime;
		if (this.#firstTokenTime) this.#output.ttft = this.#firstTokenTime - this.#startTime;
	}

	async #fail(error: unknown): Promise<void> {
		const output = this.#output;
		for (const block of output.content) {
			if (block.type === "toolCall") clearStreamingPartialJson(block);
		}
		const diagnostics = thinkingDiagnostics(error, this.#context.messages);
		const result = await AIError.finalize(error, {
			api: this.#model.api,
			signal: this.#options.signal,
			rawRequestDump: materializeDumpBody(this.#rawRequestDump, this.#wireBodyJson),
		});
		AIError.applyFinalizeResult(output, result, result.message + diagnostics);
		this.#stampTiming();
		this.stream.push({ type: "error", reason: output.stopReason, error: output });
		this.stream.end();
	}
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const turn = new BedrockTurn(model, context, options);
	void turn.run();
	return turn.stream;
};

/** Shared across events: every payload decode is a complete, non-streaming call. */
const PAYLOAD_DECODER = new TextDecoder();

/** The error an `exception` or `error` frame reports, or undefined for any other frame. */
function frameError(frame: EventStreamMessage): AIError.BedrockApiError | undefined {
	switch (frame.headers[":message-type"]) {
		case "exception": {
			const exceptionType = frame.headers[":exception-type"] || "Exception";
			const payload = safeParsePayload(frame.payload) as { message?: string } | undefined;
			const message = payload?.message || PAYLOAD_DECODER.decode(frame.payload);
			return new AIError.BedrockApiError(`${exceptionType}: ${message}`, bedrockStreamExceptionStatus(exceptionType), {
				code: exceptionType,
			});
		}
		case "error": {
			const code = frame.headers[":error-code"] || "UnknownError";
			const message = frame.headers[":error-message"] || PAYLOAD_DECODER.decode(frame.payload);
			return new AIError.BedrockApiError(`${code}: ${message}`, bedrockStreamExceptionStatus(code), { code });
		}
		default:
			return undefined;
	}
}

/** Each replayed thinking block's signature and text length, appended to a signature or thinking refusal. */
function thinkingDiagnostics(error: unknown, messages: readonly Message[]): string {
	const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
	if (!baseMessage.includes("signature") && !baseMessage.includes("thinking")) return "";
	const thinkingBlocks = messages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.flatMap((m, mi) =>
			m.content
				.filter(b => b.type === "thinking")
				.map((b, bi) => ({
					msg: mi,
					block: bi,
					stop: m.stopReason,
					sigLen: b.thinkingSignature?.length ?? -1,
					thinkLen: b.thinking.length,
				})),
		);
	return thinkingBlocks.length > 0 ? `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}` : "";
}

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		return JSON.parse(PAYLOAD_DECODER.decode(payload));
	} catch {
		// Undefined is DISTINCT from the `{}` an empty payload returns, and the caller relies on that: an
		// unparseable event frame is skipped rather than treated as an empty event, so a malformed frame
		// cannot look like a legitimate no-op in the stream.
		return undefined;
	}
}

/**
 * Serialize the system blocks, anchoring the stable prefix separately from the
 * volatile tail.
 *
 * A single trailing `cachePoint` caches a prefix that ENDS at the last system
 * block, so any edit to a later block invalidates the whole system prompt and
 * the next turn re-reads and re-writes all of it. That is the normal shape
 * here: the first block is the harness shared across parent and agent
 * prompts, and project context, the assignment and the handle table are
 * appended after it and change constantly. The Anthropic provider anchors its
 * own first block for exactly this reason (`applyPromptCaching`); Bedrock did
 * not, so the two transports disagreed about the same conversation.
 *
 * This is AWS's own guidance, not an invention: the Bedrock prompt-caching
 * page says to use multiple cache checkpoints "if you are caching sections
 * that change at different frequencies", which is exactly a fixed harness
 * followed by a handle table that changes every turn.
 *
 * Budget: Claude allows four cache checkpoints per request. This spends two on
 * system (the anchor plus the trailing block) and `convertMessages` spends one
 * on the last message, so three of four, leaving one unspent. Adding the
 * anchor cannot break a request: per the same page, "if you try to add a cache
 * checkpoint before meeting the minimum number of tokens, your inference will
 * still succeed, but your prefix will not be cached", so a stable prefix under
 * the model's floor (1024 tokens on Sonnet 4.6, 4096 on the 4.5 generation)
 * costs an unused slot and nothing else. Both checkpoints carry the same ttl,
 * which keeps the documented ordering rule (longer TTLs must precede shorter
 * ones) satisfied by construction.
 *
 * There is no Claude Code billing layout on this path: Bedrock authenticates
 * with AWS credentials and this function injects no blocks of its own, so
 * index 0 is always the caller's first prompt, and the anchor index needs none
 * of the offsetting the Anthropic path does.
 */
function buildSystemPrompt(
	systemPrompt: readonly string[] | string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContent[] | undefined {
	const prompts = normalizeSystemPrompts(systemPrompt);
	if (prompts.length === 0) return undefined;
	if (cacheRetention === "none" || !supportsBedrockPromptCaching(model)) {
		return prompts.map(prompt => ({ text: prompt }));
	}

	const cachePoint: SystemContent = {
		cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
	};
	const blocks: SystemContent[] = [];
	for (let index = 0; index < prompts.length; index++) {
		blocks.push({ text: prompts[index] });
		// A single-block system prompt needs no anchor: the trailing checkpoint
		// below already ends at that same block, and a duplicate would spend a
		// slot to cache a prefix that is cached anyway.
		if (index === 0 && prompts.length > 1) blocks.push(cachePoint);
	}
	blocks.push(cachePoint);
	return blocks;
}

function buildToolResultBlock(
	message: ToolResultMessage,
	model: Model<"bedrock-converse-stream">,
	hoistedImages: ImageBlockWire[],
): ToolResultBlockWire {
	const content: Array<TextBlockWire | ImageBlockWire> = [];
	// Bedrock's Anthropic Claude models reject an error toolResult that carries a
	// non-text block ("all content must be type `text` if `is_error` is true"),
	// so images inside an error result must always be hoisted out regardless of
	// the model's requiresToolResultImageHoisting flag (no `class "anthropic"`
	// rule sets it). Mirrors anthropic.ts buildToolResultBlock. Re-serializing a
	// previously-persisted poisoned result on a later turn repairs it in place.
	const hoistImages = message.isError || model.compat.requiresToolResultImageHoisting;
	for (const block of message.content) {
		if (block.type === "image") {
			const image: ImageBlockWire = { image: createImageBlock(block.mimeType, block.data) };
			if (hoistImages) {
				content.push({ text: "(see attached image)" });
				hoistedImages.push(image);
			} else {
				content.push(image);
			}
		} else if (block.type === "video") {
			content.push({ text: NON_VIDEO_MODEL_PLACEHOLDER });
		} else {
			content.push({ text: block.text.toWellFormed() });
		}
	}
	return {
		toolResult: {
			toolUseId: normalizeToolCallId(message.toolCallId),
			content,
			status: message.isError ? "error" : "success",
		},
	};
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): WireMessage[] {
	const result: WireMessage[] = [];
	const messages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") {
			const converted = convertMessage(message, model.id);
			if (converted) result.push(converted);
			continue;
		}
		// Collect all consecutive toolResult messages into a single user message —
		// Bedrock requires all tool results to be in one message.
		const hoistedImages: ImageBlockWire[] = [];
		const toolResults: UserContent[] = [buildToolResultBlock(message, model, hoistedImages)];
		let next = messages[i + 1];
		while (next?.role === "toolResult") {
			toolResults.push(buildToolResultBlock(next, model, hoistedImages));
			i++;
			next = messages[i + 1];
		}
		toolResults.push(...hoistedImages);
		result.push({ role: "user", content: toolResults });
	}

	// Add cache point to the last user message for supported Claude models
	const lastMessage = result.at(-1);
	if (cacheRetention !== "none" && supportsBedrockPromptCaching(model) && lastMessage?.role === "user") {
		(lastMessage.content as UserContent[]).push({
			cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
		});
	}

	return result;
}

/**
 * A user, developer or assistant message on the wire, or undefined when nothing
 * in it survives: Bedrock rejects a message with an empty content array, which
 * is what an aborted request or a whitespace-only prompt leaves behind.
 */
function convertMessage(message: Exclude<Message, ToolResultMessage>, modelId: string): WireMessage | undefined {
	switch (message.role) {
		case "developer":
		case "user":
			return convertUserMessage(message.content);
		case "assistant":
			return convertAssistantMessage(message.content, modelId);
		default:
			throw new AIError.ValidationError("Unknown message role");
	}
}

function convertUserMessage(content: UserMessage["content"]): WireMessage | undefined {
	if (typeof content === "string") {
		return content.trim() === "" ? undefined : { role: "user", content: [{ text: content.toWellFormed() }] };
	}
	const blocks: UserContent[] = [];
	for (const block of content) {
		const converted = convertUserBlock(block);
		if (converted) blocks.push(converted);
	}
	return blocks.length > 0 ? { role: "user", content: blocks } : undefined;
}

function convertAssistantMessage(content: AssistantMessage["content"], modelId: string): WireMessage | undefined {
	const blocks: AssistantContent[] = [];
	for (const block of content) {
		const converted = convertAssistantBlock(block, modelId);
		if (converted) blocks.push(converted);
	}
	return blocks.length > 0 ? { role: "assistant", content: blocks } : undefined;
}

/** A user content block on the wire, or undefined for blank text. */
function convertUserBlock(block: TextContent | ImageContent | VideoContent): UserContent | undefined {
	switch (block.type) {
		case "text": {
			const text = block.text.toWellFormed();
			return text.trim().length === 0 ? undefined : { text };
		}
		case "image":
			return { image: createImageBlock(block.mimeType, block.data) };
		case "video":
			return { text: NON_VIDEO_MODEL_PLACEHOLDER };
		default:
			throw new AIError.ValidationError("Unknown user content type");
	}
}

/** An assistant content block on the wire, or undefined for blank text or blank thinking. */
function convertAssistantBlock(
	block: AssistantMessage["content"][number],
	modelId: string,
): AssistantContent | undefined {
	switch (block.type) {
		case "text":
			return block.text.trim().length === 0 ? undefined : { text: block.text.toWellFormed() };
		case "toolCall":
			return { toolUse: { toolUseId: normalizeToolCallId(block.id), name: block.name, input: block.arguments } };
		case "thinking": {
			// Hidden thinking has empty display text but a load-bearing signature.
			if (block.thinking.trim().length === 0 && !block.thinkingSignature) return undefined;
			// A captured signature is authoritative even when the model id is an opaque ARN:
			// only a model that itself streamed a signature (Claude) can have one, so replay
			// it as signed reasoningContent regardless of how the id is spelled.
			if (block.thinkingSignature) {
				return {
					reasoningContent: {
						reasoningText: { text: block.thinking.toWellFormed(), signature: block.thinkingSignature },
					},
				};
			}
			// No signature was captured. Do NOT fall back to unsigned reasoningContent here:
			// a model streaming reasoningContent does not imply it accepts reasoningContent
			// echoed back in a request. Amazon Nova streams unsigned reasoning just fine but
			// rejects it on replay with HTTP 400 "User messages cannot contain reasoning
			// content. Please remove the reasoning content and try again.", which wedges the
			// agent loop on every turn after the first. Demote to plain text instead — the
			// content survives, just no longer typed as a reasoning block.
			return { text: renderDemotedThinking(modelId, block.thinking) };
		}
		default:
			throw new AIError.ValidationError("Unknown assistant content type");
	}
}

/** The reasoning blocks a bound-thinking retry strips; a message left empty is dropped. */
function dropBedrockReasoningContent(messages: WireMessage[]): WireMessage[] {
	const filtered: WireMessage[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			filtered.push(message);
			continue;
		}
		const content = message.content.filter(block => !("reasoningContent" in block));
		if (content.length > 0) filtered.push({ ...message, content });
	}
	return filtered;
}

function messagesHaveToolBlocks(messages: WireMessage[]): boolean {
	for (const message of messages) {
		for (const block of message.content) {
			if ("toolUse" in block || "toolResult" in block) return true;
		}
	}
	return false;
}

function convertToolSpec(tool: Tool): WireToolSpec {
	return {
		toolSpec: {
			name: tool.name,
			// Descriptions may be pruned into the system prompt. Bedrock permits
			// omission, but rejects an explicitly empty description (minLength: 1).
			description: tool.description || undefined,
			inputSchema: { json: toolWireSchema(tool) },
		},
	};
}

function planToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	messages: WireMessage[],
): BedrockToolPlan {
	const activeTools = tools ?? [];
	const hasTools = activeTools.length > 0;
	const historyHasToolBlocks = messagesHaveToolBlocks(messages);

	if (toolChoice === "none") {
		if (!historyHasToolBlocks) return { toolConfig: undefined, sentinelInjected: false };
		if (!hasTools) {
			return {
				toolConfig: { tools: [NO_TOOLS_SENTINEL], toolChoice: { auto: {} } },
				sentinelInjected: true,
			};
		}
		return { toolConfig: { tools: activeTools.map(convertToolSpec) }, sentinelInjected: false };
	}

	if (!hasTools) return { toolConfig: undefined, sentinelInjected: false };

	const bedrockTools = activeTools.map(convertToolSpec);
	let bedrockToolChoice: WireToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { toolConfig: { tools: bedrockTools, toolChoice: bedrockToolChoice }, sentinelInjected: false };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

/**
 * Build the Converse `guardrailConfig` block when a guardrail identifier is set.
 * The version defaults to `"DRAFT"` (Bedrock's editable working draft) and the
 * trace is passed through untouched — leaving it undefined keeps Bedrock's own
 * default rather than forcing a value.
 */
function buildGuardrailConfig(options: BedrockOptions): WireGuardrailConfig | undefined {
	if (!options.guardrailIdentifier) return undefined;
	return {
		guardrailIdentifier: options.guardrailIdentifier,
		guardrailVersion: options.guardrailVersion ?? "DRAFT",
		...(options.guardrailTrace === undefined ? {} : { trace: options.guardrailTrace }),
	};
}

/**
 * Sets the thinking block's prefix-mismatch behavior and the beta flag that
 * enables it. Existing fields and betas are kept; the beta is added once.
 */
function applyBedrockThinkingBinding(
	fields: Record<string, unknown> | undefined,
	behavior: "drop_block" | "error",
): Record<string, unknown> {
	const result = { ...fields };
	const thinking: Record<string, unknown> = isRecord(result.thinking) ? { ...result.thinking } : { type: "adaptive" };
	thinking.block_binding = { prefix_mismatch_behavior: behavior };
	result.thinking = thinking;
	const betas = Array.isArray(result.anthropic_beta)
		? result.anthropic_beta.filter((beta): beta is string => typeof beta === "string")
		: [];
	if (!betas.includes(THINKING_BINDING_CONTROLS_BETA)) {
		betas.push(THINKING_BINDING_CONTROLS_BETA);
	}
	result.anthropic_beta = betas;
	return result;
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	const reasoning = options.reasoning;
	if (!model.reasoning) return undefined;
	if (!reasoning) {
		if (model.compat.disabledThinking === "disabled") {
			return { thinking: { type: "disabled" }, output_config: { effort: "low" } };
		}
		return undefined;
	}

	const mode = model.thinking?.mode;
	if (mode === "anthropic-adaptive") {
		const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
		// Starting with Claude Opus 4.7 and Claude Fable/Mythos 5, Anthropic switched
		// the adaptive-thinking default to "omitted", which silently suppresses
		// streamed reasoning and can read as a stalled stream during long reasoning
		// runs (issue #1373). Opt back into "summarized" by default on models that
		// accept the field.
		const adaptive: { type: "adaptive"; display?: BedrockThinkingDisplay } = { type: "adaptive" };
		if (model.thinking?.supportsDisplay) {
			adaptive.display = options.thinkingDisplay ?? "summarized";
		}
		return {
			thinking: adaptive,
			output_config: { effort },
		};
	}

	if (mode === "effort") {
		// OpenAI-schema models on Bedrock (the GPT-5.x SKUs) reject the
		// Anthropic budget block with `unknown_parameter: 'thinking'` and take
		// `reasoning.effort` instead — same effort vocabulary the catalog
		// already bakes (low/medium/high/xhigh/max).
		const level = requireSupportedEffort(model, reasoning);
		return { reasoning: { effort: model.thinking?.effortMap?.[level] ?? level } };
	}

	const level = requireSupportedEffort(model, reasoning);
	const budget = resolveThinkingBudget(level, BEDROCK_CLAUDE_THINKING_BUDGETS, options.thinkingBudgets);

	const result: Record<string, unknown> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			display: options.thinkingDisplay ?? "summarized",
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

/**
 * Bedrock's wire format expects the image as `{ source: { bytes: <base64-string> }, format }`.
 * The caller already passes base64-encoded data, so no decode/re-encode round-trip is needed.
 */
function createImageBlock(mimeType: string, data: string): ImageBlockWire["image"] {
	let format: "jpeg" | "png" | "gif" | "webp";
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = "jpeg";
			break;
		case "image/png":
			format = "png";
			break;
		case "image/gif":
			format = "gif";
			break;
		case "image/webp":
			format = "webp";
			break;
		default:
			throw new AIError.ValidationError(`Unknown image type: ${mimeType}`);
	}
	return { source: { bytes: data }, format };
}
