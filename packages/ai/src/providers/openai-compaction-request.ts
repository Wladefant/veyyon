/**
 * The request half of OpenAI Responses server-side compaction: the endpoint, headers and body for the
 * official, Azure and ChatGPT Codex hosts, the call, and the window read back. `./openai-compaction`
 * resolves the transport and loads this module on the first compaction, so a session that never
 * compacts server-side does not evaluate the Responses encoder or the Codex request builder.
 */
import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { boundProviderErrorDetail, ProviderHttpError, readProviderErrorDetail } from "../error";
import type { Api, Message, Model } from "../types";
import { conversationIdForOpenCode } from "../utils/opencode-headers";
import { parseAzureDeploymentNameMap } from "./azure-deployment-names";
import {
	buildCodexCompactionV2Window,
	CODEX_COMPACTION_TRIGGER_ITEM,
	collectCodexCompactionV2Stream,
} from "./openai-codex/compaction-v2";
import { applyCodexResponsesLiteShape, resolveCodexResponsesLite } from "./openai-codex/request-transformer";
import { createOpenAICodexDirectRequest } from "./openai-codex-responses";
import {
	recordServerCompactionRouteAbsent,
	type ServerCompactionRequest,
	type ServerCompactionResult,
} from "./openai-compaction";
import type { ResponseInput } from "./openai-responses-wire";
import { buildResponsesInput, resolveOpenAIRequestSetup } from "./openai-shared";

interface CompactedResponseWire {
	id?: string;
	object?: string;
	created_at?: number;
	output?: Array<Record<string, unknown>>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** Resolve the compact endpoint and headers for the official OpenAI host family. */
function resolveOpenAiCompactRequest(
	model: Model<Api>,
	apiKey: string,
	messages: Message[],
	conversationId: string | undefined,
): { url: string; headers: Record<string, string> } {
	const setup = resolveOpenAIRequestSetup(
		{ provider: model.provider, id: model.id, baseUrl: model.baseUrl, headers: model.headers },
		{ apiKey, messages, conversationId },
	);
	const baseUrl = trimTrailingSlashes(setup.baseUrl ?? "https://api.openai.com/v1");
	return { url: `${baseUrl}/responses/compact`, headers: setup.headers };
}

/**
 * Resolve the compact endpoint and headers for Azure OpenAI. Mirrors
 * `buildAzureResponsesRequest` in azure-openai-responses.ts: a string key rides
 * as the `api-key` header, `api-version` as a query parameter, and the path is
 * not deployment-scoped — the deployment name goes in the body's `model` field.
 */
function resolveAzureCompactRequest(
	model: Model<Api>,
	apiKey: string,
): { url: string; headers: Record<string, string> } {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new ProviderHttpError("Azure OpenAI API key is required for server-side compaction.", 401);
		}
		apiKey = envKey;
	}
	const baseUrl = $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = $env.AZURE_OPENAI_RESOURCE_NAME;
	const resolvedBaseUrl =
		(baseUrl && baseUrl.length > 0 ? baseUrl : undefined) ??
		(resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : undefined) ??
		(model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : undefined);
	if (!resolvedBaseUrl) {
		throw new ProviderHttpError(
			"Azure OpenAI base URL is required for server-side compaction. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or configure model.baseUrl.",
			400,
		);
	}
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "v1";
	const headers: Record<string, string> = { "api-key": apiKey, ...(model.headers ?? {}) };
	return {
		url: `${trimTrailingSlashes(resolvedBaseUrl)}/responses/compact?api-version=${encodeURIComponent(apiVersion)}`,
		headers,
	};
}

/** Wire model id for the compact call, honoring Azure deployment mapping. */
function resolveCompactWireModel(model: Model<Api>): string {
	const requestModel = model.requestModelId ?? model.id;
	if (model.api !== "azure-openai-responses") return requestModel;
	return parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel) ?? requestModel;
}

/**
 * Encode the LLM messages of the compacted span as Responses-API input items
 * through the same encoder a live turn uses, with native-history replay on so
 * assistant turns contribute their stored provider items (encrypted reasoning
 * included) instead of a text re-encode. That fidelity is the reason to
 * compact server-side at all.
 */
function buildCompactInputItems(model: Model<Api>, messages: Message[]): ResponseInput {
	// Narrowed by resolveServerCompactionTransport: only responses-family models
	// reach this encoder, and their compat is the resolved responses record.
	const compat = model.compat as ResolvedOpenAIResponsesCompat;
	return buildResponsesInput({
		model: model as Model<"openai-responses">,
		context: { messages },
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		supportsDeveloperRole: compat.supportsDeveloperRole,
		nativeHistory: { replay: true, filterReasoning: compat.filterReasoningHistory },
		includeThinkingSignatures: !compat.filterReasoningHistory,
		repairOrphanOutputs: true,
	});
}

/**
 * Resolve the compaction endpoint and headers for the ChatGPT Codex backend.
 *
 * The route is the ordinary codex responses path
 * (`chatgpt.com/backend-api/codex/responses`), reached with the ChatGPT OAuth
 * access token and the same request identity a turn carries. There is no
 * `/compact` suffix: the host answers that path with 404, and the compaction is
 * requested by the trailing `compaction_trigger` input item instead.
 *
 * The cache key is the turn's, not a compaction-specific one: the request rides
 * the same conversation and must land on the same cached prefix.
 */
function resolveCodexCompactRequest(
	model: Model<Api>,
	apiKey: string,
	request: ServerCompactionRequest,
): { url: string; headers: Record<string, string>; clientMetadata: Record<string, string> } {
	return createOpenAICodexDirectRequest({
		model: model as Model<"openai-codex-responses">,
		accessToken: apiKey,
		requestKind: "compaction",
		sessionId: request.sessionId,
		promptCacheKey: request.promptCacheKey,
		providerSessionState: request.providerSessionState,
		compaction: request.codexCompaction,
		responsesLite: resolveCodexResponsesLite(model, undefined),
	});
}

/** Compact over the OpenAI Responses wire: the official, Azure, and ChatGPT Codex hosts. */
export async function compactOverResponsesWire(request: ServerCompactionRequest): Promise<ServerCompactionResult> {
	const { model, apiKey } = request;
	const isCodex = model.api === "openai-codex-responses";
	const resolved =
		model.api === "azure-openai-responses"
			? resolveAzureCompactRequest(model, apiKey)
			: isCodex
				? resolveCodexCompactRequest(model, apiKey, request)
				: resolveOpenAiCompactRequest(model, apiKey, request.messages, conversationIdForOpenCode(request));
	const { url, headers } = resolved;

	const input: Array<Record<string, unknown>> = [
		...(request.previousWindow ?? []),
		...(buildCompactInputItems(model, request.messages) as unknown as Array<Record<string, unknown>>),
	];

	// Body per the compact method reference: model, input, instructions. No
	// store: the official endpoint is stateless. The Codex host serves a
	// different wire and shapes its own body below.
	const body: Record<string, unknown> = {
		model: resolveCompactWireModel(model),
		input,
	};
	if (request.instructions && request.instructions.trim().length > 0) {
		body.instructions = request.instructions;
	}
	if (isCodex) {
		// The codex host has no compact route. A compaction is an ordinary
		// streaming turn whose last input item is `compaction_trigger`, which
		// makes the backend answer exactly one `compaction` output item and
		// nothing else. codex-rs does this in `core/src/compact_remote_v2.rs`.
		//
		// `stream` is not optional: a body without it is rejected with 400
		// `{"detail":"Stream must be set to true"}`, which is why the request
		// builder already sends `accept: text/event-stream`.
		//
		// The trigger is appended to `input` rather than replacing it, so the
		// span the host compacts is the span the caller asked to compact.
		input.push({ ...CODEX_COMPACTION_TRIGGER_ITEM });
		const clientMetadata = "clientMetadata" in resolved ? resolved.clientMetadata : undefined;
		if (clientMetadata) body.client_metadata = clientMetadata;
		body.stream = true;
		body.store = false;
		// A turn sends `prompt_cache_key`, so a compaction without it is a
		// cache miss on the session's own prefix, and the turn after it pays
		// full uncached input again. Same key, same lineage, one cache.
		const cacheKey = "promptCacheKey" in resolved ? resolved.promptCacheKey : undefined;
		if (cacheKey) body.prompt_cache_key = cacheKey;
		if (resolveCodexResponsesLite(model, undefined)) {
			applyCodexResponsesLiteShape(body);
			body.include = Array.from(
				new Set([
					...(Array.isArray(body.include) ? (body.include as string[]) : []),
					"reasoning.encrypted_content",
				]),
			);
		}
	}
	const applyCallerSanitizer = (text: string): string => {
		if (!request.sanitizeErrorText) return text;
		try {
			const sanitized = request.sanitizeErrorText(text);
			return typeof sanitized === "string" ? sanitized : "[redacted]";
		} catch {
			return "[redacted]";
		}
	};
	const sanitize = (text: string): string => applyCallerSanitizer(boundProviderErrorDetail(text));

	// The fence spans the body read too; a middlebox can drop the connection
	// after headers and only the armed signal interrupts the response read.
	const timeoutMs = request.timeoutMs ?? 0;
	const requestTimeout = timeoutMs > 0 ? scopedTimeoutSignal(timeoutMs, request.signal) : undefined;
	try {
		const response = await (request.fetch ?? fetch)(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: stringifyJson(body),
			signal: requestTimeout?.signal ?? request.signal,
		});

		if (!response.ok) {
			// The body is read under the shared byte ceiling, so an enormous error page is
			// never allocated whole just to be capped afterwards.
			const errorText = applyCallerSanitizer(await readProviderErrorDetail(response));
			const statusText = sanitize(response.statusText);
			// 404 answers the capability question the compat flag only
			// predicts: this model's host does not serve the route. Record
			// it so the next compaction skips the request instead of
			// repeating it once per compaction for the rest of the run.
			const routeAbsent = response.status === 404;
			if (routeAbsent) recordServerCompactionRouteAbsent(model);
			logger.warn("Server-side compaction failed", {
				url,
				provider: model.provider,
				model: model.id,
				status: response.status,
				statusText,
				errorText,
				routeAbsent,
			});
			throw new ProviderHttpError(
				routeAbsent
					? `Server-side compaction is not available for ${model.provider}/${model.id} (404 ${statusText})`
					: `Server-side compaction failed (${response.status} ${statusText})`,
				response.status,
				{ headers: response.headers },
			);
		}

		if (isCodex) {
			if (!response.body) {
				throw new Error(
					"Codex compaction returned no response body. The history was NOT compacted; the caller falls back to local compaction.",
				);
			}
			// The reader requires exactly one compaction item: zero means the
			// trigger did not take and the host ran the span as an ordinary
			// paid turn, more than one means the window is ambiguous. Either
			// way the caller compacts locally rather than storing a history
			// that does not compact.
			const stream = await collectCodexCompactionV2Stream(
				response.body,
				requestTimeout?.signal ?? request.signal,
				sanitize,
			);
			return {
				// The codex host answers `response.completed` with an empty
				// `output`, so the window is assembled here: the span's
				// retained real user messages followed by the compaction item.
				window: buildCodexCompactionV2Window(input, stream.compactionItem),
				usage: stream.usage,
			};
		}

		const data = (await response.json()) as CompactedResponseWire | undefined;
		const output = data?.output;
		if (!Array.isArray(output) || output.length === 0) {
			throw new Error(
				"Server-side compaction returned no output items. The history was NOT compacted; the caller falls back to local compaction.",
			);
		}
		// A window without a compaction item is not compacted: it would replay
		// at full size on every turn while claiming the history was reduced.
		// More than one is legitimate here and only here — the guide states the
		// compacted window may retain items from the previous window, and a
		// chained compaction retains the prior compaction item — so the JSON
		// route requires at least one where the codex stream requires exactly
		// one.
		if (
			!output.some(
				item =>
					item &&
					typeof item === "object" &&
					item.type === "compaction" &&
					typeof item.encrypted_content === "string",
			)
		) {
			throw new Error(
				"Server-side compaction returned a window with no compaction item. The history was NOT compacted; the caller falls back to local compaction.",
			);
		}
		return {
			window: output,
			usage:
				typeof data?.usage?.input_tokens === "number" || typeof data?.usage?.output_tokens === "number"
					? { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens }
					: undefined,
		};
	} finally {
		requestTimeout?.cancel();
	}
}
