import type { UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/ai/auth-storage";

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * True when a single usage-limit column belongs to the given OAuth identity.
 *
 * Single definition of the matching rules for both `/usage` renderers:
 * - `orgId`     ↔ report metadata `orgId` — a GATE that QUALIFIES the base
 *   identity, never a replacement for it. Mismatched org presence or
 *   different orgs never match: two subscriptions (orgs) can share one
 *   email, so an org-scoped identity matches only its own org's reports and
 *   an org-less legacy identity never claims an org-attributed report via
 *   the shared email. A SHARED org still requires the base-identity match
 *   below — Anthropic Team seats have per-user pools yet share the org id
 *   in report metadata. Only an org-only identity (no base identifiers
 *   recovered at all) matches on the org alone. When neither side carries
 *   an org, the base fallback applies unchanged (providers without orgs
 *   keep their former behavior).
 * - `accountId` ↔ report metadata `accountId`/`account_id` or `limit.scope.accountId`
 * - `email`     ↔ report metadata `email`
 * - `projectId` ↔ report metadata `projectId` or `limit.scope.projectId`
 *   (Google-style providers key usage on the GCP project, not an account id)
 */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	const activeEmail = normalizeIdentityValue(identity.email);
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	const activeOrgId = normalizeIdentityValue(identity.orgId);
	const reportOrgId = normalizeIdentityValue(metadata.orgId);
	// Org gate (see doc comment above): different/mismatched-presence orgs
	// never match; a shared org falls through to the base checks unless the
	// identity is org-only.
	if (activeOrgId || reportOrgId) {
		if (activeOrgId !== reportOrgId) return false;
		if (!activeAccountId && !activeEmail && !activeProjectId) return true;
	}
	const reportAccountId =
		normalizeIdentityValue(metadata.accountId) ??
		normalizeIdentityValue(metadata.account_id) ??
		normalizeIdentityValue(limit.scope.accountId);
	const reportEmail = normalizeIdentityValue(metadata.email);
	const reportProjectId =
		normalizeIdentityValue(metadata.projectId) ?? normalizeIdentityValue(limit.scope.projectId);

	// Conflicting identity check: when both emails are known and differ, or
	// both account ids are known and differ, the limit belongs to a different
	// account and must never match. ProjectId fallback is only reached when
	// there is no conflicting identity.
	if (activeEmail && reportEmail && activeEmail !== reportEmail) return false;
	if (activeAccountId && reportAccountId && activeAccountId !== reportAccountId) return false;

	if (activeAccountId && reportAccountId === activeAccountId) return true;
	if (activeEmail && reportEmail === activeEmail) return true;
	if (activeProjectId && reportProjectId === activeProjectId) return true;
	return false;
}

/** True when any limit column in `report` belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}
