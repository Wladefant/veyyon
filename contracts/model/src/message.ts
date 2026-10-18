import type { AssistantTurnMetrics, AssistantTurnRequest, ToolCallMetrics } from "./instrumentation";
import type { ServiceTier } from "./service-tier";
import type { Api, Provider, Usage } from "./model";
import type { kStreamingPartialJson } from "./stream-block";

export type MessageAttribution = "user" | "agent";

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string };

export type CacheRetention = "none" | "short" | "long";

/**
 * What to do when a request's prompt-cache markers demonstrably did not take
 * effect. Declared here beside {@link CacheRetention} rather than in
 * `cache/policy.ts`, which needs `CacheRetention` from this module and would
 * otherwise form an import cycle with it.
 */
export type CacheEnforcement = "off" | "warn" | "error";

export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
};

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
	/**
	 * `true`: `thinking` is a provider-written summary of the model's reasoning
	 * (OpenAI Responses `summary_text`, Gemini thought summaries). `false`: the
	 * wire delivered it as the reasoning itself, not marked as a summary
	 * (chat-completions reasoning fields, Responses `reasoning_text`, Devin
	 * `thinking`); whether that is the full trace is vouched for per family by
	 * the catalog's `portable-reasoning`. Unset when provenance is unknown,
	 * including turns recorded before parsers set it. Only `false` blocks
	 * replay natively on another host.
	 */
	summary?: boolean;
	/**
	 * `true`: the block is narration — prose the model addressed to the user
	 * between tool calls, which the provider returned as a signed thinking block
	 * (Anthropic connector-text summarization). It stays a thinking block for
	 * replay; user-facing surfaces present it as answer text.
	 */
	narration?: boolean;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

/**
 * Anthropic server-side-fallback boundary marker persisted on assistant
 * turns whose provider request opted into
 * `AnthropicOptions.fallbacks`. Consumers other than the Anthropic
 * provider MUST ignore it — `transformMessages` strips the block on any
 * cross-provider hop and on non-official Anthropic replays, so downstream
 * converters never see it.
 */
export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}
/**
 * Verbatim Anthropic web-search or tool-search call/result retained for
 * same-provider history replay. Other providers discard it in
 * `transformMessages`.
 */
export interface AnthropicServerToolContent {
	type: "anthropicServerTool";
	block:
		| {
				type: "server_tool_use";
				id: string;
				name: "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25";
				input?: Record<string, unknown> | null;
				[key: string]: unknown;
		  }
		| {
				type: "web_search_tool_result" | "tool_search_tool_result";
				tool_use_id: string;
				content: unknown;
				[key: string]: unknown;
		  };
}

/** Provider-native uploaded file reference for image reuse without retransmitting bytes. */
export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (required for snapcompact frames, whose glyphs do not survive the
	 * default `auto` downscale). Providers without a detail knob ignore it.
	 */
	detail?: "auto" | "low" | "high" | "original";
	/** Provider-native file reference preferred only by its matching provider. */
	providerFile?: ProviderFileReference;
	/**
	 * Optional https mirror of `data`, served by a caller-run blob server.
	 * Providers whose API fetches remote images send this URL instead of the
	 * base64 payload; every other provider ignores it. `data` remains the
	 * source of truth — the URL must serve exactly those bytes, and callers
	 * are responsible for keeping it stable across turns (prefix caches hash
	 * the URL string, and Anthropic silently forgets images when a resent
	 * turn differs byte-wise).
	 */
	url?: string;
}
export type ComputerAction =
	| {
			type: "click";
			button: "left" | "right" | "wheel" | "back" | "forward";
			x: number;
			y: number;
			keys?: string[] | null;
	  }
	| { type: "double_click"; x: number; y: number; keys: string[] | null }
	| { type: "drag"; path: Array<{ x: number; y: number }>; keys?: string[] | null }
	| { type: "keypress"; keys: string[] }
	| { type: "move"; x: number; y: number; keys?: string[] | null }
	| { type: "screenshot" }
	| { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number; keys?: string[] | null }
	| { type: "type"; text: string }
	| { type: "wait" };

export interface ComputerSafetyCheck {
	id: string;
	code?: string | null;
	message?: string | null;
}

export interface ComputerToolCallMetadata {
	type: "computer";
	providerItemId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}

export type ToolCallProviderMetadata = ComputerToolCallMetadata;

export type ComputerScreenshotRef =
	| { type: "computer_screenshot"; image_url: string; file_id?: never }
	| { type: "computer_screenshot"; file_id: string; image_url?: never };

export interface ComputerToolResultMetadata {
	type: "computer";
	screenshot: ComputerScreenshotRef;
	acknowledgedSafetyChecks: ComputerSafetyCheck[];
}

export type ToolResultProviderMetadata = ComputerToolResultMetadata;

/**
 * A video clip sent inline with a user message. Only a model whose
 * `Model.input` includes `"video"` receives it; a provider serialises it in
 * its own inline-media form (Gemini `inlineData`, OpenAI-compatible
 * `video_url` data URL) and omits it with a placeholder elsewhere.
 */
export interface VideoContent {
	type: "video";
	data: string; // base64 encoded video data
	mimeType: string; // e.g., "video/mp4", "video/webm", "video/quicktime"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Readonly<Record<string, unknown>>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
	/** Provider-native metadata required to execute and faithfully replay this call. */
	providerMetadata?: ToolCallProviderMetadata;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

/** Anthropic `output_config.effort` level. */
export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** One `tool_addition`/`tool_removal` block of an Anthropic mid-conversation system message. */
export interface AnthropicToolChange {
	type: "tool_addition" | "tool_removal";
	name: string;
}

/** Anthropic-only controls attached to a mid-conversation system message. */
export interface AnthropicMessagePayload {
	type: "anthropicMessage";
	clearAt?: "never" | "next_user_message";
	effort?: AnthropicOutputEffort;
	toolChanges?: AnthropicToolChange[];
}

/**
 * Controls an Anthropic request declared, recorded on its response so later
 * requests over the same transcript replay a byte-identical prefix.
 * Written by the Anthropic provider; read by it and by the Agent's inactive-tool lookup.
 */
export interface AnthropicRequestControls {
	/**
	 * `context.messages.length` of the request that produced this response, i.e. the
	 * response's own index. A record found at another index belongs to a history that was
	 * rewritten before it (compaction, dropped messages) and is not replayed as controls.
	 */
	messageIndex: number;
	/** Present when the request kept a stable tool declaration (`supportsMidConversationToolChanges`). Source tool names, not wire names. */
	tools?: {
		/** Top-level `tools` in wire order. */
		declared: string[];
		/** Subset of `declared` sent with `defer_loading: true`. */
		deferred: string[];
		/** Tools active at the end of the request, in `context.tools` order. */
		active: string[];
	};
	/** Present when the request kept a stable effort (`supportsPerMessageEffort`); `null` = API default. */
	effort?: { topLevel: AnthropicOutputEffort | null; tail: AnthropicOutputEffort | null };
}

/**
 * Anthropic on-demand compaction summary (`compact-2026-09-04` beta).
 *
 * Produced by the Anthropic provider on the assistant message of a request
 * that streamed a `compaction` content block, and attached to the user-role
 * compaction summary message that replaces the compacted history so the
 * provider can replay the block verbatim: the API drops every block that
 * precedes it. `content` is the plain-text summary, so every other provider
 * reads the message text and ignores the payload.
 */
export interface AnthropicCompactionPayload {
	type: "anthropicCompaction";
	/** Provider that produced the summary; only that provider replays it natively. */
	provider: string;
	content: string;
	/** Signature of an on-demand block; replayed verbatim. */
	signature?: string;
	/** Legacy threshold block state (`compact-2026-01-12`); replay-only. */
	encryptedContent?: string;
	/**
	 * Harness-appended file metadata (`<files>` section) kept out of the
	 * byte-identical block. The converter replaces the summary message with the
	 * block and skips its text, so it replays this as a user message after the
	 * block's retained tail: before the first message created after the summary.
	 */
	filesText?: string;
	/**
	 * File metadata of earlier summaries whose replay position lies inside this
	 * summary's retained tail. Retained messages must reach the API unchanged,
	 * so each keeps replaying where it did: before the first message created
	 * after `after` (the earlier summary's commit time).
	 */
	retainedFiles?: AnthropicCompactionFiles[];
	/**
	 * Set on summaries whose retained tail replays unchanged: file metadata
	 * after the tail, earlier metadata at `retainedFiles`. Summaries persisted
	 * without it keep their original layout (metadata after the first retained
	 * turn), since later thinking was signed against those bytes.
	 */
	exactTail?: true;
}

/** File metadata replayed at a fixed point of a natively compacted conversation. */
export interface AnthropicCompactionFiles {
	text: string;
	/** Replays before the first message created after this time (ms). */
	after: number;
}

/**
 * Records Cursor's server wrote into the client's conversation store for one
 * assistant turn: the `rootPromptMessagesJson` entries after the user's message,
 * reasoning signatures and redacted reasoning included. Written and read by the
 * Cursor provider, which sends them back unchanged to the wire model that produced them.
 */
export interface CursorHistoryPayload {
	type: "cursorHistory";
	/** Wire route the records were written under, as sent (requested model, details id, max mode, parameters). */
	wireRoute: string;
	/** Digest of the turn's opening user message, content and paired tool results when recorded; a rewritten turn rebuilds instead. */
	digest: string;
	/** Record bytes (UTF-8 JSON) in conversation order; each blob id is the SHA-256 of its bytes. */
	records: string[];
}

export type ProviderPayload =
	| OpenAIResponsesHistoryPayload
	| AnthropicMessagePayload
	| AnthropicCompactionPayload
	| CursorHistoryPayload;

/** Provider-reported rewrite applied to request content before inference. */
export interface ProviderInputTransformation {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
}

/**
 * Marks a user or developer message whose body is prior-turn reasoning demoted
 * to prose — a thinking run the source model was still streaming when the turn
 * ended, so it has no signature and cannot ride on the assistant message.
 * `transformMessages` applies the replay policy it applies to an unsigned
 * thinking block from that source: a signing Anthropic endpoint drops the
 * message on same-model replay (which would otherwise reject it as unsigned
 * thinking with `Refusal (reasoning_extraction)`), and any
 * `anthropic-messages` target drops it once `replayDemotedPriorReasoning`
 * returns false.
 *
 * A summarization transcript (`serializeConversation` in `@veyyon/agent-core`)
 * leaves the message out the way it leaves thinking blocks out. `provider` and
 * `model` identify the turn the reasoning came from; a message that no longer
 * knows its origin sets neither and only the endpoint-level drop applies.
 */
export interface DemotedReasoningSource {
	provider?: string;
	model?: string;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent | VideoContent)[];
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** True when the provider delivered this steer into the response it was streaming (`response.steer`). Display-only; never sent. */
	liveSteered?: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	/**
	 * When this message REPLACED earlier history (a compaction or branch
	 * summary), in ms since epoch. Preserved-thinking models bind each thinking
	 * block's signature to the exact bytes of everything before it, so an
	 * assistant turn recorded at or before a rewrite carries reasoning minted
	 * against a prefix that no longer exists: `transformMessages` drops those
	 * blocks rather than let the API reject the request or drop them silently.
	 */
	historyRewriteAt?: number;
	/** See {@link DemotedReasoningSource}. */
	demotedReasoningSource?: DemotedReasoningSource;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent | VideoContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** True if the message was injected by the system (e.g., auto-continue) and initiates a fresh run rather than continuing the current one. */
	synthetic?: boolean;
	/** True when the synthetic prompt was a deliberate operator action (`.`, `c` continue shortcut) rather than an automatic continuation — its timestamp is the turn's prompt time. */
	userInitiated?: boolean;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	/** See {@link UserMessage.historyRewriteAt}. */
	historyRewriteAt?: number;
	/** See {@link DemotedReasoningSource}. */
	demotedReasoningSource?: DemotedReasoningSource;
	timestamp: number; // Unix timestamp in milliseconds
}

export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

/** Persisted presentation state for an assistant error superseded by an automatic retry saga. */
export type AssistantRetryRecovery =
	| {
			kind: "auto-retry";
			status: "recovered";
			attempt: number;
			recoveredAt: string;
			recovery: AssistantRetryRecoveryKind;
			note: string;
			supersededBy?: {
				timestamp: number;
				responseId?: string;
				provider: string;
				model: string;
			};
	  }
	| {
			kind: "auto-retry";
			status: "superseded";
			attempt: number;
			recovery: AssistantRetryRecoveryKind;
			note: string;
	  };

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	/**
	 * Estimated tool-schema tokens included in `nonMessageTokens` (0 when the
	 * model defers schemas server-side). Lets a later model whose schema policy
	 * differs rebase the provider anchor instead of inheriting its schemas.
	 */
	toolSchemaTokens?: number;
	/** Estimated prompt tokens removed by local history rewrites after this provider snapshot was recorded. */
	historyRewriteTokensRemoved?: number;
	/**
	 * Compaction epoch current when this snapshot's provider request was recorded.
	 * A later compaction bumps the session epoch, so an anchor whose epoch is
	 * older than the current in-flight snapshot describes pre-compaction history
	 * and must not override the rebased estimate.
	 */
	compactionEpoch?: number;
	/** Estimated stored conversation messages included in the request. Rich session telemetry only. */
	storedMessagesTokens?: number;
	/** Estimated not-yet-stored request tail included alongside the stored conversation. Rich telemetry only. */
	tailTokens?: number;
	/** Whether the prompt total came from provider usage or a local preflight estimate. */
	promptTokensSource?: "provider" | "estimate";
	nonMessageTokensEstimated?: boolean;
	storedMessagesTokensEstimated?: boolean;
	tailTokensEstimated?: boolean;
	/** Latest compaction entry governing this request, when recorded at ultra detail. */
	compactionEntryId?: string;
	lastMessageTimestamp?: number;
}

/**
 * Identity of a tool call whose arguments never finished streaming.
 *
 * Both fields arrive with the provider's tool-call block header, before any
 * argument delta, so they are complete even when the arguments are not.
 */
export interface IncompleteToolCall {
	id: string;
	name: string;
}

/**
 * One bucket of a provider-reported context composition. See
 * {@link AssistantMessage.providerContextComposition}.
 */
export interface ProviderContextBucket {
	/** Stable provider identifier to branch on (`"tools"`, `"rules"`, `"skills"`, ...). */
	key: string;
	/** The provider's own display string for the bucket. */
	label: string;
	tokens: number;
	/** Characters the provider measured, or 0 when it reports tokens only. */
	chars: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (
		| TextContent
		| ThinkingContent
		| RedactedThinkingContent
		| AnthropicFallbackContent
		| AnthropicServerToolContent
		| ImageContent
		| ToolCall
	)[];
	api: Api;
	provider: Provider;
	model: string;
	/** Stored credential row that produced this turn; absent for external or unknown keys. */
	credentialId?: number;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	/**
	 * Concrete model that produced this turn when it is knowable independently
	 * of the requested id: reported by a router that selected one, or recovered
	 * from a signed thinking block (Anthropic signatures name the serving
	 * model). Compared against `model` to notice a gateway serving something
	 * other than what was requested.
	 */
	upstreamModel?: string;
	/**
	 * Service tier the provider reported serving this turn, when the API echoes
	 * one (`response.service_tier`), falling back to the tier the request carried
	 * when the response omits the echo. Absent when the provider reports no tier
	 * or the echo cannot be trusted (proxies). This is the tier the turn actually
	 * ran on, which is what cost, premium-request, and speed accounting key on —
	 * the session's live setting may already have changed.
	 */
	serviceTier?: ServiceTier;
	/**
	 * Context window the PROVIDER reported for this conversation on the wire.
	 *
	 * Most APIs never say: the window is static model metadata and the catalog
	 * carries it. A few agent gateways report it per turn alongside the tokens
	 * used, and for those the catalog entry is a guess — a model the gateway
	 * added after the catalog was generated falls back to a default window that
	 * has nothing to do with the real one. Divide the gateway's own used-token
	 * count by that default and the context gauge pins at empty on a
	 * conversation the gateway considers barely started, which is what Cursor's
	 * `ConversationTokenDetails` did (`max_tokens` was on the wire every turn
	 * and thrown away while `used_tokens` was believed).
	 *
	 * Set it only from a value the provider actually sent. Undefined means the
	 * provider said nothing, NOT that the catalog window is wrong.
	 */
	providerContextWindow?: number;
	/**
	 * How the PROVIDER says its own reported context is composed, when it says.
	 *
	 * Only a gateway that assembles the prompt for us can measure this: it knows
	 * what the tool schemas, the rules and the skills actually cost after its own
	 * serialization, where we can only estimate them from what we sent. Cursor
	 * reports it per turn and the buckets sum to its `used_tokens` exactly, which
	 * is what makes it worth carrying: one real sample puts tool definitions at
	 * 8,326 of 14,483 tokens, and no local estimate would have found that.
	 *
	 * Undefined means the provider said nothing. An empty bucket the provider did
	 * measure is present with `tokens: 0`, so an absent key is "not measured"
	 * rather than "nothing there".
	 */
	providerContextComposition?: ProviderContextBucket[];
	usage: Usage;
	/**
	 * Visible output tokens a history rewrite (shake) has since removed from
	 * `content`. `usage.output` still counts them, so a replay estimate subtracts
	 * them to keep the turn's reasoning without recharging the removed text.
	 */
	elidedOutputTokens?: number;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Stable recovery-classification text when errorMessage includes display-only diagnostics. */
	errorClassificationMessage?: string;
	/** True only when an exact request-body-read timeout failed on a full Responses replay, not a previous-response delta. */
	requestBodyReadTimeoutFullReplay?: boolean;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/**
	 * Tool calls the model began emitting whose arguments were still streaming
	 * when the turn was cut off (a provider stream reset or an abort). Their
	 * `toolCall` blocks are removed from {@link content}, because incomplete
	 * arguments are unsafe to run and an unpaired `tool_use` block breaks the
	 * provider's tool_use/tool_result pairing on replay. The identity survives
	 * here so the harness can still tell the model the call was attempted and
	 * never ran: without it the call vanishes with no trace anywhere, and the
	 * model reads the turn as if it had never asked for that tool.
	 *
	 * Populated only on `error`/`aborted` turns that dropped at least one block.
	 */
	incompleteToolCalls?: IncompleteToolCall[];
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-reported input rewrites such as dropped bound-thinking blocks. */
	inputTransformations?: ProviderInputTransformation[];
	/**
	 * Controls an Anthropic request declared, recorded on its response so later
	 * requests over the same transcript replay a byte-identical prefix.
	 */
	requestControls?: AnthropicRequestControls;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/** Local wall-clock time the response finished streaming (ms since epoch); stamped by the session at message_end so prompt→yield timing never depends on provider-reported duration. */
	completedAt?: number;
	/**
	 * Dense per-turn study record (request-start wall-clock, ttft, throughput),
	 * present when session instrumentation is on. The graded, single-owner form of
	 * the loose `duration`/`ttft` scalars above; its detail scales with the
	 * configured {@link InstrumentationLevel} (absent at `off` and on turns
	 * recorded before it existed). See {@link captureAssistantTurnMetrics}.
	 */
	turnMetrics?: AssistantTurnMetrics;
	/**
	 * Exact sampling/reasoning/tool-choice parameters AS SENT for this turn,
	 * present when session instrumentation is on. The replay-fidelity companion to
	 * {@link turnMetrics}: it records what the turn was asked for, so a backtest can
	 * reproduce the request. Absent at `off`, on all-default turns, and on turns
	 * recorded before it existed. See {@link captureAssistantTurnRequest}.
	 */
	request?: AssistantTurnRequest;
}

/**
 * What an errored tool result says when the tool produced no output of its own.
 *
 * A user reads this line. It was declared twice, in `@veyyon/agent`'s loop (which
 * fills it in at the boundary where an untyped tool result enters) and in
 * `@veyyon/ai`'s Anthropic provider (which fills it in on the way to the wire,
 * because the API rejects an empty content array). The two are the same sentence
 * about the same event, so an edit to one produced a transcript where the same
 * failure was worded two ways depending on which layer noticed it first. It lives
 * here because this module owns {@link ToolResultMessage}, the shape being filled.
 */
export const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent | VideoContent)[]; // Supports text, images, and videos
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/** Provider-native metadata required to faithfully replay this result. */
	providerMetadata?: ToolResultProviderMetadata;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	/**
	 * Dense study record for this call (timing, output weight, args fingerprint),
	 * present when session instrumentation is on. Its detail scales with the
	 * configured {@link InstrumentationLevel}; absent at `off` and on messages
	 * recorded before instrumentation existed. See {@link captureToolCallMetrics}.
	 */
	metrics?: ToolCallMetrics;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
