import { FETCH_AVAILABLE_MODELS_PATH, RETRIEVE_USER_QUOTA_SUMMARY_PATH } from "@veyyon/catalog/discovery/antigravity";
import { ANTIGRAVITY_ENDPOINTS } from "@veyyon/catalog/provider-endpoints";
import { getAntigravityUserAgent } from "@veyyon/catalog/wire/gemini-headers";
import { DAY_MS, WEEK_MS } from "@veyyon/utils/time";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * A backend counter Antigravity meters quota against, and what the app calls it.
 *
 * There are two: Gemini, and ONE shared counter for Claude and GPT. The summary
 * endpoint says so itself — "within each group, models share a weekly limit and
 * a 5-hour limit", over a group naming "Claude Opus, Claude Sonnet, GPT-OSS" —
 * so a limit is owned by a GROUP, never by one vendor. Splitting Claude from GPT
 * invents a second pool and reports a healthy member of a spent pair as an
 * account that still has quota.
 */
interface AntigravityCounter {
	/** Segment of the limit id, and the key exhaustion checks scope by. */
	key: string;
	/** What the app calls the group, as it appears in `Usage (…)`. */
	label: string;
}

const GEMINI_COUNTER: AntigravityCounter = { key: "google", label: "Gemini" };
const CLAUDE_AND_GPT_COUNTER: AntigravityCounter = { key: "claude-gpt", label: "Claude+GPT" };
const DEFAULT_COUNTER: AntigravityCounter = { key: "default", label: "Usage" };

/** A counter this reader cannot place reports as a bare `Usage`. */

/**
 * The counter a models-listing entry draws on.
 *
 * The listing names the model's own provider, so Claude and GPT arrive under two
 * different names for the one counter they share.
 */
function counterForModelProvider(
	modelProvider: string | undefined,
	apiProvider: string | undefined,
): AntigravityCounter {
	switch (modelProvider ?? apiProvider) {
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return GEMINI_COUNTER;
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return CLAUDE_AND_GPT_COUNTER;
		default:
			return DEFAULT_COUNTER;
	}
}

/**
 * The counter a summary group reports on.
 *
 * The endpoint names the group rather than the counter, so the group's own name
 * decides: "Gemini Models" is the Google counter, and "Claude and GPT models" is
 * the shared third-party one (whose buckets are prefixed `3p-`). A group this
 * reader has never seen keeps its name as its key, so a new one appears under its
 * own label instead of merging into whatever came before it.
 */
function counterForQuotaGroup(group: AntigravityUserQuotaGroup): AntigravityCounter {
	const named = windowIdentifier(
		[group.displayName, ...(group.buckets ?? []).map(bucket => bucket.bucketId)].join(" "),
	);
	if (named.includes("gemini")) return GEMINI_COUNTER;
	if (named.includes("claude") || named.includes("gpt") || named.includes("3p")) return CLAUDE_AND_GPT_COUNTER;
	const label = group.displayName?.trim();
	if (!label) return DEFAULT_COUNTER;
	return { key: windowIdentifier(label).replace(/ /g, "-"), label };
}
interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	dailyQuotaInfos?: AntigravityQuotaInfo[];
	weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	weeklyQuotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

interface AntigravityWindowDescriptor {
	id: string;
	label: string;
	durationMs?: number;
}

/** The windows Antigravity meters: a 5-hour window, and the weekly one above it. */
const WEEKLY_WINDOW: AntigravityWindowDescriptor = { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
const FIVE_HOUR_WINDOW: AntigravityWindowDescriptor = { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS };
const DAILY_WINDOW: AntigravityWindowDescriptor = { id: "daily", label: "Daily", durationMs: DAY_MS };

/**
 * Separators in a window identifier read as spaces, so `WINDOW_7_DAY`, `7-day`
 * and `7 day` are one token and `gemini-5h` is seen to contain `5h`.
 */
function windowIdentifier(value: string | undefined): string {
	return (value ?? "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Whether `identifier` names a window with one of `tokens`, as a whole token.
 *
 * A SUBSTRING TEST IS NOT ENOUGH, and it is what this used to do: `day`
 * anywhere in an identifier put that window on the daily clock, which is how a
 * 5-hour Gemini window came to be reported as a 24-hour `Daily` one. A token has
 * to stand alone between non-alphanumerics.
 */
function namesWindow(identifier: string, ...tokens: string[]): boolean {
	return tokens.some(token => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(identifier));
}

/**
 * The window an upstream identifier names.
 *
 * `id` is the value the API uses for the window: the summary endpoint's own
 * `window` (`weekly`, `5h`), a `quotaInfoByWindow` key (`WINDOW_7_DAY`), or the
 * field a models-listing entry arrived in (`dailyQuotaInfo`, `weeklyQuotaInfo`).
 * A free-form label stands in only when there is no identifier at all, so
 * upstream prose can never decide the window. An identifier this reader does not
 * know still names a window, and is kept under its own name rather than dropped.
 */
function classifyWindow(id: string | undefined, label: string | undefined): AntigravityWindowDescriptor | undefined {
	const identifier = windowIdentifier(id) || windowIdentifier(label);
	if (!identifier) return undefined;
	if (namesWindow(identifier, "week", "weekly", "7d", "7 day", "7day")) return WEEKLY_WINDOW;
	if (namesWindow(identifier, "5h", "5 hour", "5hour", "five hour", "fivehour")) return FIVE_HOUR_WINDOW;
	if (namesWindow(identifier, "day", "daily", "1d", "1 day", "24h", "24 hour")) return DAILY_WINDOW;
	return { id: identifier, label: (label ?? id ?? identifier).trim() };
}

function parseResetTime(info: { resetTime?: string }): number | undefined {
	const resetAt = info.resetTime ? Date.parse(info.resetTime) : undefined;
	return resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined;
}

/**
 * The window an unlabelled quota entry reports, read off its reset time.
 *
 * A models-listing entry carries no window field, so a reset hours away is the
 * 5-hour window and one days away is the weekly window. The weekly window is the
 * only one that resets more than a day out, so the 5-hour window takes the rest.
 */
function inferWindowFromReset(resetAt: number | undefined, nowMs: number): AntigravityWindowDescriptor {
	if (resetAt !== undefined && resetAt - nowMs > DAY_MS) return WEEKLY_WINDOW;
	return FIVE_HOUR_WINDOW;
}
export interface AntigravityUserQuotaBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	resetTime?: string;
	description?: string;
	remainingFraction?: number;
	disabled?: boolean;
}

export interface AntigravityUserQuotaGroup {
	displayName?: string;
	description?: string;
	buckets?: AntigravityUserQuotaBucket[];
}

export interface AntigravityUserQuotaSummaryResponse {
	groups?: AntigravityUserQuotaGroup[];
	description?: string;
}

function isUserQuotaSummaryResponse(data: unknown): data is AntigravityUserQuotaSummaryResponse {
	return (
		typeof data === "object" && data !== null && Array.isArray((data as AntigravityUserQuotaSummaryResponse).groups)
	);
}

function isAntigravityUsageResponse(data: unknown): data is AntigravityUsageResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as AntigravityUsageResponse).models === "object" &&
		(data as AntigravityUsageResponse).models !== null
	);
}

function reportMetadata(endpoint: string, credential: UsageFetchParams["credential"]): UsageReport["metadata"] {
	const metadata: UsageReport["metadata"] = { endpoint, projectId: credential.projectId };
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;
	return metadata;
}

/**
 * One limit per bucket the summary names: Gemini 5-hour, Gemini weekly,
 * Claude+GPT 5-hour, Claude+GPT weekly — the four windows the app draws.
 */
function buildReportFromQuotaSummary(
	data: AntigravityUserQuotaSummaryResponse,
	params: UsageFetchParams,
	credential: UsageFetchParams["credential"],
	nowMs: number,
	endpoint: string,
): UsageReport {
	const limits: UsageLimit[] = [];

	for (const group of data.groups ?? []) {
		const counter = counterForQuotaGroup(group);
		for (const bucket of group.buckets ?? []) {
			// The endpoint states the window: `window` is `weekly` or `5h`, and the
			// bucket id repeats it (`gemini-weekly`, `3p-5h`). Nothing reads prose.
			const window = classifyWindow(bucket.window, bucket.bucketId);
			if (!window) continue;
			const resetsAt = parseResetTime({ resetTime: bucket.resetTime });
			// A bucket the backend DISABLES is one whose limit does not apply: the
			// group's weekly limit is spent, so the endpoint marks the 5-hour bucket
			// disabled and leaves a stale fraction on it. Nothing can be spent
			// through that meter this week, so it reports as exhausted and carries
			// the endpoint's own sentence saying why.
			const remainingFraction =
				bucket.disabled === true
					? 0
					: (clampFraction(bucket.remainingFraction) ?? (resetsAt !== undefined ? 0 : undefined));
			const limit: UsageLimit = {
				id: `${params.provider}:${counter.key}:default:${window.id}`,
				label: counter.key === DEFAULT_COUNTER.key ? DEFAULT_COUNTER.label : `Usage (${counter.label})`,
				scope: {
					provider: params.provider,
					accountId: credential.accountId,
					projectId: credential.projectId,
					windowId: window.id,
					// Claude and GPT draw on this one counter together, so a reader must
					// not count it once per vendor.
					...(counter.key === CLAUDE_AND_GPT_COUNTER.key ? { shared: true } : {}),
				},
				window: {
					id: window.id,
					label: window.label,
					...(window.durationMs !== undefined ? { durationMs: window.durationMs } : {}),
					...(resetsAt !== undefined ? { resetsAt } : {}),
				},
				amount: buildAmount(remainingFraction),
				status: getUsageStatus(remainingFraction),
			};
			if (bucket.description) limit.notes = [bucket.description];
			limits.push(limit);
		}
	}

	// Most-pressured first: `antigravityRankingStrategy` reads index 0 as the
	// bottleneck when it picks between two accounts of this provider.
	limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));

	return {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: reportMetadata(endpoint, credential),
		raw: data,
	};
}

/**
 * The limits a models-listing response reports.
 *
 * Quota is shared across the models of one counter, tier and window, so entries
 * collapse onto those three. The listing names no weekly bucket at all, which is
 * what makes it the fallback: a window it never names is read off the reset time.
 */
function buildReportFromModels(
	data: AntigravityUsageResponse,
	params: UsageFetchParams,
	credential: UsageFetchParams["credential"],
	nowMs: number,
	endpoint: string,
): UsageReport {
	const deduped = new Map<
		string,
		{
			amount: UsageAmount;
			window: UsageWindow | undefined;
			tier: string | undefined;
			tierKey: string;
			windowId: string;
			counter: AntigravityCounter;
		}
	>();

	for (const [_modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
		for (const quotaInfo of quotaInfos) {
			// An entry with only a resetTime is blocked until that reset — the shape
			// an exhausted counter returns — so it reads as 0 rather than unknown and
			// a healthy sibling counter cannot mask it during the merge below.
			const amount = buildAmount(
				clampFraction(quotaInfo.remainingFraction) ?? (quotaInfo.resetTime ? 0 : undefined),
			);
			const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
			const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
			const counter = counterForModelProvider(quotaInfo.modelProvider, quotaInfo.apiProvider);
			// Use the parsed window id when available so provider enum names like
			// WINDOW_WEEKLY normalize into the same visible `/usage` group as
			// weeklyQuotaInfo entries.
			const windowId = window?.id ?? quotaInfo.windowId ?? "default";
			const key = `${counter.key}|${tierKey}|${windowId}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, { amount, window, tier: quotaInfo.tier, tierKey, windowId, counter });
				continue;
			}
			// Merge: keep the entry with fraction data for the bar, but
			// also keep any window with a reset time so "resets in…" survives.
			const eFrac = existing.amount.remainingFraction;
			const cFrac = amount.remainingFraction;
			const eHasFrac = eFrac !== undefined;
			const cHasFrac = cFrac !== undefined;

			let bestAmount = existing.amount;
			let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
			let bestTier = existing.tier ?? quotaInfo.tier;

			if (!eHasFrac && cHasFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			}
			// Always merge in window with reset time if the current
			// best doesn't have one.
			if (!bestWindow?.resetsAt && window?.resetsAt) {
				bestWindow = window;
			}
			deduped.set(key, {
				amount: bestAmount,
				window: bestWindow,
				tier: bestTier,
				tierKey: existing.tierKey,
				windowId: existing.windowId,
				counter: existing.counter,
			});
		}
	}

	const limits: UsageLimit[] = [];
	for (const entry of deduped.values()) {
		limits.push({
			id: `${params.provider}:${entry.counter.key}:${entry.tierKey}:${entry.windowId}`,
			label: entry.counter.key === DEFAULT_COUNTER.key ? DEFAULT_COUNTER.label : `Usage (${entry.counter.label})`,
			scope: {
				provider: params.provider,
				accountId: credential.accountId,
				projectId: credential.projectId,
				tier: entry.tier,
				windowId: entry.windowId,
				...(entry.counter.key === CLAUDE_AND_GPT_COUNTER.key ? { shared: true } : {}),
			},
			window: entry.window,
			amount: entry.amount,
			status: getUsageStatus(entry.amount.remainingFraction),
		});
	}

	// Most-pressured first, as in the summary path above: the ranking strategy
	// reads index 0 as the bottleneck.
	limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));

	return {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: reportMetadata(endpoint, credential),
		raw: data,
	};
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
	return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
	quotaInfos: AntigravityQuotaInfo[],
	nowMs: number,
): WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor> {
	const descriptors = new WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor>();
	const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

	for (const info of quotaInfos) {
		const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
		if (explicitDescriptor) {
			descriptors.set(info, explicitDescriptor);
			continue;
		}
		const group = groups.get(quotaInferenceKey(info)) ?? [];
		group.push({ info, resetAt: parseResetTime(info) });
		groups.set(quotaInferenceKey(info), group);
	}

	for (const group of groups.values()) {
		const resetTimes = Array.from(
			new Set(group.map(entry => entry.resetAt).filter(resetAt => resetAt !== undefined)),
		).sort((a, b) => a - b);
		const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
		for (const entry of group) {
			const descriptor =
				latestReset !== undefined && entry.resetAt === latestReset
					? { id: "weekly", label: "Weekly", durationMs: WEEK_MS }
					: inferWindowFromReset(entry.resetAt, nowMs);
			descriptors.set(entry.info, descriptor);
		}
	}

	return descriptors;
}

function withWindowDescriptor(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): AntigravityQuotaInfo {
	if (!descriptor) return info;
	return {
		...info,
		windowId: info.windowId ?? descriptor.id,
		windowLabel: info.windowLabel ?? descriptor.label,
	};
}

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): UsageWindow | undefined {
	const resetAt = parseResetTime(info);
	const hasResetAt = resetAt !== undefined;
	if (!descriptor && !hasResetAt) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
		...(hasResetAt ? { resetsAt: resetAt } : {}),
	};
}

/** A limit's amount from the fraction it has left; no amounts at all when unknown. */
function buildAmount(remainingFraction: number | undefined): UsageAmount {
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: AntigravityWindowDescriptor) => {
		results.push({ ...source, ...withWindowDescriptor(value, windowDescriptor), ...(tier ? { tier } : {}) });
	};
	const addValue = (
		value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined,
		tier?: string,
		windowDescriptor?: AntigravityWindowDescriptor,
	) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const entry of value) addInfo(entry, tier, windowDescriptor);
			return;
		}
		addInfo(value, tier, windowDescriptor);
	};

	addValue(info.quotaInfo);
	addValue(info.quotaInfos);
	addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
	addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
	addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
	addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			addValue(value, tier);
		}
	}

	const addWindowMap = (values?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>) => {
		if (!values) return;
		for (const [windowId, value] of Object.entries(values)) {
			addValue(value, undefined, classifyWindow(windowId, undefined));
		}
	};
	addWindowMap(info.quotaInfoByWindow);
	addWindowMap(info.quotaInfosByWindow);

	return results;
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl === undefined ? undefined : trimTrailingSlashes(params.baseUrl);
	const endpoints = baseUrl ? [baseUrl] : ANTIGRAVITY_ENDPOINTS.slice();

	// The quota summary is the provider's own account of its quota: named groups,
	// each with a 5-hour bucket and the weekly one above it, and the reset of each.
	// The models listing carries a fraction or a reset and NOTHING that names a
	// window, so it can only ever be the fallback.
	const summary = await postAntigravityCall(ctx, params, endpoints, RETRIEVE_USER_QUOTA_SUMMARY_PATH, accessToken);
	if (isUserQuotaSummaryResponse(summary?.data)) {
		const report = buildReportFromQuotaSummary(summary.data, params, credential, nowMs, summary.endpoint);
		// A summary that names no bucket must not blank out a listing that does.
		if (report.limits.length > 0) return report;
	}

	const listing = await postAntigravityCall(ctx, params, endpoints, FETCH_AVAILABLE_MODELS_PATH, accessToken);
	if (!isAntigravityUsageResponse(listing?.data)) return null;
	return buildReportFromModels(listing.data, params, credential, nowMs, listing.endpoint);
}

/**
 * POST one `/v1internal:` call, trying each endpoint in turn.
 *
 * A transient status, a transport failure, or a 200 that is not JSON (an HTML
 * error page from a proxy) moves on to the next endpoint; anything else decides
 * the call. `null` means no endpoint produced a body worth reading, which is the
 * caller's cue to fall back rather than to give up.
 */
async function postAntigravityCall(
	ctx: UsageFetchContext,
	params: UsageFetchParams,
	endpoints: readonly string[],
	path: string,
	accessToken: string,
): Promise<{ data: unknown; endpoint: string } | null> {
	let status = 0;
	for (const endpoint of endpoints) {
		let response: Response;
		try {
			response = await ctx.fetch(`${endpoint}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": getAntigravityUserAgent(),
				},
				body: JSON.stringify({ project: params.credential.projectId }),
				signal: params.signal,
			});
		} catch (error) {
			if (endpoint === endpoints[endpoints.length - 1]) throw error;
			continue;
		}

		status = response.status;
		if (!response.ok) {
			if (AIError.isTransientStatus(response.status)) continue;
			break;
		}
		try {
			return { data: JSON.parse(await response.text()), endpoint };
		} catch {
			// ignore non-json body and try next endpoint
		}
	}

	ctx.logger?.warn("Antigravity usage fetch failed", { path, status });
	return null;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};

function getAntigravityCounterKeyForModel(context: CredentialRankingContext | undefined): string | undefined {
	const modelId = context?.modelId?.toLowerCase();
	if (!modelId) return undefined;
	// Claude and GPT share ONE counter, so both families scope to the same key;
	// anything else is left unplaced rather than guessed.
	if (modelId.startsWith("claude-") || modelId.startsWith("gpt-") || modelId.startsWith("openai/")) {
		return CLAUDE_AND_GPT_COUNTER.key;
	}
	if (modelId.startsWith("gemini-") || modelId.startsWith("gemma-")) return GEMINI_COUNTER.key;
	return undefined;
}

function getAntigravityCounterLimits(report: UsageReport, counterKey: string): UsageLimit[] {
	const prefix = `${report.provider}:${counterKey}:`;
	return report.limits.filter(limit => limit.id.toLowerCase().startsWith(prefix));
}

// Exhaustion checks are only safe with a concrete backend counter. A no-model
// Antigravity credential lookup (for example image-provider discovery) must
// not turn one exhausted family into a provider-wide block.
function scopeAntigravityLimitsForModel(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context);
	if (!counterKey) return [];
	const backendLimits = getAntigravityCounterLimits(report, counterKey);
	if (backendLimits.length > 0) return backendLimits;
	return getAntigravityCounterLimits(report, "default");
}

function rankAntigravityLimits(report: UsageReport, context: CredentialRankingContext | undefined): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context);
	if (!counterKey) return report.limits;
	return scopeAntigravityLimitsForModel(report, context);
}

/**
 * Antigravity quotas are returned per backend counter — Gemini, and one shared
 * Claude+GPT counter — and each counter is metered on a 5-hour window and the
 * weekly window above it. `fetchAntigravityUsage` sorts `limits` ascending by
 * `remainingFraction`; after model-family scoping, the most-pressured relevant
 * counter/window is index 0.
 *
 * Leave `secondary` unset: AuthStorage compares secondary metrics before
 * primary metrics, which is correct for providers with a fixed short/long
 * split but wrong here. Ranking Antigravity by the bottleneck counter first
 * avoids preferring an account at 95% Gemini 5-hour / 0% Claude+GPT weekly over
 * one with healthier Gemini headroom.
 */
export const antigravityRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		return { primary: rankAntigravityLimits(report, context)[0] };
	},
	scopeLimits: scopeAntigravityLimitsForModel,
	// Always return a scope for Antigravity so missing/unknown model context
	// cannot fall through to AuthStorage's provider-wide block bucket.
	blockScope(context) {
		const counterKey = getAntigravityCounterKeyForModel(context);
		return `counter:${counterKey ?? "unknown"}`;
	},
	// Antigravity windows carry `durationMs` when the response identifies them
	// as daily/weekly. Fall back to daily for legacy unlabelled quotaInfo
	// entries from `daily-cloudcode-pa.googleapis.com`.
	windowDefaults: { primaryMs: DAY_MS, secondaryMs: DAY_MS },
};
