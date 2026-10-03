/**
 * OpenAI server-side compaction transport.
 *
 * Wire contract implemented here, from the OpenAI Compaction guide
 * (https://developers.openai.com/api/docs/guides/compaction) and the compact
 * method reference
 * (https://developers.openai.com/api/reference/resources/responses/methods/compact):
 *
 * - Request body: `{ model, input, instructions? }`. `input` is a Responses-API
 *   item array; "The window you send to /responses/compact must still fit
 *   within your model's context window."
 * - Response: `CompactedResponse { id, created_at, object: "response.compaction",
 *   output, usage }`. "The compacted window generally contains more than just
 *   the compaction item. It can also include retained items from the previous
 *   window."
 * - The compaction item `{ type: "compaction", encrypted_content }` "is opaque
 *   and not intended to be human-interpretable."
 * - "Output handling: do not prune /responses/compact output. The returned
 *   window is the canonical next context window, so pass it into your next
 *   /responses call as-is." This module therefore returns `output` verbatim;
 *   callers store and replay it untouched.
 *
 * Host support is DATA on the model row (`compat.supportsServerCompaction`,
 * resolved in `@veyyon/catalog/compat/openai`): the official OpenAI API and
 * Azure OpenAI's v1 API serve the endpoint today (Microsoft Learn documents
 * `{resource}.openai.azure.com/openai/v1/responses/compact` with the `api-key`
 * header and the deployment name as `model`). A second compatible host opts in
 * with that flag alone; a provider with a different wire shape adds a sibling
 * implementation of {@link ServerCompactionTransport}.
 *
 * The route is per host family, and they do not agree. The official and Azure
 * hosts serve `POST {base}/responses/compact` as documented above, answering
 * with one JSON document. The ChatGPT Codex backend serves no compact route at
 * all — that path, `{base}/codex/compact` and `{base}/responses/compact` each
 * answer 404 — and compacts through an input item instead: an ordinary
 * streaming `POST {base}/codex/responses` whose last input item is
 * `{ type: "compaction_trigger" }`. `./openai-codex/compaction-v2.ts` owns that
 * wire, `resolveCodexCompactRequest` in `./openai-compaction-request.ts` resolves its identity, and
 * `a-compaction-route-matches-the-host-that-serves-it.test.ts` pins both.
 *
 * That split is a live measurement, not a reading of the guide. Re-measured on
 * 2026-09-01 against a ChatGPT account on `gpt-5.6-sol` with a valid OAuth
 * token: `POST {base}/codex/responses/compact` answered `404 Not Found`, and
 * the same span sent to `POST {base}/codex/responses` with a trailing
 * `compaction_trigger` item answered `200` with exactly one `compaction` item
 * carrying a 1740-character `encrypted_content`. An earlier session read the
 * opposite and moved this module to the compact route; that shipped a wire the
 * host does not serve, so every codex compaction 404'd into a paid local pass.
 * Move the route only with a live call of your own, and move the
 * `implementation` declaration in `@veyyon/agent-core/compaction/remote-compaction`
 * in the same commit — the two are one decision.
 */

import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import type { Api, CodexCompactionRequestContext, FetchImpl, Message, Model, ProviderSessionState } from "../types";

/**
 * What a provider that compacts server-side must implement. The compaction
 * engine (`@veyyon/agent-core/compaction/remote-compaction`) talks to this
 * interface and nothing else; the next provider is a new implementation plus
 * its capability flag, never an edit to the engine.
 */
export interface ServerCompactionTransport {
	/**
	 * Compact the given conversation span on the provider and return the
	 * canonical next window. `request.previousWindow` is the window stored by
	 * the previous server-side compaction on this branch, chained in front of
	 * the new span ("The latest compaction item carries the necessary context
	 * to continue the conversation").
	 */
	compact(request: ServerCompactionRequest): Promise<ServerCompactionResult>;
}

export interface ServerCompactionRequest {
	/** The SESSION model; server-side compaction always runs on it, never on a configured compaction model. */
	model: Model<Api>;
	/** LLM messages of the span being compacted (already secret-obfuscated by the caller). */
	messages: Message[];
	/** Native window from the previous server-side compaction on this branch, for chaining. */
	previousWindow?: Array<Record<string, unknown>>;
	/** System instructions for the compaction call (the session's base system prompt). */
	instructions?: string;
	/**
	 * Live session id. Hosts that key request identity to a conversation (the
	 * ChatGPT Codex backend, which carries thread/window/turn headers) send it;
	 * the stateless official and Azure routes ignore it.
	 */
	sessionId?: string;
	/**
	 * The session's prompt cache key, when it differs from the session id. A
	 * turn keys its cache on `promptCacheKey ?? sessionId`, so a compaction that
	 * used the session id alone would open a second cache lineage for the same
	 * conversation and the next turn would re-pay full uncached input.
	 */
	promptCacheKey?: string;
	/** Provider-owned per-session transport state, for the same identity. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Canonical Codex compaction classification for this pass; ignored elsewhere. */
	codexCompaction?: CodexCompactionRequestContext;
	/** Resolved credential for this attempt (wrap in `withAuth` at the call site). */
	apiKey: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Hard ceiling for the whole call; <= 0 disables the timeout. */
	timeoutMs?: number;
	/** Redactor applied to any provider error text before it reaches logs or errors. */
	sanitizeErrorText?: (text: string) => string;
}

export interface ServerCompactionResult {
	/** Canonical next window from the provider, verbatim: retained items plus the opaque compaction item. */
	window: Array<Record<string, unknown>>;
	/** Token accounting of the compaction call itself, when the provider reports it. */
	usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Responses-API families served by the OpenAI wire shape in this module.
 * Exported so a test pins the exact set: this table and the
 * `supportsServerCompaction` host predicate are the two places server-side
 * compaction has been switched off and back on, and neither change is visible
 * in a diff that only reads the transport.
 */
export const SERVER_COMPACTION_WIRE_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * How long an observed 404 keeps a model out of server-side compaction before
 * the route is tried once more.
 *
 * A permanent latch is the wrong shape even though a 404 is a capability
 * answer. The negative is observed once, from one request, and it survives a
 * deploy that adds the route, a proxy that answers 404 while it reloads, and a
 * gateway that mis-routes one call. Every compaction after that runs LOCALLY —
 * a paid summarization pass on every compaction for the rest of the run — so a
 * single wrong negative is not a silent no-op, it is a recurring charge.
 *
 * Re-arming costs one request per model per window, which is bounded and
 * cheap; the latch it replaces was unbounded in the other direction.
 */
const ROUTE_ABSENT_REARM_MS = 30 * 60_000;

/**
 * Models whose compact route answered 404, and when. A 404 is not a transient
 * failure and not a credential problem: the route is absent for that model on
 * that host, so every later attempt costs a round trip, a warning and a
 * fallback to reach the same answer. Recording it turns the negative into data
 * discovered at run time instead of a hand-maintained predicate.
 *
 * Scope is the process, keyed by `provider/api/id`, and the value is the
 * observation time so the negative expires after {@link ROUTE_ABSENT_REARM_MS}.
 * Nothing here is persisted, so a stale negative cannot outlive the run that
 * observed it either.
 */
const routeAbsentForModel = new Map<string, number>();

function routeCacheKey(model: Model<Api>): string {
	return `${model.provider}/${model.api}/${model.id}`;
}

/** Forget every observed 404 so a test starts from the declared capability data. */
export function resetServerCompactionRouteCache(): void {
	routeAbsentForModel.clear();
}

/**
 * Whether this model's compact route was observed absent recently enough to
 * still be believed, so {@link resolveServerCompactionTransport} resolves
 * undefined for a model whose capability data still says it is supported.
 *
 * The caller needs the two cases apart. A model that never supported
 * server-side compaction is INERT: the setting does not apply to it and saying
 * so on every compaction would be noise. A model that supported it until a 404
 * took it away is a DOWNGRADE the operator chose the opposite of, and the only
 * evidence used to be one warning on the first compaction of each process,
 * after which every later compaction ran locally in silence.
 *
 * Reading is what expires the entry, so the negative cannot outlive its window
 * even if no compaction happens for hours.
 */
export function serverCompactionRouteAbsent(model: Model<Api>): boolean {
	const key = routeCacheKey(model);
	const observedAt = routeAbsentForModel.get(key);
	if (observedAt === undefined) return false;
	if (Date.now() - observedAt < ROUTE_ABSENT_REARM_MS) return true;
	routeAbsentForModel.delete(key);
	return false;
}

/**
 * Resolve the server-side compaction transport for a model, or undefined when
 * the model cannot compact server-side. Support is the compat DATA flag, not
 * a provider-name check: `supportsServerCompaction` is resolved per host at
 * model build time and can be flipped per row by config or discovery. A model
 * whose route already answered 404 in this process resolves undefined too, so
 * the caller goes straight to local compaction without asking again.
 */
export function resolveServerCompactionTransport(model: Model<Api>): ServerCompactionTransport | undefined {
	if (!SERVER_COMPACTION_WIRE_APIS[model.api]) return undefined;
	// Narrowed by the api gate above: every responses-family model carries the
	// resolved responses compat record.
	const compat = model.compat as ResolvedOpenAIResponsesCompat;
	if (compat.supportsServerCompaction !== true) return undefined;
	if (serverCompactionRouteAbsent(model)) return undefined;
	return openAIResponsesServerCompaction;
}

/**
 * Record that this model's compact route answered 404, so {@link resolveServerCompactionTransport}
 * resolves undefined for it until {@link ROUTE_ABSENT_REARM_MS} has passed.
 */
export function recordServerCompactionRouteAbsent(model: Model<Api>): void {
	routeAbsentForModel.set(routeCacheKey(model), Date.now());
}

/**
 * The OpenAI Responses server-side compaction transport (official, Azure, and ChatGPT Codex hosts).
 * The request implementation, which encodes the span through the Responses encoder and builds the
 * Codex request identity, loads on the first compaction.
 */
export const openAIResponsesServerCompaction: ServerCompactionTransport = {
	async compact(request: ServerCompactionRequest): Promise<ServerCompactionResult> {
		const { compactOverResponsesWire } = await import("./openai-compaction-request");
		return compactOverResponsesWire(request);
	},
};
