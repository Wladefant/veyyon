import { isRecord } from "@veyyon/utils/type-guards";

/**
 * Public web search behind an admission token and a per-user budget.
 *
 * Order of work for one request: authorize, method, bounded body, Brave key, budget reservation, one
 * upstream attempt. The reservation is taken before the attempt and is never refunded, so a failed
 * upstream call still consumes the user's cap. There is no retry and no fallback.
 *
 * Only Web APIs are used (Request, Response, fetch, AbortSignal), so the module runs in a Worker.
 */

export const PUBLIC_SEARCH_SCOPE = "search:public" as const;

export const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const REQUEST_MAX_BYTES = 8 * 1024;
const UPSTREAM_MAX_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const QUERY_MAX_CHARS = 2048;
const RESULT_COUNT = 10;
const TITLE_MAX_CHARS = 256;
const URL_MAX_CHARS = 2048;
const SNIPPET_MAX_CHARS = 1024;

export interface PublicSearchIdentity {
	userId: string;
}

export interface BraveKey {
	apiKey: string;
	costMicrousdPerRequest: number;
}

export type PublicSearchRefusal = "minute_limit" | "month_limit" | "cost_limit" | "expired";

export type PublicSearchReservation = { allowed: true } | { allowed: false; reason: PublicSearchRefusal };

export interface PublicSearchBudget {
	reserve(userId: string, nowMs: number, costMicrousd: number): Promise<PublicSearchReservation>;
}

export type PublicSearchFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface PublicSearchDeps {
	/** Validates the identity and the admission token. Returns null when the request is not admitted. */
	authorize(request: Request, scope: typeof PUBLIC_SEARCH_SCOPE): Promise<PublicSearchIdentity | null>;
	/** Server-side only: the key is sent upstream and never returned to the caller. */
	resolveBraveKey(userId: string): Promise<BraveKey | null>;
	budget: PublicSearchBudget;
	fetch?: PublicSearchFetch;
	now?: () => number;
}

export interface PublicSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export type PublicSearchErrorCode =
	| "unauthorized"
	| "method_not_allowed"
	| "invalid_request"
	| "body_too_large"
	| "no_key"
	| "invalid_key_config"
	| "auth_unavailable"
	| "key_unavailable"
	| "budget_unavailable"
	| "upstream_failed"
	| "upstream_malformed"
	| "upstream_oversize";

const ERROR_STATUS: Record<PublicSearchErrorCode, number> = {
	unauthorized: 401,
	method_not_allowed: 405,
	invalid_request: 400,
	body_too_large: 413,
	no_key: 403,
	invalid_key_config: 503,
	auth_unavailable: 503,
	key_unavailable: 503,
	budget_unavailable: 503,
	upstream_failed: 502,
	upstream_malformed: 502,
	upstream_oversize: 502,
};

const JSON_HEADERS: HeadersInit = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Build the public search endpoint. The returned handler never throws: every failure is a Response
 * with a fixed sanitized code, so no upstream body, key or query reaches the caller.
 */
export function createPublicSearchHandler(deps: PublicSearchDeps): (request: Request) => Promise<Response> {
	const fetchUpstream: PublicSearchFetch = deps.fetch ?? fetch;
	const clock = deps.now ?? Date.now;

	return async function publicSearch(request: Request): Promise<Response> {
		let identity: PublicSearchIdentity | null;
		try {
			identity = await deps.authorize(request, PUBLIC_SEARCH_SCOPE);
		} catch {
			return errorResponse("auth_unavailable");
		}
		if (!identity?.userId) return errorResponse("unauthorized");
		if (request.method !== "POST") return errorResponse("method_not_allowed");

		let bytes: Uint8Array | null;
		try {
			bytes = await readBounded(request.body, REQUEST_MAX_BYTES);
		} catch {
			return errorResponse("invalid_request");
		}
		if (bytes === null) return errorResponse("body_too_large");
		const query = parseSearchBody(bytes);
		if (query === null) return errorResponse("invalid_request");

		let key: BraveKey | null;
		try {
			key = await deps.resolveBraveKey(identity.userId);
		} catch {
			return errorResponse("key_unavailable");
		}
		if (!key) return errorResponse("no_key");
		if (
			typeof key.apiKey !== "string" ||
			key.apiKey.trim() === "" ||
			!Number.isSafeInteger(key.costMicrousdPerRequest) ||
			key.costMicrousdPerRequest <= 0
		) {
			return errorResponse("invalid_key_config");
		}

		let reservation: PublicSearchReservation;
		try {
			reservation = await deps.budget.reserve(identity.userId, clock(), key.costMicrousdPerRequest);
		} catch {
			return errorResponse("budget_unavailable");
		}
		if (!reservation.allowed) return jsonResponse(429, { error: "quota", reason: reservation.reason });

		return searchUpstream(request, query, key.apiKey, fetchUpstream);
	};
}

/**
 * Per-user budget held in process memory. Counts are per user: 5 reservations in any rolling 60000 ms,
 * 500 per UTC calendar month and 2500000 microusd per UTC calendar month. A reservation is written
 * before its promise is returned, so concurrent callers in one process cannot overspend.
 *
 * Nothing here is persisted or shared. A restart resets every count, and each process or Worker
 * instance keeps its own counts, so a multi-instance deployment admits up to the cap per instance.
 * A durable, shared budget needs a store with an atomic compare-and-increment, which this class is not.
 */
export class InMemoryPublicSearchBudget implements PublicSearchBudget {
	readonly #expiresAt: number;
	readonly #users = new Map<string, UserUsage>();
	#lastNowMs = Number.NEGATIVE_INFINITY;

	constructor({ expiresAt }: { expiresAt: number }) {
		if (!Number.isFinite(expiresAt)) throw new RangeError("public search budget expiresAt must be finite");
		this.#expiresAt = expiresAt;
	}

	reserve(userId: string, nowMs: number, costMicrousd: number): Promise<PublicSearchReservation> {
		try {
			return Promise.resolve(this.#reserve(userId, nowMs, costMicrousd));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#reserve(userId: string, nowMs: number, costMicrousd: number): PublicSearchReservation {
		if (!Number.isSafeInteger(nowMs)) throw new RangeError("public search clock must be a safe integer");
		if (nowMs < this.#lastNowMs) throw new RangeError("public search clock moved backwards");
		if (!Number.isSafeInteger(costMicrousd) || costMicrousd <= 0) {
			throw new RangeError("public search cost must be a positive safe integer");
		}
		this.#lastNowMs = nowMs;
		if (nowMs >= this.#expiresAt) return { allowed: false, reason: "expired" };

		const month = utcMonthIndex(nowMs);
		let usage = this.#users.get(userId);
		if (!usage) {
			usage = { month, monthRequests: 0, monthSpentMicrousd: 0, recentMs: [] };
			this.#users.set(userId, usage);
		} else if (month > usage.month) {
			usage.month = month;
			usage.monthRequests = 0;
			usage.monthSpentMicrousd = 0;
		} else if (month < usage.month) {
			throw new RangeError("public search month moved backwards");
		}

		while (usage.recentMs.length > 0 && nowMs - usage.recentMs[0] >= MINUTE_MS) usage.recentMs.shift();
		if (usage.recentMs.length >= MINUTE_LIMIT) return { allowed: false, reason: "minute_limit" };
		if (usage.monthRequests >= MONTH_REQUEST_LIMIT) return { allowed: false, reason: "month_limit" };
		if (usage.monthSpentMicrousd + costMicrousd > MONTH_SPEND_LIMIT_MICROUSD) {
			return { allowed: false, reason: "cost_limit" };
		}

		usage.recentMs.push(nowMs);
		usage.monthRequests += 1;
		usage.monthSpentMicrousd += costMicrousd;
		return { allowed: true };
	}
}

const MINUTE_MS = 60_000;
const MINUTE_LIMIT = 5;
const MONTH_REQUEST_LIMIT = 500;
const MONTH_SPEND_LIMIT_MICROUSD = 2_500_000;

interface UserUsage {
	month: number;
	monthRequests: number;
	monthSpentMicrousd: number;
	/** Admitted reservation times, oldest first, only those inside the rolling minute. */
	recentMs: number[];
}

function utcMonthIndex(nowMs: number): number {
	const date = new Date(nowMs);
	return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function parseSearchBody(bytes: Uint8Array): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(UTF8.decode(bytes));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const keys = Object.keys(parsed);
	if (keys.length !== 1 || keys[0] !== "query") return null;
	const query = parsed.query;
	if (typeof query !== "string" || query.trim() === "" || query.length > QUERY_MAX_CHARS) return null;
	return query;
}

/** Read a stream, or return null as soon as it exceeds maxBytes. A null stream is an empty body. */
async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function searchUpstream(
	request: Request,
	query: string,
	apiKey: string,
	fetchUpstream: PublicSearchFetch,
): Promise<Response> {
	const url = new URL(BRAVE_WEB_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(RESULT_COUNT));
	url.searchParams.set("result_filter", "web");
	url.searchParams.set("text_decorations", "false");

	let upstream: Response;
	try {
		upstream = await fetchUpstream(url.href, {
			method: "GET",
			redirect: "error",
			headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
		});
	} catch {
		return errorResponse("upstream_failed");
	}
	if (upstream.status !== 200) {
		upstream.body?.cancel().catch(() => undefined);
		return errorResponse("upstream_failed");
	}

	let bytes: Uint8Array | null;
	try {
		bytes = await readBounded(upstream.body, UPSTREAM_MAX_BYTES);
	} catch {
		return errorResponse("upstream_failed");
	}
	if (bytes === null) return errorResponse("upstream_oversize");

	let payload: unknown;
	try {
		payload = JSON.parse(UTF8.decode(bytes));
	} catch {
		return errorResponse("upstream_malformed");
	}
	const results = mapResults(payload);
	if (results === null) return errorResponse("upstream_malformed");
	return jsonResponse(200, { results });
}

/**
 * Keep up to ten web results that carry a string title and an http(s) URL with no userinfo. A URL
 * longer than URL_MAX_CHARS once normalized is skipped, never cut, because a cut link points elsewhere.
 * other field, such as a summary or enrichment, is dropped. Returns null when the shape is wrong.
 */
function mapResults(payload: unknown): PublicSearchResult[] | null {
	if (!isRecord(payload)) return null;
	const web = payload.web;
	if (web === undefined) return [];
	if (!isRecord(web)) return null;
	const rawResults = web.results;
	if (rawResults === undefined) return [];
	if (!Array.isArray(rawResults)) return null;

	const results: PublicSearchResult[] = [];
	for (const item of rawResults) {
		if (results.length >= RESULT_COUNT) break;
		if (!isRecord(item)) continue;
		const { title, url, description } = item;
		if (typeof title !== "string" || typeof url !== "string") continue;
		const href = publicHttpUrl(url);
		if (href === null || href.length > URL_MAX_CHARS) continue;
		results.push({
			title: truncate(title, TITLE_MAX_CHARS),
			url: href,
			snippet: typeof description === "string" ? truncate(description, SNIPPET_MAX_CHARS) : "",
		});
	}
	return results;
}

function publicHttpUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username !== "" || url.password !== "") return null;
	return url.href;
}

/** Cut to max UTF-16 units, dropping a trailing high surrogate so the output stays well formed. */
function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	let cut = value.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut;
}

function errorResponse(code: PublicSearchErrorCode): Response {
	return jsonResponse(ERROR_STATUS[code], { error: code });
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
