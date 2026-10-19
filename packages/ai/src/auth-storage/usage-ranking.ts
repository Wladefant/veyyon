/**
 * Candidate ordering by usage: the parallel usage fetch under one deadline, window drain, plan
 * eligibility, blocks, and the account the caller chose.
 */

import { clamp01 } from "@veyyon/utils/math";
import type { CredentialRankingContext, CredentialRankingStrategy, UsageLimit, UsageReport } from "../usage";
import type { CredentialBlocks } from "./credential-blocks";
import { DEFAULT_CREDENTIAL_BACKOFF_MS } from "./credential-blocks";
import type { ApiKeySelection, AuthApiKeyOptions, CredentialSelection, OAuthSelection } from "./credentials";
import type { OpenAICodexPlanRequirement } from "./openai-codex-plan";
import { getOpenAICodexPlanPriority } from "./openai-codex-plan";
import type { ApiKeyCredential, AuthCredential, OAuthCredential } from "./types";
import type { UsageReporting } from "./usage-reporting";
import { getScopedUsageLimits, getUsageResetAtMs, isUsageLimitReached } from "./usage-reports";

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

export type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
	allowanceSpent?: boolean;
};

export type OAuthCandidate = UsageCandidate<OAuthCredential>;
export type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
export type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & { blockedUntil: number | undefined };

export type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	usageMeasured: boolean;
	hasPriorityBoost: boolean;
	allowanceSpent?: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};

function resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
	if (!window) return undefined;
	if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		return window.resetsAt;
	}
	return undefined;
}

export function normalizeUsageFraction(limit: UsageLimit | undefined): number {
	const usedFraction = limit?.amount.usedFraction;
	if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
		return 0.5;
	}
	return clamp01(usedFraction);
}

/**
 * Computes the required drain rate: `headroomFraction / remainingHours` —
 * how fast the window's remaining quota must be consumed to fully use it
 * before it resets and expires. Higher = more headroom at risk of expiring
 * unused = ranked first, so selection chases quota that is about to be
 * wasted ("use it or lose it"). Without a reset clock the headroom
 * fraction alone is returned, degrading to most-headroom-first.
 */
export function computeWindowRequiredDrain(
	limit: UsageLimit | undefined,
	nowMs: number,
	fallbackDurationMs: number,
): number {
	const headroom = 1 - normalizeUsageFraction(limit);
	if (headroom <= 0) return 0;
	const resetAt = resolveWindowResetAt(limit?.window);
	if (resetAt === undefined) return headroom;
	const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
	let remainingMs = resetAt - nowMs;
	if (Number.isFinite(durationMs) && durationMs > 0) {
		remainingMs = Math.min(remainingMs, durationMs);
	}
	// Floor at one minute: a stale report whose reset already passed must
	// not produce an unbounded urgency score.
	const remainingHours = Math.max(remainingMs, 60_000) / (60 * 60 * 1000);
	return headroom / remainingHours;
}

function compareUsageRankedCandidatePriority(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planRequirement: OpenAICodexPlanRequirement,
): number {
	if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
	if (left.blocked && right.blocked) {
		const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
		const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
		if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
		return 0;
	}
	if (planRequirement !== "none" && left.planPriority !== right.planPriority) {
		return left.planPriority - right.planPriority;
	}
	// Paid overage (Codex credits) never renews, so an account serving past its
	// allowance yields to any sibling whose renewable allowance is left (#13889).
	if (Boolean(left.allowanceSpent) !== Boolean(right.allowanceSpent)) {
		return left.allowanceSpent ? 1 : -1;
	}
	if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
	// Short-window guard: candidates whose primary (e.g. 5h) window is
	// nearly exhausted rank behind cool ones regardless of drain urgency —
	// overflow lands on the next-most-urgent cool account instead.
	const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	if (leftHot !== rightHot) return leftHot ? 1 : -1;
	// Usage-backed candidates outrank unmeasured ones: required-drain
	// scores are only comparable between measured windows, and the
	// clockless headroom fallback (0..1) must not let an account whose
	// usage fetch failed shadow a measured sibling.
	const leftMeasured = left.usageMeasured;
	const rightMeasured = right.usageMeasured;
	if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
	// Required drain, descending: the account whose remaining quota must
	// burn fastest to avoid expiring unused at its reset comes first, so
	// staggered resets land at ~100% utilization instead of stranding
	// headroom that a cooler sibling could have absorbed.
	let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
	if (metric !== 0) return metric;
	return 0;
}

function compareUsageRankedCandidates(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planRequirement: OpenAICodexPlanRequirement,
): number {
	const priority = compareUsageRankedCandidatePriority(left, right, planRequirement);
	return priority !== 0 ? priority : left.orderPos - right.orderPos;
}

export function orderUsageRankedCandidates<T extends AuthCredential>(
	candidates: UsageRankedCandidate<T>[],
	planRequirement: OpenAICodexPlanRequirement,
): UsageCandidate<T>[] {
	candidates.sort((left, right) => compareUsageRankedCandidates(left, right, planRequirement));
	return candidates.map(candidate => ({
		selection: candidate.selection,
		usage: candidate.usage,
		usageChecked: candidate.usageChecked,
		allowanceSpent: candidate.allowanceSpent,
	}));
}

/**
 * Put the explicitly chosen account at the head of an ordered candidate list.
 *
 * A choice outranks availability: a hold is this library's own prediction of when a provider
 * will serve again, and it is not a reason to spend money on an account nobody asked for. So the
 * move is unconditional, unlike the session-preference case in `#resolveOAuthSelection`, which
 * leads only while it is usable.
 */
export function leadWithChosenAccount<C extends { index: number }>(ordered: C[], chosenIndex: number | undefined): C[] {
	if (chosenIndex === undefined) return ordered;
	const at = ordered.findIndex(candidate => candidate.index === chosenIndex);
	if (at <= 0) return ordered;
	const [chosen] = ordered.splice(at, 1);
	if (chosen) ordered.unshift(chosen);
	return ordered;
}

/**
 * Returns true when an account's renewable allowance for the request scope is
 * fully consumed (e.g. 100% window usage or limit_reached), meaning any
 * continuing service draws on paid credit overage.
 */
export function isAllowanceSpent(
	strategy: CredentialRankingStrategy | undefined,
	report: UsageReport | null,
	rankingContext: CredentialRankingContext,
	nowMs: number,
): boolean {
	if (!report) return false;
	const limits = strategy?.scopeLimits?.(report, rankingContext) ?? report.limits;
	const usedFractions = limits
		.filter(limit => {
			const resetsAt = limit.window?.resetsAt;
			return resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
		})
		.map(limit => limit.amount?.usedFraction)
		.filter((fraction): fraction is number => typeof fraction === "number" && Number.isFinite(fraction));
	if (usedFractions.length > 0) {
		return Math.max(...usedFractions) >= 1;
	}
	const isScoped = strategy?.scopeLimits !== undefined;
	return !isScoped && report.metadata?.limitReached === true;

}

/** What one ranking pass ranks: the provider's credentials, in the order to consider them. */
export interface CredentialRankingRequest<S> {
	providerKey: string;
	provider: string;
	order: number[];
	credentials: S[];
	options?: AuthApiKeyOptions;
	strategy: CredentialRankingStrategy;
	rankingContext: CredentialRankingContext;
	blockScope?: string;
	sessionPreferredUsage?: { index: number; usage: UsageReport };
}

/** The block reads and writes a ranking pass makes. */
export type RankingBlocks = Pick<CredentialBlocks, "getCredentialBlockedUntil" | "markCredentialBlocked">;

/** The usage fetch a ranking pass makes, and the per-request deadline it is given. */
export type RankingUsage = Pick<UsageReporting, "reportFor" | "requestTimeoutMs">;

/**
 * Resolves with `work`, or with `null` once `timeoutMs` passes first. The timer is cleared however
 * the race ends, a rejected `work` included, and is unref'd so a pending one never holds the process.
 */
async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
	const deadline = Promise.withResolvers<null>();
	const timer = setTimeout(() => deadline.resolve(null), timeoutMs);
	timer.unref?.();
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

export class CredentialRanking {
	readonly #blocks: RankingBlocks;
	readonly #usage: RankingUsage;

	constructor(blocks: RankingBlocks, usage: RankingUsage) {
		this.#blocks = blocks;
		this.#usage = usage;
	}

	/** Ranks API keys by live usage. A blocked key is not fetched; it ranks by when its block ends. */
	async rankApiKeySelections(request: CredentialRankingRequest<ApiKeySelection>): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const usageResults = await this.#fetchWithinDeadline(request, async selection => {
			const blockedUntil = this.#blockedUntil(request, selection.index);
			if (blockedUntil !== undefined) return { selection, usage: null, usageChecked: false, blockedUntil };
			const usage = await this.#reportFor(request, selection.credential);
			return { selection, usage, usageChecked: true, blockedUntil: undefined };
		});
		return this.#rankUsageResults(usageResults, request, "none", nowMs);
	}

	/**
	 * Ranks OAuth accounts by live usage. A blocked `openai-codex` account is still fetched, since its
	 * report may clear the block; any other blocked account ranks by when its block ends.
	 */
	async rankOAuthSelections(
		request: CredentialRankingRequest<OAuthSelection> & { planRequirement: OpenAICodexPlanRequirement },
	): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const usageResults = await this.#fetchWithinDeadline(request, async selection => {
			let blockedUntil = this.#blockedUntil(request, selection.index);
			let usage: UsageReport | null = null;
			let usageChecked = false;
			if (blockedUntil !== undefined && request.provider === "openai-codex") {
				usage = await this.#reportFor(request, selection.credential);
				usageChecked = true;
				blockedUntil = this.#blockedUntil(request, selection.index);
			}
			if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
			if (!usageChecked && request.sessionPreferredUsage && selection.index === request.sessionPreferredUsage.index) {
				usage = request.sessionPreferredUsage.usage;
				usageChecked = true;
			}
			if (!usageChecked) {
				usage = await this.#reportFor(request, selection.credential);
				usageChecked = true;
			}
			return { selection, usage, usageChecked, blockedUntil: undefined };
		});
		return this.#rankUsageResults(usageResults, request, request.planRequirement, nowMs);
	}

	/**
	 * Fetches usage for every credential in `request.order` in parallel under one deadline. A slow or
	 * rate-limited usage endpoint must not hold credential selection: past the deadline every
	 * credential ranks unmeasured, by its block alone.
	 */
	async #fetchWithinDeadline<T extends AuthCredential, S extends { credential: T; index: number }>(
		request: CredentialRankingRequest<S>,
		fetchOne: (selection: S) => Promise<UsageRankingResult<T>>,
	): Promise<Array<UsageRankingResult<T> | null>> {
		const usageTimeout = Math.max(5000, this.#usage.requestTimeoutMs * 1.5);
		const fetched = await settleWithin(
			Promise.all(
				request.order.map(idx => {
					const selection = request.credentials[idx];
					return selection ? fetchOne(selection) : null;
				}),
			),
			usageTimeout,
		);
		if (fetched) return fetched;
		return request.order.map(idx => {
			const selection = request.credentials[idx];
			if (!selection) return null;
			const blockedUntil = this.#blockedUntil(request, selection.index);
			return { selection, usage: null, usageChecked: false, blockedUntil };
		});
	}

	#blockedUntil(request: CredentialRankingRequest<unknown>, index: number): number | undefined {
		return this.#blocks.getCredentialBlockedUntil(request.provider, request.providerKey, index, request.blockScope);
	}

	#reportFor(request: CredentialRankingRequest<unknown>, credential: AuthCredential): Promise<UsageReport | null> {
		return this.#usage.reportFor(request.provider, credential, {
			...request.options,
			timeoutMs: this.#usage.requestTimeoutMs,
		});
	}

	/**
	 * Ranks fetched usage results in request order. A credential whose scoped limit is reached is
	 * blocked, and recorded as blocked, before its windows are scored. The plan requirement is the one
	 * axis on which API keys ("none") and OAuth accounts differ.
	 */
	#rankUsageResults<T extends AuthCredential>(
		usageResults: ReadonlyArray<UsageRankingResult<T> | null>,
		request: CredentialRankingRequest<unknown>,
		planRequirement: OpenAICodexPlanRequirement,
		nowMs: number,
	): UsageCandidate<T>[] {
		const { strategy } = request;
		const ranked: UsageRankedCandidate<T>[] = [];
		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? getScopedUsageLimits(strategy, usage, request.rankingContext) : undefined;
			const isCodexAllowedOverage = request.provider === "openai-codex" && usage?.metadata?.allowed === true;
			if (!blocked && scopedLimits && !isCodexAllowedOverage && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = getUsageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + DEFAULT_CREDENTIAL_BACKOFF_MS;
				this.#blocks.markCredentialBlocked(
					request.provider,
					request.providerKey,
					selection.index,
					blockedUntil,
					request.blockScope,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, request.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			const allowanceSpent = isAllowanceSpent(strategy, usage, request.rankingContext, nowMs);
			ranked.push({
				selection,
				usage,
				usageChecked,
				allowanceSpent,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				planPriority: getOpenAICodexPlanPriority(usage, planRequirement),
				secondaryUsed: normalizeUsageFraction(secondaryTarget),
				secondaryRequiredDrain: computeWindowRequiredDrain(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: normalizeUsageFraction(primary),
				primaryRequiredDrain: computeWindowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, planRequirement);
	}
}
