/**
 * Shared utilities for Google Generative AI and Google Cloud Code Assist providers.
 */

import { scheduler } from "node:timers/promises";
import { googleThinkingLevelWhenOff } from "@veyyon/catalog/model-thinking";
import {
	calculateCost,
	discardAttemptUsage,
	emptyCost,
	emptyUsage,
	inheritUsageCarryovers,
} from "@veyyon/catalog/models";
import { exponentialBackoffDelay } from "@veyyon/utils/backoff";
import { readSseJson } from "@veyyon/utils/stream";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ServiceTier,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../types";
import { shouldSendServiceTier } from "../types";
import { normalizeSystemPrompts, normalizeToolCallId } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { notifyProviderResponse } from "../utils/provider-response";
import { normalizeSchemaForCCA, normalizeSchemaForGoogle, toolWireSchema } from "../utils/schema";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import {
	firstRetainedAssistantIndex,
	isValidThoughtSignature,
	type SignaturePolicy,
	SKIP_THOUGHT_SIGNATURE,
	sendsSignature,
	signaturePolicy,
} from "./google-thought-signatures";
import type {
	Content,
	FinishReason,
	FunctionCallingConfigMode,
	FunctionCallPart,
	FunctionResponsePart,
	GenerateContentConfig,
	GenerateContentParameters,
	GenerateContentResponse,
	Part,
	ThinkingConfig,
	ThinkingLevel,
	UsageMetadata,
} from "./google-types";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import { transformMessages } from "./transform-messages";
import { NON_VIDEO_MODEL_PLACEHOLDER, NON_VISION_IMAGE_PLACEHOLDER } from "./vision-content";

export type {
	Content,
	FunctionCallingConfigMode,
	GenerateContentParameters,
	GenerateContentResponse,
	ThinkingConfig,
	ThinkingLevel,
} from "./google-types";
export { normalizeSchemaForGoogle };

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";
function convertGoogleImagePart(image: ImageContent): Part {
	if (image.providerFile?.provider === "google" && image.providerFile.uri) {
		return { fileData: { fileUri: image.providerFile.uri, mimeType: image.mimeType } };
	}
	return image.url
		? { fileData: { fileUri: image.url, mimeType: image.mimeType } }
		: { inlineData: { mimeType: image.mimeType, data: image.data } };
}

/**
 * Thinking level for Gemini 3 models. Mirrors Google's `ThinkingLevel` enum values.
 * Defined here (not in any specific provider) so all Google providers can reference it
 * without inducing a circular dependency.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Sampling/thinking options shared by `streamGoogle` and `streamGoogleVertex`.
 * `google-gemini-cli` uses a different transport and request shape — do not extend this for it.
 */
export interface GoogleSharedStreamOptions extends StreamOptions {
	/**
	 * Tool selection mode. String forms map directly to Gemini
	 * `FunctionCallingConfigMode`. The object form forces a single named tool
	 * — `mode: "ANY"` is wire-required when `allowedFunctionNames` is set.
	 */
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleThinkingLevel;
	};
	/** Request that Google omit human-readable thought summaries while still allowing internal reasoning. */
	hideThinkingSummary?: boolean;
	/** Gemini/Vertex serving tier (`flex`/`priority`); other values are omitted. */
	serviceTier?: ServiceTier;
	/**
	 * Caller-owned Google context-cache resource name for GenerateContent.
	 * Passed through opaquely as the wire `cachedContent` field. OMP does not
	 * create, refresh, validate compatibility, or delete the resource.
	 */
	cachedContent?: string;
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/** The per-model wire facts every converted message reads, resolved once per request. */
interface GoogleWireTraits {
	readonly supportsImages: boolean;
	readonly supportsVideos: boolean;
	/** Function call and response parts carry ids only when the resolved model supports them. */
	readonly sendsPartId: boolean;
	/** Tool-result images may be nested inside `functionResponse.parts`. */
	readonly multimodalFunctionResponse: boolean;
}

function googleWireTraits<T extends GoogleApiType>(model: Model<T>): GoogleWireTraits {
	return {
		supportsImages: model.input.includes("image"),
		supportsVideos: model.input.includes("video"),
		sendsPartId: model.compat.supportsFunctionPartId,
		multimodalFunctionResponse: model.compat.multimodalFunctionResponse,
	};
}

/** The parts of a user or developer turn, empty when nothing in it is sendable. */
function userParts(content: UserMessage["content"], traits: GoogleWireTraits): Part[] {
	if (typeof content === "string") {
		return content.trim() === "" ? [] : [{ text: content.toWellFormed() }];
	}
	const parts: Part[] = [];
	let omittedImages = false;
	let omittedVideos = false;
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim().length > 0) parts.push({ text });
		} else if (item.type === "image") {
			if (traits.supportsImages) parts.push(convertGoogleImagePart(item));
			else omittedImages = true;
		} else if (item.type === "video") {
			if (traits.supportsVideos) parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
			else omittedVideos = true;
		}
	}
	if (omittedImages) parts.push({ text: NON_VISION_IMAGE_PLACEHOLDER });
	if (omittedVideos) parts.push({ text: NON_VIDEO_MODEL_PLACEHOLDER });
	return parts;
}

/**
 * Builds the Gemini `Content[]` for one request, one transformed message at a time.
 *
 * Gemini < 3 image tool results go in a separate user turn, but parallel tool results must
 * stay a single contiguous functionResponse turn ("number of function response parts is not
 * equal to number of function call parts"). Image turns are buffered and written only after
 * the merged functionResponse turn is complete.
 */
class GoogleContentWriter {
	readonly #contents: Content[] = [];
	readonly #emittedToolCallNames = new Map<string, string>();
	#pendingToolImageParts: Part[] = [];

	constructor(
		readonly model: Model<GoogleApiType>,
		readonly traits: GoogleWireTraits,
		readonly signatures: SignaturePolicy,
		readonly retainThinkingFrom: number,
	) {}

	write(message: Message, messageIndex: number): void {
		if (message.role !== "toolResult") this.#flushToolImages();
		switch (message.role) {
			case "user":
			case "developer":
				this.#pushTurn("user", userParts(message.content, this.traits));
				break;
			case "assistant":
				this.#pushTurn("model", this.#assistantParts(message, messageIndex));
				break;
			case "toolResult":
				this.#writeToolResult(message);
				break;
		}
	}

	finish(): Content[] {
		this.#flushToolImages();
		return this.#contents;
	}

	#pushTurn(role: "user" | "model", parts: Part[]): void {
		if (parts.length > 0) this.#contents.push({ role, parts });
	}

	#flushToolImages(): void {
		if (this.#pendingToolImageParts.length === 0) return;
		this.#contents.push({ role: "user", parts: this.#pendingToolImageParts });
		this.#pendingToolImageParts = [];
	}

	#assistantParts(message: AssistantMessage, messageIndex: number): Part[] {
		// Signatures are replayed only to the provider and model that minted them.
		const sameModel = message.provider === this.model.provider && message.model === this.model.id;
		const parts: Part[] = [];
		let isFirstToolCall = true;
		for (const block of message.content) {
			let part: Part | undefined;
			switch (block.type) {
				case "text":
					part = textPart(block, sameModel);
					break;
				case "thinking":
					part = this.#thinkingPart(block, messageIndex, sameModel);
					break;
				case "toolCall":
					part = this.#functionCallPart(block, messageIndex, sameModel, isFirstToolCall);
					isFirstToolCall = false;
					break;
			}
			if (part) parts.push(part);
		}
		return parts;
	}

	#thinkingPart(block: ThinkingContent, messageIndex: number, sameModel: boolean): Part | undefined {
		const thoughtSignature = resolveThoughtSignature(sameModel, block.thinkingSignature);
		if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) return undefined;
		if (this.model.compat.dropUnsignedThinking && !thoughtSignature) return undefined;
		if (sameModel) {
			return {
				thought: true,
				text: block.thinking.toWellFormed(),
				...(thoughtSignature && { thoughtSignature }),
			};
		}
		// Keep the fork's transcript retention bound for demoted, cross-model thoughts.
		if (messageIndex < this.retainThinkingFrom) return undefined;
		return { text: renderDemotedThinking(this.model.id, block.thinking) };
	}

	#functionCallPart(
		block: ToolCall,
		messageIndex: number,
		sameModel: boolean,
		isFirstToolCall: boolean,
	): Part {
		this.#emittedToolCallNames.set(block.id, block.name);
		const thoughtSignature =
			block.thoughtSignature && !sendsSignature(this.signatures, messageIndex, block.thoughtSignature)
				? undefined
				: resolveThoughtSignature(sameModel, block.thoughtSignature);
		const functionCall: FunctionCallPart = { name: block.name, args: block.arguments ?? {} };
		if (this.traits.sendsPartId) functionCall.id = block.id;
		const requiresFallback =
			this.model.compat.requiresSkipThoughtSignature ||
			(isFirstToolCall && this.model.compat.requiresSkipThoughtSignatureOnFirstFunctionCall);
		const effectiveSignature = thoughtSignature || (requiresFallback ? SKIP_THOUGHT_SIGNATURE : undefined);
		const part: Part = { functionCall };
		if (effectiveSignature) part.thoughtSignature = effectiveSignature;
		return part;
	}

	#writeToolResult(message: ToolResultMessage): void {
		const { supportsImages, supportsVideos, multimodalFunctionResponse, sendsPartId } = this.traits;
		let text: string | undefined;
		const imageParts: Part[] = [];
		let omittedImages = false;
		let omittedVideos = false;
		for (const block of message.content) {
			if (block.type === "text") {
				text = text === undefined ? block.text : `${text}\n${block.text}`;
			} else if (block.type === "image") {
				if (supportsImages) imageParts.push(convertGoogleImagePart(block));
				else omittedImages = true;
			} else if (block.type === "video" && !supportsVideos) {
				omittedVideos = true;
			}
		}
		const textResult = text?.toWellFormed() ?? "";
		const hasText = textResult.length > 0;
		const hasImages = imageParts.length > 0;

		// "output" carries a success and "error" a failure, as the SDK documents.
		const omittedParts: string[] = [];
		if (omittedImages) omittedParts.push(NON_VISION_IMAGE_PLACEHOLDER);
		if (omittedVideos) omittedParts.push(NON_VIDEO_MODEL_PLACEHOLDER);
		let responseValue: string;
		if (omittedParts.length > 0) {
			responseValue = [hasText ? textResult : "", ...omittedParts].filter(Boolean).join("\n");
		} else {
			responseValue = hasText ? textResult : hasImages ? "(see attached image)" : "";
		}

		const functionResponse: FunctionResponsePart = {
			name: this.#emittedToolCallNames.get(message.toolCallId) ?? message.toolName,
			response: message.isError ? { error: responseValue } : { output: responseValue },
		};
		if (hasImages && multimodalFunctionResponse) functionResponse.parts = imageParts;
		if (sendsPartId) functionResponse.id = message.toolCallId;
		const part: Part = { functionResponse };

		// Cloud Code Assist requires every function response in a single user turn, so a
		// response directly after another one joins that turn.
		const lastContent = this.#contents[this.#contents.length - 1];
		if (lastContent?.role === "user" && lastContent.parts?.some(p => p.functionResponse)) {
			lastContent.parts.push(part);
		} else {
			this.#contents.push({ role: "user", parts: [part] });
		}

		if (hasImages && !multimodalFunctionResponse) {
			this.#pendingToolImageParts.push({ text: "Tool result image:" }, ...imageParts);
		}
	}
}

function textPart(block: TextContent, sameModel: boolean): Part | undefined {
	// Empty text blocks are skipped: some models (e.g. Claude via Antigravity) reject them.
	if (!block.text || block.text.trim() === "") return undefined;
	const thoughtSignature = resolveThoughtSignature(sameModel, block.textSignature);
	const part: Part = { text: block.text.toWellFormed() };
	if (thoughtSignature) part.thoughtSignature = thoughtSignature;
	return part;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const messages = transformMessages(context.messages, model, normalizeToolCallId);
	const writer = new GoogleContentWriter(
		model,
		googleWireTraits(model),
		signaturePolicy(messages, context),
		firstRetainedAssistantIndex(messages, context.thinkingRetention),
	);
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		writer.write(messages[messageIndex], messageIndex);
	}
	return writer.finish();
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * We prefer `parametersJsonSchema` (full JSON Schema: anyOf/oneOf/const/etc.).
 *
 * Claude models via Cloud Code Assist require the legacy `parameters` field; the API
 * translates it into Anthropic's `input_schema`. When using that path, we sanitize the
 * schema to remove Google-unsupported JSON Schema keywords.
 */
export function convertTools(
	tools: Tool[],
	model: Model<"google-generative-ai" | "google-gemini-cli" | "google-vertex">,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;

	/**
	 * Claude models on Cloud Code Assist need the legacy `parameters` field;
	 * the API translates it into Anthropic's `input_schema`.
	 */
	const useParameters = model.compat.ccaLegacyParametersSchema;

	return [
		{
			functionDeclarations: tools.map(tool => ({
				name: tool.name,
				description: tool.description || "",
				...(useParameters
					? { parameters: normalizeSchemaForCCA(toolWireSchema(tool)) }
					: { parametersJsonSchema: normalizeSchemaForGoogle(toolWireSchema(tool)) }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return "AUTO";
		case "none":
			return "NONE";
		case "any":
			return "ANY";
		default:
			return "AUTO";
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "NO_IMAGE":
			return "error";
		default: {
			throw new AIError.ConfigurationError(`Unhandled stop reason: ${reason satisfies never}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * Bounded retries for the well-known Gemini "empty response" failure: a benign
 * `finishReason: STOP` carrying only an empty/whitespace text part and no tool call.
 * Shared by the public/Vertex `streamGoogleGenAI` path and the Cloud Code Assist
 * (`google-gemini-cli`/`google-antigravity`) provider so both apply the same policy.
 */
export const MAX_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

/**
 * Whether a completed Google assistant message carries content worth delivering.
 *
 * A tool call or any non-whitespace text counts as meaningful. An empty/whitespace-only
 * text part — or thinking that never produced an answer — is the "empty response" failure:
 * delivered as-is the agent loop has nothing to act on and silently halts, so the request
 * must be retried instead of surfaced.
 */
export function hasMeaningfulGoogleContent(output: AssistantMessage): boolean {
	for (const block of output.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

/**
 * Wipe a streamed message between empty-response retries so the next attempt
 * starts clean. An empty Gemini response is the most expensive shape of this
 * failure (the prompt and every thinking token were billed for an answer that
 * never arrived), so the spend is carried forward even though the text is not.
 */
export function resetGoogleStreamOutputForRetry(model: Model<Api>, output: AssistantMessage): void {
	output.content = [];
	output.usage = discardAttemptUsage(model, output.usage, emptyUsage());
	output.stopReason = "stop";
	output.errorMessage = undefined;
	output.timestamp = Date.now();
}

/**
 * Map Gemini's cumulative token counts onto the shared usage shape.
 * `promptTokenCount` includes cached tokens; clamp cache reads so reported
 * input cannot go negative when an upstream endpoint over-reports cache usage.
 */
export function mapGoogleUsage(metadata: UsageMetadata): Usage {
	const candidates = metadata.candidatesTokenCount || 0;
	const thinking = metadata.thoughtsTokenCount || 0;
	const total = metadata.totalTokenCount || 0;
	const prompt = metadata.promptTokenCount || Math.max(0, total - candidates - thinking);
	const cacheRead = Math.min(metadata.cachedContentTokenCount || 0, prompt);
	return {
		input: prompt - cacheRead,
		output: candidates + thinking,
		cacheRead,
		cacheWrite: 0,
		totalTokens: total,
		...(thinking > 0 ? { reasoningTokens: thinking } : {}),
		cost: emptyCost(),
	};
}

/** Module-local counter for generating unique tool call IDs across Google providers. */

let toolCallCounter = 0;

export function nextToolCallId(name: string): string {
	return `${name}_${Date.now()}_${++toolCallCounter}`;
}

/** Whether streamed thought text is healed or kept verbatim. */
export type GoogleThoughtText = "healed" | "verbatim";

const REASONING_FENCE_OPENER = /^ {0,3}`{3,}(?:thinking|reasoning)[ \t]*\r?$/i;

function couldBeReasoningFencePrefix(line: string): boolean {
	const current = line.endsWith("\r") ? line.slice(0, -1) : line;
	const match = /^ {0,3}(`*)([\s\S]*)$/.exec(current);
	if (!match) return false;
	const ticks = match[1]!.length;
	const rest = match[2]!;
	if (rest === "") return true;
	if (ticks < 3) return false;
	const word = rest.replace(/[ \t]+$/, "").toLowerCase();
	return "thinking".startsWith(word) || "reasoning".startsWith(word);
}

/** Streaming-safe removal of standalone reasoning-fence opener lines. */
class GoogleThinkingFenceStripper {
	#carry = "";
	#passthrough = false;

	push(chunk: string): string {
		let out = "";
		for (const char of chunk) {
			if (this.#passthrough) {
				out += char;
				if (char === "\n") this.#passthrough = false;
				continue;
			}
			if (char === "\n") {
				if (!REASONING_FENCE_OPENER.test(this.#carry)) out += `${this.#carry}\n`;
				this.#carry = "";
				continue;
			}
			this.#carry += char;
			if (!couldBeReasoningFencePrefix(this.#carry)) {
				out += this.#carry;
				this.#carry = "";
				this.#passthrough = true;
			}
		}
		return out;
	}

	flush(): string {
		const carry = this.#carry;
		this.#carry = "";
		this.#passthrough = false;
		return REASONING_FENCE_OPENER.test(carry) ? "" : carry;
	}
}

/**
 * The content blocks one Google response streams into `output`, and the events each one
 * pushes. The SDK-shaped decoder and Cloud Code Assist SSE decoder share these transitions.
 */
export class GoogleResponseBlocks {
	#current: TextContent | ThinkingContent | null = null;
	#thinkingStripper: GoogleThinkingFenceStripper | null = null;

	constructor(
		readonly output: AssistantMessage,
		readonly stream: AssistantMessageEventStream,
		/** Streamed text keeps its `textSignature`; thinking always keeps its own. */
		readonly retainTextSignature: boolean,
		/** Runs after a block or tool call is appended and before its first event. */
		readonly onBlockAppended?: () => void,
		readonly thoughtText: GoogleThoughtText = "verbatim",
	) {}

	appendText(delta: string, thoughtSignature?: string): void {
		if (!delta) return;
		let block = this.#current;
		if (block?.type !== "text") {
			block = { type: "text", text: "" };
			this.#open(block);
		}
		block.text += delta;
		if (this.retainTextSignature) block.textSignature = retainThoughtSignature(block.textSignature, thoughtSignature);
		this.stream.push({ type: "text_delta", contentIndex: this.#lastIndex(), delta, partial: this.output });
	}

	appendThinking(delta: string, thoughtSignature?: string): void {
		if (!delta && !thoughtSignature) return;
		let block = this.#current;
		if (block?.type !== "thinking") {
			block = { type: "thinking", thinking: "", thinkingSignature: undefined, summary: true };
			this.#open(block);
		}
		block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, thoughtSignature);
		const cleanDelta =
			this.thoughtText === "healed" ? (this.#thinkingStripper ??= new GoogleThinkingFenceStripper()).push(delta) : delta;
		if (!cleanDelta) return;
		block.thinking += cleanDelta;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: this.#lastIndex(),
			delta: cleanDelta,
			partial: this.output,
		});
	}

	/** A signature-only part belongs to the open block; with none open it is dropped. */
	retainSignature(thoughtSignature: string): void {
		const block = this.#current;
		if (!block) return;
		if (block.type === "thinking") {
			block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, thoughtSignature);
		} else if (this.retainTextSignature) {
			block.textSignature = retainThoughtSignature(block.textSignature, thoughtSignature);
		}
	}

	/** Google delivers a function call whole in one part, so it opens and closes at once. */
	appendFunctionCall(call: FunctionCallPart, thoughtSignature: string | undefined): void {
		this.endBlock();
		const content = this.output.content;
		// A missing id, or one this response already used, is replaced with a fresh one.
		const providedId = call.id;
		const reused = providedId !== undefined && content.some(b => b.type === "toolCall" && b.id === providedId);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: !providedId || reused ? nextToolCallId(call.name || "tool") : providedId,
			name: call.name || "",
			arguments: call.args ?? {},
		};
		if (thoughtSignature) toolCall.thoughtSignature = thoughtSignature;
		content.push(toolCall);
		this.onBlockAppended?.();
		const contentIndex = content.length - 1;
		this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial: this.output,
		});
		this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
	}

	endBlock(): void {
		const block = this.#current;
		if (!block) return;
		if (block.type === "thinking" && this.#thinkingStripper) {
			const tail = this.#thinkingStripper.flush();
			if (tail) {
				block.thinking += tail;
				this.stream.push({
					type: "thinking_delta",
					contentIndex: this.#lastIndex(),
					delta: tail,
					partial: this.output,
				});
			}
		}
		this.#thinkingStripper = null;
		this.#current = null;
		const contentIndex = this.#lastIndex();
		if (block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		} else {
			this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		}
	}

	#open(block: TextContent | ThinkingContent): void {
		this.endBlock();
		this.#current = block;
		this.output.content.push(block);
		this.onBlockAppended?.();
		const contentIndex = this.#lastIndex();
		if (block.type === "text") {
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		} else {
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		}
	}

	#lastIndex(): number {
		return this.output.content.length - 1;
	}
}
/** Shared text/thought folding for provider SSE consumers. */
export class GoogleTextBlocks {
	readonly #blocks: GoogleResponseBlocks;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, thoughtText: GoogleThoughtText) {
		this.#blocks = new GoogleResponseBlocks(output, stream, true, undefined, thoughtText);
	}

	push(part: Part): void {
		if (part.text === undefined) return;
		if (part.text === "") {
			if (!part.thoughtSignature || part.functionCall) return;
			if (isThinkingPart(part)) this.#blocks.appendThinking("", part.thoughtSignature);
			else this.#blocks.retainSignature(part.thoughtSignature);
			return;
		}
		if (isThinkingPart(part)) this.#blocks.appendThinking(part.text, part.thoughtSignature);
		else this.#blocks.appendText(part.text, part.thoughtSignature);
	}

	close(): void {
		this.#blocks.endBlock();
	}
}

/** A prompt Google refused outright arrives as a chunk with no candidates and a block reason. */
export function throwIfGooglePromptBlocked(
	response: {
		candidates?: readonly unknown[];
		promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	},
	provider: string,
): void {
	const blockReason = response.promptFeedback?.blockReason;
	if (!blockReason || response.candidates?.length) return;
	const detail = response.promptFeedback?.blockReasonMessage;
	throw new AIError.ProviderResponseError(`Request blocked by Google (${blockReason})${detail ? `: ${detail}` : ""}`, {
		provider,
		kind: "content-blocked",
	});
}

/**
 * Record a candidate's `finishReason`. Only a benign finish is upgraded by a trailing tool
 * call; an error finish (SAFETY, MALFORMED_FUNCTION_CALL, ...) surfaces even when earlier
 * chunks carried valid tool calls.
 */
export function applyGoogleFinishReason(output: AssistantMessage, mapped: StopReason, finishReason: string): void {
	if ((mapped === "stop" || mapped === "length") && output.content.some(b => b.type === "toolCall")) {
		output.stopReason = "toolUse";
		return;
	}
	output.stopReason = mapped;
	if (mapped === "error") output.errorMessage = AIError.providerFinishErrorMessage(finishReason);
}

/**
 * Record a chunk's cumulative token accounting.
 *
 * `promptTokenCount` includes `cachedContentTokenCount` when cached content is used, so the
 * cached share is subtracted: `input` is uncached prompt tokens and `cacheRead` the cached
 * ones, and `input + cacheRead` is the whole prompt with nothing counted twice.
 * Ref: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse.UsageMetadata
 */
export function applyGoogleUsage(model: Model<Api>, output: AssistantMessage, usage: UsageMetadata): void {
	output.usage = inheritUsageCarryovers(output.usage, mapGoogleUsage(usage));
	calculateCost(model, output.usage);
}

/**
 * Settle a response body that ended without a `finishReason`.
 *
 * That is a transport-clean EOF, not a dropped connection, and several Gemini-compatible
 * servers never send the marker at all; `stopReasonForTerminallessEof` holds the judgement
 * for every dialect. Google delivers a function call whole in one part, with `args` already
 * parsed and an id minted, so a name is the only field a partial call can be missing.
 */
export function settleGoogleTerminallessEof(output: AssistantMessage, provider: string, surface: string): void {
	const toolBatchIsComplete = output.content.every(block => block.type !== "toolCall" || block.name.length > 0);
	const stopReason = stopReasonForTerminallessEof(output.content, toolBatchIsComplete);
	if (stopReason === undefined) {
		throw new AIError.ProviderResponseError(
			`${surface} stream ended without a finish reason (connection dropped or response truncated)`,
			{ provider, kind: "incomplete-stream" },
		);
	}
	output.stopReason = stopReason;
}

/**
 * The reason a finished response is delivered with. An aborted or failed response is thrown
 * instead, so it reaches the caller's error path.
 */
export function googleDoneReason(
	output: AssistantMessage,
	provider: string,
): Extract<StopReason, "stop" | "length" | "toolUse"> {
	const reason = output.stopReason;
	if (reason !== "aborted" && reason !== "error") return reason;
	throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
		provider,
		kind: "output",
	});
}

/** Preserve Google RPC status in stream errors so quota classification stays accurate. */
export function googleStreamChunkError(error: NonNullable<GenerateContentResponse["error"]>, provider: string): Error {
	const detail =
		error.message && error.status
			? `${error.message} (${error.status})`
			: error.message || error.status || "unknown error";
	const message = `Google API stream error: ${detail}`;
	return typeof error.code === "number" && error.code >= 400
		? new AIError.GoogleApiError(message, error.code)
		: new AIError.ProviderResponseError(message, { provider, kind: "output" });
}

/**
 * Drives the chunked `generateContentStream` iterator into an `AssistantMessage` and
 * the corresponding `AssistantMessageEventStream`. Shared between `streamGoogle` and
 * `streamGoogleVertex`.
 *
 * The caller still owns: `output` construction, timing fields (`duration`/`ttft`),
 * `rawRequestDump`, opening the response body, pushing `start`/`done`/`error` events,
 * and the surrounding try/catch that translates thrown errors into
 * `output.stopReason`/`errorMessage`.
 */
export async function consumeGoogleStream<T extends GoogleApiType>(args: {
	googleStream: AsyncIterable<GenerateContentResponse>;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<T>;
	options: { signal?: AbortSignal } | undefined;
	/** Vertex preserves `textSignature` on streamed text deltas; google-generative-ai does not. */
	retainTextSignature?: boolean;
	onFirstToken?: () => void;
}): Promise<void> {
	const { googleStream, output, stream, model, options, onFirstToken } = args;
	const blocks = new GoogleResponseBlocks(output, stream, args.retainTextSignature ?? true, undefined, "healed");
	let firstTokenSeen = false;
	let sawFinishReason = false;

	for await (const chunk of googleStream) {
		if (chunk.error) throw googleStreamChunkError(chunk.error, model.provider);
		throwIfGooglePromptBlocked(chunk, model.provider);
		const candidate = chunk.candidates?.[0];
		const parts = candidate?.content?.parts;
		if (parts) {
			for (const part of parts) {
				if (part.text !== undefined) {
					if (part.text !== "") {
						if (!firstTokenSeen) {
							firstTokenSeen = true;
							onFirstToken?.();
						}
						if (isThinkingPart(part)) blocks.appendThinking(part.text, part.thoughtSignature);
						else blocks.appendText(part.text, part.thoughtSignature);
					} else if (part.thoughtSignature && !part.functionCall) {
						if (isThinkingPart(part)) blocks.appendThinking("", part.thoughtSignature);
						else blocks.retainSignature(part.thoughtSignature);
					}
				}
				if (part.functionCall) blocks.appendFunctionCall(part.functionCall, part.thoughtSignature);
			}
		}
		if (candidate?.finishReason) {
			sawFinishReason = true;
			applyGoogleFinishReason(output, mapStopReason(candidate.finishReason), candidate.finishReason);
		}
		if (chunk.usageMetadata) applyGoogleUsage(model, output, chunk.usageMetadata);
	}

	blocks.endBlock();
	if (options?.signal?.aborted) {
		throw new AIError.RequestAbortError();
	}
	if (!sawFinishReason) settleGoogleTerminallessEof(output, model.provider, "Google API");
	googleDoneReason(output, model.provider);
}

/**
 * Generation/sampling fields that map directly onto Gemini's `GenerateContentConfig`.
 * Excludes any provider-specific extensions (`topP`/`topK`/etc are all forwarded as-is).
 */
export interface GoogleGenerationConfig extends GenerateContentConfig {
	topP?: number;
	topK?: number;
	presencePenalty?: number;
}

/**
 * Extract and populate base Gemini generation configuration options.
 */
export function buildGoogleBaseGenerationConfig(options: StreamOptions): GoogleGenerationConfig {
	const generationConfig: GoogleGenerationConfig = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.topP !== undefined) generationConfig.topP = options.topP;
	if (options.topK !== undefined) generationConfig.topK = options.topK;
	if (options.presencePenalty !== undefined) generationConfig.presencePenalty = options.presencePenalty;
	return generationConfig;
}

/**
 * Build Gemini toolConfig from a standard tool choice option.
 */
export function buildGoogleToolConfig(
	toolChoice?: GoogleSharedStreamOptions["toolChoice"],
): { functionCallingConfig: { mode: FunctionCallingConfigMode; allowedFunctionNames?: string[] } } | undefined {
	if (!toolChoice) return undefined;
	if (typeof toolChoice === "string") {
		const mode = mapToolChoice(toolChoice);
		return mode !== "AUTO" ? { functionCallingConfig: { mode } } : undefined;
	}
	return {
		functionCallingConfig: {
			mode: "ANY",
			allowedFunctionNames: toolChoice.allowedFunctionNames.slice(),
		},
	};
}

/**
 * Build the `GenerateContentParameters` payload for the public Gemini API and Vertex AI.
 * Both surfaces accept the same `GenerateContentConfig` shape — every numeric/string knob,
 * tool-config, thinking-config, and system-instruction conversion is identical.
 *
 * `google-gemini-cli` is NOT routed through here: its `CloudCodeAssistRequest` body has a
 * distinct top-level shape (project/request/requestType) and a different thinking-config
 * placement on `generationConfig`.
 */
export function buildGoogleGenerateContentParams<T extends "google-generative-ai" | "google-vertex">(
	model: Model<T>,
	context: Context,
	options: GoogleSharedStreamOptions,
): GenerateContentParameters {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);

	const generationConfig = buildGoogleBaseGenerationConfig(options);

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemPrompts.length > 0 && { systemInstruction: { parts: systemPrompts.map(text => ({ text })) } }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools, model) }),
	};

	// Gemini API (google-generative-ai) reads the tier from the request body;
	// Vertex AI ignores a body field and requires the
	// `X-Vertex-AI-LLM-Shared-Request-Type` header instead (added in
	// streamGoogleVertex), so only emit the body field for the direct API.
	if (model.provider === "google" && shouldSendServiceTier(options.serviceTier, model.provider)) {
		config.serviceTier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		const toolConfig = buildGoogleToolConfig(options.toolChoice);
		if (toolConfig) {
			config.toolConfig = toolConfig;
		}
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking && model.reasoning) {
		const cfg: ThinkingConfig = { includeThoughts: options.thinking.enabled && !options.hideThinkingSummary };
		if (!options.thinking.enabled) {
			if (model.thinking?.mode === "google-level")
				cfg.thinkingLevel = googleThinkingLevelWhenOff(model) as ThinkingLevel;
			else cfg.thinkingBudget = 0;
		} else if (options.thinking.level !== undefined) {
			// GoogleThinkingLevel mirrors the SDK's `ThinkingLevel` string enum values 1:1.
			cfg.thinkingLevel = options.thinking.level as ThinkingLevel;
		} else if (options.thinking.budgetTokens !== undefined) {
			cfg.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = cfg;
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new AIError.RequestAbortError("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	if (options.cachedContent !== undefined) {
		if (options.cachedContent.trim().length === 0) {
			throw new AIError.ValidationError("cachedContent must not be blank");
		}
		const incompatibleFields = [
			config.systemInstruction !== undefined && "systemInstruction",
			config.tools !== undefined && "tools",
			config.toolConfig !== undefined && "toolConfig",
		].filter((field): field is string => Boolean(field));
		if (incompatibleFields.length > 0) {
			throw new AIError.ValidationError(
				`cachedContent cannot be combined with request-level ${incompatibleFields.join(", ")}`,
			);
		}
		config.cachedContent = options.cachedContent;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

/**
 * Drive the `streamGoogle` / `streamGoogleVertex` event flow: build the assistant message,
 * push start/done/error events, run `consumeGoogleStream`, and translate thrown errors into
 * the canonical `error` event shape.
 *
 * Caller-supplied `prepare()` runs inside the try-block so any failure (missing project,
 * bad auth, etc.) is funneled through the same error path as a streaming failure.
 */
export interface GoogleGenAIRequestPlan {
	params: GenerateContentParameters;
	url: string;
	headers: Record<string, string>;
	fetch?: FetchImpl;
	/** Optional URL retried once when {@link url} returns 404 (regional Vertex endpoint missing a global-only model). */
	fallbackUrl?: string;
}

export function streamGoogleGenAI<T extends "google-generative-ai" | "google-vertex">(args: {
	model: Model<T>;
	options: GoogleSharedStreamOptions | undefined;
	api: T;
	retainTextSignature?: boolean;
	prepare: () => GoogleGenAIRequestPlan | Promise<GoogleGenAIRequestPlan>;
}): AssistantMessageEventStream {
	const { model, options, api, retainTextSignature, prepare } = args;
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(api as Api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
		let wireBodyJson: string | undefined;

		try {
			const plan = await prepare();
			let params = plan.params;
			if (options?.onPayload && params.config) {
				// The hook is a JSON seam: a host's secret redactor walks the payload
				// rewriting every string and refuses any value JSON cannot express,
				// and an AbortSignal is never that shape. `paramsToWireBody` drops the
				// signal before serialization and nothing else reads it, so it does
				// not cross the hook boundary.
				delete params.config.abortSignal;
			}
			const replacement = await options?.onPayload?.(params, model);
			if (replacement !== undefined) {
				params = replacement as GenerateContentParameters;
			}
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: plan.url,
				headers: plan.headers,
			};

			// Retain the exact sent BYTES, not the parsed object: a dump body is read
			// only on the 400/413 path, and holding the graph here pinned a full
			// context-sized object for the whole stream.
			const bodyJson = JSON.stringify(paramsToWireBody(params));
			wireBodyJson = bodyJson;
			const fetchImpl = plan.fetch ?? options?.fetch ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
			const openStreamAt = async (requestUrl: string): Promise<ReadableStream<Uint8Array>> => {
				const response = await fetchImpl(requestUrl, {
					method: "POST",
					headers: { ...plan.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
					body: bodyJson,
					signal: options?.signal,
				});
				await notifyProviderResponse(options, response, model, response.headers.get("x-request-id"));
				if (!response.ok) {
					// The STATUS is the failure; the body is the detail. An unreadable body degrades to empty rather than
					// replacing the status with a read error, and the read is bounded because the HTML-page case has no
					// size a provider promised.
					const errorBody = await AIError.readProviderErrorBody(response);
					throw new AIError.GoogleApiError(
						`Google API error (${response.status}): ${extractGoogleErrorMessage(errorBody, response.status)}`,
						response.status,
						{ headers: response.headers },
					);
				}
				if (!response.body) {
					throw new AIError.ProviderResponseError("Google API returned an empty response body", {
						provider: model.provider,
						kind: "empty-body",
					});
				}
				return response.body as ReadableStream<Uint8Array>;
			};
			// A regional Vertex endpoint 404s for models published only on the
			// global endpoint; retry global once so a stale/ambient region never
			// breaks a request that worked before regional routing existed.
			const openStream = async (): Promise<ReadableStream<Uint8Array>> => {
				if (!plan.fallbackUrl) return openStreamAt(plan.url);
				try {
					return await openStreamAt(plan.url);
				} catch (error) {
					if (error instanceof AIError.GoogleApiError && error.status === 404) {
						return openStreamAt(plan.fallbackUrl);
					}
					throw error;
				}
			};

			let body = await openStream();
			stream.push({ type: "start", partial: output });

			// Gemini occasionally finishes with `finishReason: STOP` while emitting only an empty
			// text part and no tool call. Delivered as-is the agent receives a blank message and
			// silently halts mid-task, so retry a bounded number of times before giving up.
			for (let emptyAttempt = 0; ; emptyAttempt++) {
				const googleStream = readSseJson<GenerateContentResponse>(body, options?.signal, event =>
					options?.onSseEvent?.({ event: event.event, data: event.data, raw: event.raw.slice() }, model),
				);
				await consumeGoogleStream({
					googleStream,
					output,
					stream,
					model,
					options,
					retainTextSignature,
					onFirstToken: () => {
						firstTokenTime = performance.now();
					},
				});

				if (output.stopReason !== "stop" || hasMeaningfulGoogleContent(output) || options?.acceptEmptyResponse) break;
				if (emptyAttempt >= MAX_EMPTY_STREAM_RETRIES) {
					throw new AIError.ProviderResponseError(
						`Google API returned an empty response (finishReason STOP with no content) after ${MAX_EMPTY_STREAM_RETRIES + 1} attempts`,
						{ provider: model.provider, kind: "empty-body" },
					);
				}
				try {
					const delayMs = exponentialBackoffDelay(emptyAttempt, { baseMs: EMPTY_STREAM_BASE_DELAY_MS, jitter: 0 });
					await scheduler.wait(delayMs, { signal: options?.signal });
				} catch {
					throw new AIError.RequestAbortError();
				}
				resetGoogleStreamOutputForRetry(model, output);
				body = await openStream();
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "length" | "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: model.api,
				signal: options?.signal,
				rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
			});
			AIError.applyFinalizeResult(output, result);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/**
 * Lift the SDK's `params.config` fields out of `config` and place them where the
 * Gemini / Vertex AI REST API expects them on the request body. Mirrors the
 * generateContentParametersTo{Mldev,Vertex} transformation in @google/genai
 * for the subset of fields this codebase actually sets.
 *
 * `abortSignal` is intentionally dropped — the SDK propagates it via `fetch.signal`,
 * which our caller already wires up through `options.signal`.
 */
function paramsToWireBody(params: GenerateContentParameters): Record<string, unknown> {
	const body: Record<string, unknown> = { contents: params.contents };
	const config = params.config;
	if (!config) return body;

	if (config.systemInstruction !== undefined) body.systemInstruction = config.systemInstruction;
	if (config.tools !== undefined) body.tools = config.tools;
	if (config.toolConfig !== undefined) body.toolConfig = config.toolConfig;
	if (config.safetySettings !== undefined) body.safetySettings = config.safetySettings;
	if (config.cachedContent !== undefined) body.cachedContent = config.cachedContent;
	if (config.serviceTier !== undefined) body.serviceTier = config.serviceTier;

	const gen: Record<string, unknown> = {};
	if (config.temperature !== undefined) gen.temperature = config.temperature;
	if (config.maxOutputTokens !== undefined) gen.maxOutputTokens = config.maxOutputTokens;
	if (config.topP !== undefined) gen.topP = config.topP;
	if (config.topK !== undefined) gen.topK = config.topK;
	if (config.candidateCount !== undefined) gen.candidateCount = config.candidateCount;
	if (config.stopSequences !== undefined) gen.stopSequences = config.stopSequences;
	if (config.presencePenalty !== undefined) gen.presencePenalty = config.presencePenalty;
	if (config.frequencyPenalty !== undefined) gen.frequencyPenalty = config.frequencyPenalty;
	if (config.seed !== undefined) gen.seed = config.seed;
	if (config.responseMimeType !== undefined) gen.responseMimeType = config.responseMimeType;
	if (config.responseSchema !== undefined) gen.responseSchema = config.responseSchema;
	if (config.responseJsonSchema !== undefined) gen.responseJsonSchema = config.responseJsonSchema;
	if (config.responseModalities !== undefined) gen.responseModalities = config.responseModalities;
	if (config.thinkingConfig !== undefined) gen.thinkingConfig = config.thinkingConfig;
	if (Object.keys(gen).length > 0) body.generationConfig = gen;
	return body;
}

/**
 * Pull the human-readable detail out of a Google error body, bounded.
 *
 * A non-2xx body is not always a Google error envelope. A corporate proxy, a
 * captive portal, or a CDN interstitial in front of
 * `generativelanguage.googleapis.com` answers with an HTML page, and the whole
 * page used to become the message: rendered in the TUI, written to the session
 * file, and replayed on every later read of that turn. The ceiling now lives in
 * `error/detail-bounds`, shared with every other provider that interpolates a
 * response body, because the per-site caps had drifted to four different
 * numbers and three of them were "none".
 */
export function extractGoogleErrorMessage(errorText: string | AIError.ProviderErrorBody, status?: number): string {
	const body = typeof errorText === "string" ? undefined : errorText;
	const text = typeof errorText === "string" ? errorText : errorText.text;
	if (!text) return body?.detail || "Unknown error";
	try {
		const parsed = JSON.parse(text) as {
			error?: { message?: string; status?: string; details?: unknown[] };
		};
		const error = parsed.error;
		if (!error?.message) return body?.detail ?? AIError.boundProviderErrorDetail(text);
		const message = AIError.boundProviderErrorDetail(error.message);
		if (!AIError.isUsageLimitStatus(status) || (error.status === undefined && error.details === undefined)) return message;
		return AIError.boundProviderErrorDetail(
			`${message} ${JSON.stringify({ error: { status: error.status, details: error.details } })}`,
		);
	} catch {
		return body?.detail ?? AIError.boundProviderErrorDetail(text);
	}
}

export { convertMessages as convertGoogleMessages };
