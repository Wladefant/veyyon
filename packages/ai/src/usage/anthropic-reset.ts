/**
 * Anthropic usage-limit reset client (Claude Pro and Max subscriptions).
 *
 * Anthropic grants subscription accounts a small number of usage-limit resets, the program Claude
 * Code spends through `/limit-reset`. The OAuth usage endpoint reports them when the query asks for
 * the program, and one organization route spends one:
 *
 *   GET  /api/oauth/usage?cedar_ember=1&skip_spend=1      → `cedar_ember` status block
 *   POST /api/organizations/{orgUuid}/reset_rate_limits
 *        body: { program: "cedar_ember", grant_id, request_id }
 *
 * The status block lists grants. A grant states the limit windows a reset clears (`five_hour`,
 * `seven_day`, `seven_day_overage_included`, …), how many resets it has left, when it expires, and
 * whether it can be spent before a limit is reached (`use_requires_limit`). `next_grant_id` is the
 * grant the server spends next; a claim for any other grant is rejected with `not_next_grant`.
 * `request_id` is the idempotency key: retrying a claim with the same id cannot spend twice.
 *
 * The plain `/api/oauth/usage` read returns `cedar_ember: null`, so `./claude` reads the usage report
 * with the same query and gets the reset count in the one request.
 */
import type { FetchImpl } from "../types";
import type { UsageResetCredits } from "../usage";
import { isRecord } from "../utils";
import { claudeApiRoot, claudeOAuthHeaders, normalizeClaudeBaseUrl } from "./claude-oauth-endpoint";

/** The reset program this client reads and spends. */
export const ANTHROPIC_RESET_PROGRAM = "cedar_ember";
/** Usage-endpoint query that makes the response include the {@link ANTHROPIC_RESET_PROGRAM} block. */
export const ANTHROPIC_RESET_STATUS_QUERY = "cedar_ember=1&skip_spend=1";

// The server's own id grammar. A claim with an id outside it is rejected locally rather than sent.
const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** One reset grant on an Anthropic account. */
export interface AnthropicResetGrant {
	id: string;
	/** Human-facing title, e.g. "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max". */
	label: string;
	resetsTotal: number;
	resetsLeft: number;
	startsAt?: string;
	/** ISO time after which the grant can no longer be spent. */
	endsAt?: string;
	/** Usage windows one reset clears, in the server's names (`five_hour`, `seven_day`, …). */
	clears: string[];
	paused: boolean;
	/** Whether the server accepts a claim on this grant right now. */
	usableNow: boolean;
	/** `true` when the grant can only be spent while a limit it clears is reached. */
	useRequiresLimit: boolean;
}

/** The account's reset status, from the usage endpoint's `cedar_ember` block. */
export interface AnthropicResetStatus {
	eligible: boolean;
	ineligibleReason?: string;
	/** Whether the account is at a usage limit right now. */
	atLimit: boolean;
	/** Usage windows currently exhausted, in the server's names. */
	exhausted: string[];
	grants: AnthropicResetGrant[];
	/** The grant a claim must name; unset when no grant can be spent. */
	nextGrantId?: string;
	weeklyResetsAt?: string;
	/** ISO time before which the server rejects claims with `cooldown`. */
	cooldownUntil?: string;
}

/**
 * Claim result. `reset` means the windows in `cleared` were reset; the others are business
 * outcomes that spent nothing. Transport failures are `rate_limited`, `auth_error` or
 * `http_<status>`.
 */
export type AnthropicResetClaimResult =
	| "reset"
	| "already_used"
	| "not_limited"
	| "cooldown"
	| "ineligible"
	| "unavailable"
	| "rate_limited"
	| "auth_error"
	| (string & {});

export interface AnthropicResetClaimOutcome {
	/** `true` only when `result === "reset"`. */
	ok: boolean;
	result: AnthropicResetClaimResult;
	/** Server's reason for a non-reset result, e.g. `not_next_grant`, `expired`, `unknown_grant`. */
	reason?: string;
	resetsLeft?: number;
	cleared: string[];
	weeklyResetsAt?: string;
	cooldownUntil?: string;
	/** HTTP status of the claim, 0 when the request did not complete. */
	status: number;
}

interface AnthropicResetAuth {
	accessToken: string;
	/** Provider base URL override; defaults to `https://api.anthropic.com`. */
	baseUrl?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseGrant(value: unknown): AnthropicResetGrant | null {
	if (!isRecord(value)) return null;
	const id = optionalString(value.id);
	const resetsLeft = nonNegativeInteger(value.resets_left);
	if (!id || !GRANT_ID_PATTERN.test(id) || resetsLeft === undefined) return null;
	return {
		id,
		label: optionalString(value.label) ?? "",
		resetsTotal: nonNegativeInteger(value.resets_total) ?? resetsLeft,
		resetsLeft,
		startsAt: optionalString(value.starts_at),
		endsAt: optionalString(value.ends_at),
		clears: stringList(value.clears),
		paused: value.paused === true,
		usableNow: value.usable_now === true,
		// Absent means the conservative reading: spendable only at a limit.
		useRequiresLimit: value.use_requires_limit !== false,
	};
}

/**
 * Parse the usage endpoint's `cedar_ember` block. Returns `null` for a missing, `null` or malformed
 * block; a grant that fails validation is dropped rather than failing the whole status.
 */
export function parseAnthropicResetStatus(block: unknown): AnthropicResetStatus | null {
	if (!isRecord(block) || typeof block.eligible !== "boolean") return null;
	const grants = Array.isArray(block.grants)
		? block.grants.map(parseGrant).filter((grant): grant is AnthropicResetGrant => grant !== null)
		: [];
	const nextGrantId = optionalString(block.next_grant_id);
	return {
		eligible: block.eligible,
		ineligibleReason: optionalString(block.ineligible_reason),
		atLimit: block.at_limit === true,
		exhausted: stringList(block.exhausted),
		grants,
		// The server's pointer is honoured only when it names a grant that parsed.
		nextGrantId: nextGrantId && grants.some(grant => grant.id === nextGrantId) ? nextGrantId : undefined,
		weeklyResetsAt: optionalString(block.weekly_resets_at),
		cooldownUntil: optionalString(block.cooldown_until),
	};
}

function grantIsSpendable(grant: AnthropicResetGrant, nowMs: number): boolean {
	if (grant.paused || !grant.usableNow || grant.resetsLeft <= 0) return false;
	const endsAtMs = grant.endsAt ? Date.parse(grant.endsAt) : Number.NaN;
	return Number.isNaN(endsAtMs) || endsAtMs > nowMs;
}

/** Resets the account can spend right now: remaining resets on unpaused, unexpired, usable grants. */
export function anthropicResetAvailableCount(status: AnthropicResetStatus, nowMs = Date.now()): number {
	if (!status.eligible) return 0;
	let count = 0;
	for (const grant of status.grants) {
		if (grantIsSpendable(grant, nowMs)) count += grant.resetsLeft;
	}
	return count;
}

/**
 * The grant a claim spends: the one named, else the server's `next_grant_id`. Returns `undefined`
 * when that grant cannot be spent right now.
 */
export function selectAnthropicResetGrant(
	status: AnthropicResetStatus,
	grantId?: string,
	nowMs = Date.now(),
): AnthropicResetGrant | undefined {
	if (!status.eligible) return undefined;
	const wanted = grantId ?? status.nextGrantId;
	if (!wanted) return undefined;
	const grant = status.grants.find(entry => entry.id === wanted);
	return grant && grantIsSpendable(grant, nowMs) ? grant : undefined;
}

/** The status as the provider-neutral saved-reset summary a {@link UsageReport} carries. */
export function anthropicResetCredits(status: AnthropicResetStatus, nowMs = Date.now()): UsageResetCredits {
	return {
		availableCount: anthropicResetAvailableCount(status, nowMs),
		credits: status.grants
			.filter(grant => grant.resetsLeft > 0)
			.map(grant => ({
				id: grant.id,
				title: grant.label || undefined,
				grantedAt: grant.startsAt,
				expiresAt: grant.endsAt,
				status: grantIsSpendable(grant, nowMs) ? "available" : grant.paused ? "paused" : "unavailable",
				clears: grant.clears,
			})),
	};
}

/** A status read, with the organization the token is scoped to when the response names it. */
export interface AnthropicResetStatusRead {
	status: AnthropicResetStatus;
	/** From the `anthropic-organization-id` response header. */
	orgId?: string;
}

/**
 * Read the account's reset status. Returns `null` on a transport or auth failure, or when the
 * response carries no status block, so callers treat both as "no data".
 */
export async function fetchAnthropicResetStatus(auth: AnthropicResetAuth): Promise<AnthropicResetStatusRead | null> {
	const url = `${normalizeClaudeBaseUrl(auth.baseUrl)}/usage?${ANTHROPIC_RESET_STATUS_QUERY}`;
	let payload: unknown;
	let orgId: string | undefined;
	try {
		const response = await auth.fetch(url, { headers: claudeOAuthHeaders(auth.accessToken), signal: auth.signal });
		if (!response.ok) return null;
		orgId = response.headers.get("anthropic-organization-id")?.trim() || undefined;
		payload = await response.json();
	} catch {
		return null;
	}
	const status = isRecord(payload) ? parseAnthropicResetStatus(payload[ANTHROPIC_RESET_PROGRAM]) : null;
	return status ? { status, orgId } : null;
}

function failedClaim(result: AnthropicResetClaimResult, status: number): AnthropicResetClaimOutcome {
	return { ok: false, result, cleared: [], status };
}

/**
 * Spend one reset from `grantId`, which must be the status's `nextGrantId`. `requestId` is the
 * idempotency key; one is generated when omitted, and retrying with the same id cannot spend twice.
 * Never throws for a business outcome or an HTTP failure; a thrown network error propagates.
 */
export async function claimAnthropicReset(
	auth: AnthropicResetAuth & { orgId: string; grantId: string; requestId?: string },
): Promise<AnthropicResetClaimOutcome> {
	const requestId = auth.requestId ?? crypto.randomUUID();
	if (!GRANT_ID_PATTERN.test(auth.grantId) || !REQUEST_ID_PATTERN.test(requestId)) {
		return failedClaim("invalid_request", 0);
	}
	const url = `${claudeApiRoot(auth.baseUrl)}/api/organizations/${encodeURIComponent(auth.orgId)}/reset_rate_limits`;
	const response = await auth.fetch(url, {
		method: "POST",
		headers: claudeOAuthHeaders(auth.accessToken),
		body: JSON.stringify({ program: ANTHROPIC_RESET_PROGRAM, grant_id: auth.grantId, request_id: requestId }),
		signal: auth.signal,
	});
	if (response.status === 429) return failedClaim("rate_limited", response.status);
	if (response.status === 401 || response.status === 403) return failedClaim("auth_error", response.status);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	// A business outcome (`cooldown`, `already_used`, …) may arrive with a 4xx status; the body's
	// `result` names it either way, and only a response without one is a transport failure.
	if (!isRecord(body) || typeof body.result !== "string") {
		return failedClaim(`http_${response.status}`, response.status);
	}
	return {
		ok: body.result === "reset",
		result: body.result,
		reason: optionalString(body.reason),
		resetsLeft: nonNegativeInteger(body.resets_left),
		cleared: stringList(body.cleared),
		weeklyResetsAt: optionalString(body.weekly_resets_at),
		cooldownUntil: optionalString(body.cooldown_until),
		status: response.status,
	};
}
