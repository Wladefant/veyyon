/**
 * Model discovery for the local `codex-chatgpt-web` Responses bridge.
 *
 * WHY THIS IS NOT `./codex.ts`. The bridge is a loopback daemon that proxies
 * the real Codex backend and ADDS its own browser-backed rows. Its
 * `GET {base}/models` answer is therefore the native Codex catalog plus a
 * handful of `chatgpt-web/...` slugs, and only the second group is served by
 * the browser. Reading that response with `fetchCodexModels` would hand every
 * native Codex row a second provider identity, which is precisely the "one
 * upstream model under two providers" ambiguity `identity/priority.ts` exists
 * to resolve; it would also silently move the official `openai-codex` provider
 * onto a local port. This reader keeps the two apart by construction: it
 * returns ONLY the `chatgpt-web/` slugs and never a native row.
 *
 * WHAT IS TRUTHFUL HERE AND WHAT IS NOT. Every field below is copied from the
 * daemon's own answer or left absent:
 *
 * - The model set comes from the daemon, which gates rows on the authenticated
 *   account's real capabilities (`availableChatGptWebModelRoutes`: Luna-only
 *   accounts get one row, non-Pro accounts lose `extra-high`/`pro`). No slug is
 *   declared locally, so an unauthenticated or Luna-only account cannot be
 *   shown a Pro row.
 * - The effort ladder is the single `supported_reasoning_levels` entry the
 *   daemon publishes per row, never an identity-derived ladder. Each routed
 *   slug IS one fixed ChatGPT mode; the daemon overwrites the requested effort
 *   with the slug's own (`routeChatGptWebRequest`), so a wider ladder would be
 *   a menu of choices that do nothing.
 * - `supportsTools: false` unless `GET {base}/healthz` reports `mode: "full"`.
 *   Local tool calls only reach the client when the daemon's connector harness
 *   is configured (`localToolsEnabled = mode === "full"`); in browser-only mode
 *   the row is a text/reasoning oracle and advertising tools would offer a
 *   capability the turn cannot deliver.
 * - `preferWebsockets` is pinned to `false`. The daemon answers
 *   `GET /v1/responses` with HTTP 426 ("Responses WebSocket transport is not
 *   enabled on this local route"), the Codex transport treats an ABSENT
 *   preference as "try the upgrade", and the routed rows inherit
 *   `prefer_websockets` from the native template they are cloned from — so
 *   leaving the field alone would spend a failed upgrade and a fallback on
 *   every session.
 * - `maxTokens` is `null`. The daemon publishes no output cap and the Codex
 *   transport never sends one anyway; a number here would be invented.
 * - Pricing is `"unknown"`, not free. This route bills against a ChatGPT
 *   subscription, and the endpoint publishes no per-token figures.
 *
 * LOOPBACK IS A HARD REFUSAL, NOT A DEFAULT. Discovery forwards the caller's
 * ChatGPT/Codex bearer, because the daemon proxies `/models` upstream with the
 * incoming `Authorization` header (`forwardNativeCodexRequest` refuses without
 * it). That makes the base URL a place a real credential is sent, so a
 * non-loopback host is rejected before any request is made rather than dialed.
 * `hasLocalLoopbackBaseUrl` is deliberately NOT reused: it answers "is this
 * host on my network", which is true of every RFC1918 address and of
 * `0.0.0.0`, and the daemon itself refuses to bind anything but `127.0.0.1`.
 */
import { errorMessage } from "@veyyon/utils/type-guards";
import { normalizeBaseUrl } from "@veyyon/utils/url";
import { type } from "arktype";
import { Effort } from "../effort";
import { CHATGPT_WEB_LOCAL_ENDPOINT } from "../provider-endpoints";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import type { DiscoveryFailure, DiscoveryHooks } from "./failure";

/** Slug prefix the daemon gives every browser-backed row (`chatgpt-web-models.ts`). */
export const CHATGPT_WEB_MODEL_ID_PREFIX = "chatgpt-web/";

/** Veyyon provider id for the local bridge. Distinct from `openai-codex`, which stays on OpenAI's host. */
export const CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";

const MODELS_PATH = "/models";
const HEALTH_PATH = "/healthz";

/**
 * The daemon's own runtime modes (`RuntimeMode` in its `config.ts`).
 * `full` is the only one in which a browser turn can call a local tool.
 */
export type ChatGptWebDaemonMode = "browser-only" | "full";

const healthSchema = type({
	"service?": "unknown",
	"mode?": "unknown",
	"accepting_turns?": "unknown",
});

const reasoningLevelSchema = type({
	"effort?": "unknown",
	"description?": "unknown",
});

const modelEntrySchema = type({
	"slug?": "unknown",
	"display_name?": "unknown",
	"description?": "unknown",
	"context_window?": "unknown",
	"default_reasoning_level?": "unknown",
	"supported_reasoning_levels?": "unknown",
	"input_modalities?": "unknown",
	"priority?": "unknown",
});

const modelsResponseSchema = type({
	"models?": "unknown[]",
});

/** Fetch options for local `codex-chatgpt-web` model discovery. */
export interface ChatGptWebModelDiscoveryOptions {
	/**
	 * ChatGPT/Codex OAuth access token, forwarded as `Authorization: Bearer ...`.
	 * The daemon proxies `/models` to OpenAI with this header and refuses the
	 * request without it, so discovery cannot run unauthenticated.
	 */
	accessToken: string;
	/** Daemon base URL. Defaults to {@link CHATGPT_WEB_LOCAL_ENDPOINT}. Must be loopback. */
	baseUrl?: string;
	/** Provider id stamped on every returned spec. Defaults to {@link CHATGPT_WEB_PROVIDER_ID}. */
	providerId?: string;
	/** Abort signal for network request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetchFn?: FetchImpl;
	/** Reason channel for a `null` result; never called on success. */
	onFailure?: DiscoveryHooks["onFailure"];
}

/** Normalized local-bridge discovery response. */
export interface ChatGptWebModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	/**
	 * Runtime mode `/healthz` reported, or `undefined` when the probe did not
	 * answer. Absent is treated exactly like `browser-only` for tool support:
	 * Full mode has to be proven, never assumed.
	 */
	mode?: ChatGptWebDaemonMode;
}

/**
 * True only for a host that resolves to this machine's loopback interface.
 *
 * Not `hasLocalLoopbackBaseUrl`: that predicate answers the broader "is this
 * host on my network" (RFC1918, `.local`, and `0.0.0.0`) and is used to decide
 * whether prefix KV-cache reuse can engage. Here the answer gates whether a
 * ChatGPT credential leaves the machine, so a LAN address must fail.
 */
export function isChatGptWebLoopbackUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost") return true;
	if (hostname === "::1" || hostname === "[::1]") return true;
	// 127.0.0.0/8 in full: the daemon binds 127.0.0.1, but a proxy or an
	// operator may legitimately reach it on another address in the loopback
	// block, and every address in it is non-routable. The octet ceiling is
	// checked because `127.999.0.1` matches the digit shape and is not an
	// address at all.
	if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
	return hostname.split(".").every(part => Number(part) <= 255);
}

/**
 * Wire effort → Veyyon {@link Effort}.
 *
 * The daemon publishes `ChatGptWebCodexEffort` (`low|medium|high|xhigh|ultra`)
 * in `default_reasoning_level`, while its own adapter binds the `ultra` route to
 * ChatGPT Pro under the name `max` (`CHATGPT_WEB_MODEL_ROUTES`: the Pro row is
 * `codexEffort: "ultra"`, `adapterEffort: "max"`). `max` is the top of Veyyon's
 * ladder, so that one rename is the whole mapping. An unrecognized value is
 * `undefined` rather than a guess: the row then carries no effort ladder instead
 * of a wrong one.
 */
function toEffort(wireEffort: string): Effort | undefined {
	switch (wireEffort) {
		case "low":
			return Effort.Low;
		case "medium":
			return Effort.Medium;
		case "high":
			return Effort.High;
		case "xhigh":
			return Effort.XHigh;
		case "ultra":
		case "max":
			return Effort.Max;
		default:
			return undefined;
	}
}

/**
 * Fetch the browser-backed rows the local bridge serves, normalized for the
 * model manager.
 *
 * Returns `null` when the daemon could not be asked (non-loopback base URL,
 * connection refused, non-ok status, unreadable body, unrecognized payload) and
 * `{ models: [] }` when it answered with no `chatgpt-web/` rows — which is what
 * a Codex backend reached through some other proxy looks like, and is a
 * different fact from "the bridge is not running".
 */
export async function fetchChatGptWebModels(
	options: ChatGptWebModelDiscoveryOptions,
): Promise<ChatGptWebModelDiscoveryResult | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl, CHATGPT_WEB_LOCAL_ENDPOINT);
	const report = (stage: DiscoveryFailure["stage"], url: string, detail: string): void =>
		options.onFailure?.({ stage, url, detail });

	if (!isChatGptWebLoopbackUrl(baseUrl)) {
		report(
			"base-url",
			baseUrl,
			"codex-chatgpt-web discovery forwards the ChatGPT credential to this host, so it must be loopback"
				+ " (127.0.0.0/8, localhost, or ::1); the daemon itself binds 127.0.0.1 only",
		);
		return null;
	}
	if (!options.accessToken || options.accessToken.trim().length === 0) {
		report(
			"status",
			`${baseUrl}${MODELS_PATH}`,
			"codex-chatgpt-web proxies /models to OpenAI with the incoming bearer and refuses the request"
				+ " without one; sign in to ChatGPT/Codex first",
		);
		return null;
	}

	const fetchFn = discoveryFetch(options.fetchFn);
	const headers = new Headers({
		Authorization: `Bearer ${options.accessToken}`,
		accept: "application/json",
	});

	// Probed before the catalog so a row is never published with an
	// unsubstantiated tool capability. A failed probe is not a discovery
	// failure: it only means Full mode was not proven.
	const mode = await probeDaemonMode(fetchFn, baseUrl, options.signal);

	const modelsUrl = `${baseUrl}${MODELS_PATH}`;
	let response: Response;
	try {
		response = await fetchFn(modelsUrl, { method: "GET", headers, signal: options.signal });
	} catch (error) {
		report("request", modelsUrl, errorMessage(error));
		return null;
	}
	if (!response.ok) {
		report("status", modelsUrl, `HTTP ${response.status} ${response.statusText}`.trim());
		return null;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		report("body", modelsUrl, `response is not JSON: ${errorMessage(error)}`);
		return null;
	}

	const parsed = modelsResponseSchema(payload);
	if (parsed instanceof type.errors || !Array.isArray(parsed.models)) {
		report("payload", modelsUrl, "response holds no codex model list this reader recognizes");
		return null;
	}

	const providerId = options.providerId ?? CHATGPT_WEB_PROVIDER_ID;
	const ranked: { model: ModelSpec<"openai-codex-responses">; priority: number }[] = [];
	for (const entry of parsed.models) {
		const model = normalizeEntry(entry, baseUrl, providerId, mode);
		if (model) ranked.push(model);
	}
	ranked.sort((left, right) => {
		if (left.priority !== right.priority) return left.priority - right.priority;
		return left.model.id.localeCompare(right.model.id);
	});

	return mode === undefined
		? { models: ranked.map(item => item.model) }
		: { models: ranked.map(item => item.model), mode };
}

/**
 * Read `mode` from `/healthz`, or `undefined` when the daemon did not say.
 *
 * Deliberately silent on failure. `/healthz` decides only whether tool support
 * may be advertised, and reporting a discovery failure for it would blame the
 * catalog on a probe whose absence has a defined, safe meaning.
 */
async function probeDaemonMode(
	fetchFn: FetchImpl,
	baseUrl: string,
	signal: AbortSignal | undefined,
): Promise<ChatGptWebDaemonMode | undefined> {
	// `/healthz` is served at the daemon root, one level above the `/v1` base
	// the Responses routes live under.
	let healthUrl: string;
	try {
		healthUrl = new URL(HEALTH_PATH, baseUrl).toString();
	} catch {
		return undefined;
	}
	let response: Response;
	try {
		response = await fetchFn(healthUrl, { method: "GET", headers: { accept: "application/json" }, signal });
	} catch {
		return undefined;
	}
	if (!response.ok) return undefined;
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return undefined;
	}
	const parsed = healthSchema(payload);
	if (parsed instanceof type.errors) return undefined;
	if (parsed.service !== "codex-chatgpt-web") return undefined;
	if (parsed.mode === "full") return "full";
	if (parsed.mode === "browser-only") return "browser-only";
	return undefined;
}

function normalizeEntry(
	entry: unknown,
	baseUrl: string,
	providerId: string,
	mode: ChatGptWebDaemonMode | undefined,
): { model: ModelSpec<"openai-codex-responses">; priority: number } | null {
	const parsed = modelEntrySchema(entry);
	if (parsed instanceof type.errors) return null;

	const slug = nonEmptyString(parsed.slug);
	// The one filter that keeps the official provider intact: a native Codex row
	// belongs to `openai-codex` on OpenAI's host and must never be republished
	// here under a loopback base URL.
	if (!slug || !slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) return null;

	const thinking = resolveThinking(parsed.default_reasoning_level, parsed.supported_reasoning_levels);
	const priority = typeof parsed.priority === "number" && Number.isFinite(parsed.priority)
		? parsed.priority
		: Number.MAX_SAFE_INTEGER;
	const reportedWindow = parsed.context_window;
	const contextWindow = typeof reportedWindow === "number"
		&& Number.isSafeInteger(reportedWindow)
		&& reportedWindow > 0
		? reportedWindow
		: null;

	return {
		priority,
		model: {
			id: slug,
			name: nonEmptyString(parsed.display_name) ?? slug,
			api: "openai-codex-responses",
			provider: providerId,
			// The Codex transport resolves the request URL from this value, and it
			// already names the daemon's Responses route: the bridge serves
			// `POST {base}/responses`, not OpenAI's `{base}/codex/responses`.
			baseUrl: `${baseUrl}/responses`,
			reasoning: thinking !== undefined,
			input: normalizeInput(parsed.input_modalities),
			// Explicitly off, not merely unset: the Codex transport treats an
			// absent preference as "try the upgrade", and this route answers
			// `GET /v1/responses` with HTTP 426. The routed rows also inherit
			// `prefer_websockets` from the native template they are cloned from,
			// so the field is never read from the payload here.
			preferWebsockets: false,
			// Proven Full mode is the only thing that lets a browser turn reach a
			// local tool. Unknown counts as browser-only.
			...(mode === "full" ? {} : { supportsTools: false }),
			// This endpoint publishes no pricing, and the turn bills against a
			// ChatGPT subscription. Zeros mean "not told", never "free".
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			pricing: "unknown",
			contextWindow,
			// The daemon publishes no output cap, and the Codex transport strips
			// `max_output_tokens` regardless.
			maxTokens: null,
			...(thinking ? { thinking } : {}),
			...(priority !== Number.MAX_SAFE_INTEGER ? { priority } : {}),
		},
	};
}

/**
 * Build the effort ladder from `supported_reasoning_levels`, which the daemon
 * populates with exactly one entry per routed row.
 *
 * A row whose published levels map to nothing Veyyon knows gets no ladder and
 * `reasoning: false`, rather than a ladder assembled from the model id.
 */
function resolveThinking(defaultLevel: unknown, supportedLevels: unknown): ThinkingConfig | undefined {
	const efforts: Effort[] = [];
	if (Array.isArray(supportedLevels)) {
		for (const level of supportedLevels) {
			const parsed = reasoningLevelSchema(level);
			if (parsed instanceof type.errors) continue;
			const wire = nonEmptyString(parsed.effort);
			const effort = wire ? toEffort(wire.toLowerCase()) : undefined;
			if (effort && !efforts.includes(effort)) efforts.push(effort);
		}
	}
	const declaredDefault = nonEmptyString(defaultLevel);
	const fallback = declaredDefault ? toEffort(declaredDefault.toLowerCase()) : undefined;
	if (efforts.length === 0 && fallback) efforts.push(fallback);
	if (efforts.length === 0) return undefined;
	const defaultEffort = fallback && efforts.includes(fallback) ? fallback : efforts[0]!;
	return { mode: "effort", efforts, defaultLevel: defaultEffort };
}

function normalizeInput(inputModalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(inputModalities)) return ["text"];
	const seen = new Set<"text" | "image">();
	for (const modality of inputModalities) {
		const normalized = nonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image") seen.add(normalized);
	}
	if (seen.size === 0) return ["text"];
	return (["text", "image"] as const).filter(modality => seen.has(modality));
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
