/**
 * One side-channel turn against the session's model, system prompt and history: `/btw`, `/omfg`,
 * the idle recap, the IRC auto-reply and the composer prediction share it.
 *
 * The main turn's tool catalog is sent to keep the prompt cache, the model is told not to call
 * tools, and any tool call in the reply is dropped. The session's history and persisted state are
 * not modified. The function reads the session only through {@link EphemeralTurnHost}.
 */
import type { Agent, AgentMessage, StreamFn, ThinkingLevel } from "@veyyon/agent-core";
import type {
	AssistantMessage,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { Snowflake } from "@veyyon/utils";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { mapAssistantContentStrings } from "../secrets/obfuscator";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { dedupeEphemeralReply } from "./ephemeral-reply";
import type { SessionSecrets } from "./runtime/session-secrets";

/** What {@link runEphemeralTurn} reads from the session it runs against. */
export interface EphemeralTurnHost {
	readonly model: Model | undefined;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly sessionId: string;
	readonly messages: readonly AgentMessage[];
	readonly agent: Agent;
	readonly preferWebsockets: boolean | undefined;
	readonly providerSessionStates: Map<string, ProviderSessionState>;
	readonly secrets: SessionSecrets;
	/** The stream function every side request of the session runs on. */
	readonly sideStreamFn: StreamFn;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): Promise<SimpleStreamOptions>;
	/** The session's routed credential for `model`: refresh and account rotation apply. */
	resolveApiKey(model: Model, sessionId: string): SimpleStreamOptions["apiKey"];
	effectiveServiceTier(model: Model): ServiceTier | undefined;
}

/** One side-channel request. */
export interface EphemeralTurnArgs {
	promptText: string;
	history?: readonly Message[];
	/** Session-local key for serialized side turns; rotate after cancellation or failure. */
	conversationKey?: string;
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
	/** `false` returns the reply as streamed; the default collapses repeated lines and caps its size. */
	dedupeReply?: boolean;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	/** On an OpenAI Codex model, marks the request as an ephemeral fork of the session's Codex thread. */
	codexThreadSource?: string;
	/** Sends this exact bearer, with no refresh and no move to another account. */
	apiKey?: string;
}

/** The reply text, secrets expanded, and the final message with its tool calls removed. */
export interface EphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

/**
 * Build a message snapshot for an ephemeral side-channel turn. Includes
 * the in-flight streaming assistant message (if any) so the model sees
 * the partial response in context, then appends the prompt as a virtual
 * user message.
 */
function buildEphemeralSnapshot(
	history: readonly AgentMessage[],
	streaming: AgentMessage | null | undefined,
	promptText: string,
	detachedHistory?: readonly Message[],
): AgentMessage[] {
	const messages = [...history];
	if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
		const preservedBlocks: AssistantMessage["content"] = [];
		// Preserve thinking blocks: DeepSeek-class encoders replay them as
		// `reasoning_content` and reject the request (HTTP 400) when the field
		// goes missing on a turn that previously emitted thinking.
		for (const c of streaming.content) {
			if (c.type === "thinking") preservedBlocks.push(c);
		}
		const streamingText = assistantText(streaming, "");
		if (streamingText) {
			preservedBlocks.push({ type: "text", text: streamingText });
		}
		if (preservedBlocks.length > 0) {
			const normalized: AssistantMessage = {
				...streaming,
				content: preservedBlocks,
			};
			const lastMessage = messages.at(-1);
			if (lastMessage?.role === "assistant") {
				messages[messages.length - 1] = normalized;
			} else {
				messages.push(normalized);
			}
		}
	}
	messages.push({
		role: "developer",
		content: [{ type: "text", text: sideChannelPrompts["side-channel/side-channel-no-tools"].text }],
		attribution: "agent",
		timestamp: Date.now(),
	});
	if (detachedHistory?.length) {
		// Detach before the conversion pipeline can await or mutate caller-owned messages.
		messages.push(...(structuredClone(detachedHistory) as AgentMessage[]));
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: promptText }],
		attribution: "agent",
		timestamp: Date.now(),
	});
	return messages;
}

/**
 * Run a single ephemeral side-channel turn. The side request does not block on, or interfere
 * with, any in-flight main turn. The snapshot includes any in-flight streaming assistant text so
 * the model sees the half-finished response rather than missing context.
 *
 * `model` and `thinkingLevel` default to the session's. `apiKey` is for a caller that checked
 * which account the bearer belongs to; absent, the session's routing applies.
 */
export async function runEphemeralTurn(host: EphemeralTurnHost, args: EphemeralTurnArgs): Promise<EphemeralTurnResult> {
	const model = args.model ?? host.model;
	if (!model) {
		throw new Error("No active model on session");
	}
	const thinkingLevel = args.thinkingLevel ?? host.thinkingLevel;
	const cacheSessionId = host.sessionId;
	const agent = host.agent;
	const secrets = host.secrets;
	// Providers route on `promptCacheKey ?? sessionId`. The live loop sends the
	// agent's pinned key when it has one (fork, tan, shared session), so mirror
	// that rather than the session id or this side turn cold-misses the prefix.
	const ephemeralPromptCacheKey = agent.promptCacheKey ?? cacheSessionId;
	const snapshot = buildEphemeralSnapshot(host.messages, agent.state.streamMessage, args.promptText, args.history);
	const llmMessages = await host.convertMessagesToLlm(snapshot, args.signal);
	const context = await agent.buildSideRequestContext(llmMessages, undefined, model);
	const options = await host.prepareSimpleStreamOptions(
		{
			apiKey: args.apiKey ?? host.resolveApiKey(model, cacheSessionId),
			// Side-channel turns must not share OpenAI/Codex append-only
			// conversation state with the main agent turn: IRC and /btw can run
			// while the main turn is mid-tool-call. Keep the prompt-cache key
			// stable, but give provider routing a unique request lineage. The
			// shared provider state map is still required so Codex can allocate
			// websocket state under that side-channel session id.
			sessionId: args.conversationKey
				? `${cacheSessionId}:side:conversation:${args.conversationKey}`
				: `${cacheSessionId}:side:${Snowflake.next()}`,
			promptCacheKey: ephemeralPromptCacheKey,
			preferWebsockets: host.preferWebsockets,
			providerSessionState: host.providerSessionStates,
			reasoning: toReasoningEffort(thinkingLevel),
			disableReasoning: shouldDisableReasoning(thinkingLevel),
			hideThinkingSummary: agent.hideThinkingSummary,
			serviceTier: host.effectiveServiceTier(model),
			codexFork: args.codexThreadSource
				? { parentSessionId: agent.sessionId ?? cacheSessionId, threadSource: args.codexThreadSource }
				: undefined,
			signal: args.signal,
		},
		model.provider,
	);

	let providerReplyText = "";
	let emittedReplyText = "";
	let assistantMessage: AssistantMessage | undefined;
	const stream = await host.sideStreamFn(model, secrets.obfuscateContext(context), options);
	for await (const event of stream) {
		if (event.type === "text_delta") {
			providerReplyText += event.delta;
			if (args.onTextDelta) {
				const readyText = secrets.providerTextReadyForDelta(providerReplyText);
				if (readyText.length > emittedReplyText.length) {
					const delta = readyText.slice(emittedReplyText.length);
					emittedReplyText = readyText;
					args.onTextDelta(delta);
				}
			}
			continue;
		}
		if (event.type === "done") {
			// A well-formed provider "done" event carries `content: AssistantContentBlock[]`,
			// but a proxy/wrapper (custom extension providers, gateway-wrapped OAuth streams,
			// see #4323) can hand back a message whose `content` was dropped or replaced with
			// `undefined`. Downstream `.content.filter` at the sanitize step below would then
			// crash the recap turn with `TypeError: undefined is not an object (evaluating
			// 'H.content.filter')`. Normalize to `[]` so the recap surfaces an empty reply
			// instead of turning a malformed side-channel response into a session-mute crash.
			const rawContent = Array.isArray(event.message.content) ? event.message.content : [];
			// RENDER PATH, and async: this reply is shown to the operator (btw,
			// omfg, the idle recap) and is never handed to a tool. Being inside an
			// await it can do better than degrade, so it waits for the vault re-read
			// a stale revision needs and then expands from the runtime that refresh
			// installs. A refresh that fails renders placeholders literally rather
			// than killing the side-channel turn.
			await secrets.awaitRefreshForRender(secrets.contentCarriesLivePlaceholder(rawContent));
			const expandReply = secrets.displayExpander();
			assistantMessage = {
				...event.message,
				content:
					expandReply === undefined
						? rawContent
						: mapAssistantContentStrings(rawContent, expandReply, { includeToolMetadata: true }),
			};
			break;
		}
		if (event.type === "error") {
			throw new Error(event.error.errorMessage || "Ephemeral turn failed");
		}
	}

	if (!assistantMessage) {
		throw new Error("Ephemeral turn ended without a final message");
	}
	const replyText = secrets.expandForDisplay(providerReplyText);
	if (args.onTextDelta && replyText.length > emittedReplyText.length) {
		args.onTextDelta(replyText.slice(emittedReplyText.length));
	}
	const sanitizedMessage: AssistantMessage = {
		...assistantMessage,
		content: assistantMessage.content.filter(block => block.type !== "toolCall"),
	};
	return {
		replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
		assistantMessage: sanitizedMessage,
	};
}
