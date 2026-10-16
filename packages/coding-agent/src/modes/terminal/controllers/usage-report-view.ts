/**
 * The `/usage` panel: provider usage reports grouped by provider and limit window, with bars,
 * reset times and saved resets, sized to the terminal width.
 */
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/ai/auth-storage";
import { resolveUsedFraction } from "@veyyon/ai/usage";
import { clamp01, formatDuration, sanitizeText } from "@veyyon/utils";
import { subCellBar } from "@veyyon/utils/bar";
import { padding } from "@veyyon/utils/padding";
import { visibleWidth } from "@veyyon/utils/width";
import { formatProviderName } from "../../../session/account-format";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { theme } from "../../../theme/theme-binding";
import { replaceTabs, truncateToWidth } from "../../../tools/core/render-utils";

const BAR_WIDTH_MAX = 24;
const BAR_WIDTH_MIN = 4;

function formatDecimal(value: number, maxFractionDigits = 1): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

function resolveProviderUsageTotal(reports: UsageReport[]): number {
	return reports
		.flatMap(report => report.limits)
		.map(limit => resolveUsedFraction(limit) ?? 0)
		.reduce((sum, value) => sum + value, 0);
}

function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function formatWindowSuffix(label: string, windowLabel: string, uiTheme: typeof theme): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return uiTheme.fg("dim", `(${windowLabel})`);
}

/** ` (org)` suffix when the report is org-attributed — two subscriptions can share one email. */
function orgSuffix(report: UsageReport): string {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	const org = typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
	return org ? ` (${org})` : "";
}

function formatAccountLabel(limit: UsageLimit, report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId =
		typeof report.metadata?.accountId === "string" && report.metadata.accountId
			? report.metadata.accountId
			: limit.scope.accountId || undefined;
	if (accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId =
		typeof report.metadata?.projectId === "string" && report.metadata.projectId
			? report.metadata.projectId
			: limit.scope.projectId || undefined;
	if (projectId) return projectId;
	return `account ${index + 1}`;
}

function formatUnlimitedReportLabel(report: UsageReport, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return `${email}${orgSuffix(report)}`;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId = report.metadata?.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

function formatResetShort(limit: UsageLimit, nowMs: number): string | undefined {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined) return undefined;
	// Codex returns the prior window's reset_at until a new request opens a fresh window —
	// rendering a negative delta is meaningless, so drop the suffix in that case.
	if (resetsAt <= nowMs) return undefined;
	return formatDuration(resetsAt - nowMs);
}

function formatAccountHeaderRow(
	limits: UsageLimit[],
	reports: UsageReport[],
	nowMs: number,
	columnWidth: number,
	uiTheme: typeof theme,
	activeAccount?: OAuthAccountIdentity,
): string[] {
	const parts = limits.map((limit, index) => {
		const reset = formatResetShort(limit, nowMs);
		const report = reports[index];
		const active = report !== undefined && limitMatchesActiveAccount(report, limit, activeAccount);
		const label = formatAccountLabel(limit, report, index);
		return {
			label: active ? `${theme.status.active} ${label}` : label,
			suffix: reset ? `(${reset})` : "",
			active,
		};
	});
	const maxSuffixWidth = parts.reduce((max, p) => Math.max(max, visibleWidth(p.suffix)), 0);
	const gap = maxSuffixWidth > 0 ? 1 : 0;
	const prefixBudget = columnWidth - maxSuffixWidth - gap;

	// If suffix can't share the cell with at least `x…`, fall back to whole-label truncation.
	if (prefixBudget < 2) {
		return parts.map(p => {
			const full = p.suffix ? `${p.label} ${p.suffix}` : p.label;
			const cell = padColumn(truncateToWidth(full, columnWidth), columnWidth);
			return p.active ? uiTheme.fg("accent", cell) : cell;
		});
	}

	return parts.map(p => {
		const prefix = truncateToWidth(p.label, prefixBudget);
		const prefixCell = prefix + " ".repeat(prefixBudget - visibleWidth(prefix));
		const styledPrefix = p.active ? uiTheme.fg("accent", prefixCell) : prefixCell;
		if (!p.suffix) return styledPrefix + " ".repeat(maxSuffixWidth + gap);
		const suffixPad = " ".repeat(maxSuffixWidth - visibleWidth(p.suffix));
		return `${styledPrefix} ${suffixPad}${uiTheme.fg("dim", p.suffix)}`;
	});
}

function padColumn(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${text}${padding(width - visible)}`;
}

function resolveAggregateStatus(limits: UsageLimit[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (!hasOk && !hasWarning && !hasExhausted) return "unknown";
	if (hasOk) {
		return hasWarning || hasExhausted ? "warning" : "ok";
	}
	if (hasWarning) return "warning";
	return "exhausted";
}

function formatAggregateAmount(limits: UsageLimit[]): string {
	const fractions = limits
		.map(limit => resolveUsedFraction(limit))
		.filter((value): value is number => value !== undefined);
	if (fractions.length === limits.length && fractions.length > 0) {
		const sum = fractions.reduce((total, value) => total + value, 0);
		const avgRemaining = Math.max(0, ((limits.length - sum) / limits.length) * 100);
		return `${formatDecimal(avgRemaining)}% free`;
	}

	const amounts = limits
		.map(limit => limit.amount)
		.filter(amount => amount.used !== undefined && amount.limit !== undefined && amount.limit > 0);
	if (amounts.length === limits.length && amounts.length > 0) {
		const totalUsed = amounts.reduce((sum, amount) => sum + (amount.used ?? 0), 0);
		const totalLimit = amounts.reduce((sum, amount) => sum + (amount.limit ?? 0), 0);
		const remainingPct = totalLimit > 0 ? Math.max(0, 100 - (totalUsed / totalLimit) * 100) : 0;
		return `${formatDecimal(remainingPct)}% free`;
	}

	// Count unique accounts from limit scopes — not limits.length.
	const uniqueAccountIds = new Set(
		limits.map(limit => limit.scope.accountId).filter((id): id is string => typeof id === "string" && id.length > 0),
	);
	if (uniqueAccountIds.size > 0) return `${uniqueAccountIds.size} ${uniqueAccountIds.size === 1 ? "acct" : "accts"}`;
	// No account IDs available — keep the pre-existing fallback so providers
	// that don't populate scope.accountId still show a summary.
	return `${limits.length} accts`;
}

function resolveResetRange(limits: UsageLimit[], nowMs: number): string | null {
	const absolute = limits
		.map(limit => limit.window?.resetsAt)
		.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > nowMs);
	if (absolute.length === 0) return null;
	const offsets = absolute.map(value => value - nowMs);
	const minReset = Math.min(...offsets);
	const maxReset = Math.max(...offsets);
	if (maxReset - minReset > 60_000) {
		return `resets in ${formatDuration(minReset)}–${formatDuration(maxReset)}`;
	}
	return `resets in ${formatDuration(minReset)}`;
}

function resolveStatusIcon(status: UsageLimit["status"], uiTheme: typeof theme): string {
	if (status === "exhausted") return uiTheme.fg("error", uiTheme.status.error);
	if (status === "warning") return uiTheme.fg("warning", uiTheme.status.warning);
	if (status === "ok") return uiTheme.fg("success", uiTheme.status.success);
	return uiTheme.fg("dim", uiTheme.status.pending);
}

function resolveStatusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

/**
 * One usage bar: the fill in the limit's status colour, the track dimmed.
 *
 * Eight steps per column through the shared owner, which replaces a local
 * three-state approximation (`▒` at a third of a cell, `▓` at two thirds).
 * That approximation was the only sub-cell precision in the product and it read
 * as a shading artifact rather than as a position; the partial blocks read as
 * the bar ending part way through a column, because that is what they are.
 *
 * STATIC, deliberately. `renderUsageReports` returns one string that `/usage`
 * presents as a `Text` in the transcript: there is no component holding this
 * bar and no repaint after the first, so a spring here would have nothing to
 * drive it. See `tiny-title-download-progress.ts` for the animated case.
 */
function renderUsageBar(limit: UsageLimit, uiTheme: typeof theme, barWidth: number): string {
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) {
		return uiTheme.fg("dim", "·".repeat(barWidth));
	}
	const ramp = uiTheme.getBarRamp();
	const bar = subCellBar(clamp01(fraction), barWidth, { ramp });
	// The first track cell is where the fill ends: every glyph before it is fill,
	// whole or partial. One slice, so the two tones cannot disagree about the
	// boundary the way two independently counted `repeat`s could.
	const trackAt = bar.indexOf(ramp.track);
	const color = resolveStatusColor(limit.status);
	return trackAt < 0
		? uiTheme.fg(color, bar)
		: `${uiTheme.fg(color, bar.slice(0, trackAt))}${uiTheme.fg("dim", bar.slice(trackAt))}`;
}

/**
 * Pick a per-column width so n bars + a trailing amount string fit in `available` columns.
 * Falls back to the minimum when the terminal is too narrow rather than wrapping.
 */
function resolveColumnWidth(count: number, available: number, trailing: number): number {
	if (count <= 0) return BAR_WIDTH_MAX;
	const indent = 2;
	const gaps = count - 1;
	const spaceForBars = available - indent - gaps - (trailing > 0 ? trailing + 1 : 0);
	const ideal = Math.floor(spaceForBars / count);
	const min = BAR_WIDTH_MIN;
	const max = BAR_WIDTH_MAX;
	if (ideal < min) return min;
	if (ideal > max) return max;
	return ideal;
}

/** One account's limit in a limit group: one column of the row. */
interface UsageLimitColumn {
	limit: UsageLimit;
	report: UsageReport;
}

/** Every limit of one title and window across a provider's reports: one row of account columns. */
interface UsageLimitGroup {
	label: string;
	windowLabel: string;
	columns: UsageLimitColumn[];
}

/** A limit group with its columns ordered most-used first and its aggregate amount. */
interface SortedUsageLimitGroup {
	group: UsageLimitGroup;
	sortedLimits: UsageLimit[];
	sortedReports: UsageReport[];
	amountText: string;
}

/** What one provider's section of `/usage` renders against. */
interface UsageSectionView {
	uiTheme: typeof theme;
	nowMs: number;
	availableWidth: number;
	activeAccount: OAuthAccountIdentity | undefined;
}

export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: typeof theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
): string {
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : "";
	const lines = [uiTheme.bold(uiTheme.fg("accent", `Usage${headerSuffix}`))];
	for (const { provider, providerReports } of groupReportsByProvider(reports)) {
		lines.push("", uiTheme.bold(uiTheme.fg("accent", formatProviderName(provider))));
		renderProviderUsage(lines, providerReports, {
			uiTheme,
			nowMs,
			availableWidth,
			activeAccount: resolveActiveAccount?.(provider),
		});
	}
	return lines.join("\n");
}

/** The reports of each provider, the least-used provider first and ties by provider id. */
function groupReportsByProvider(reports: UsageReport[]): { provider: string; providerReports: UsageReport[] }[] {
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = grouped.get(report.provider);
		if (providerReports) providerReports.push(report);
		else grouped.set(report.provider, [report]);
	}
	return Array.from(grouped, ([provider, providerReports]) => ({
		provider,
		providerReports,
		totalUsage: resolveProviderUsageTotal(providerReports),
	})).sort((a, b) => {
		if (a.totalUsage !== b.totalUsage) return a.totalUsage - b.totalUsage;
		return a.provider.localeCompare(b.provider);
	});
}

function renderProviderUsage(lines: string[], providerReports: UsageReport[], view: UsageSectionView): void {
	const { uiTheme, activeAccount } = view;
	const activeAccountLabel = activeAccount?.email ?? activeAccount?.accountId ?? activeAccount?.projectId;
	if (activeAccountLabel) lines.push(`  ${uiTheme.fg("accent", "in use by this session:")} ${activeAccountLabel}`);
	// Provider-wide disclaimers (e.g. "Veyyon-observed spend only") render once above the per-account sections
	// instead of on every limit.
	const providerNotes = formatUsageNotes(
		providerReports.flatMap(report => report.notes ?? []),
		uiTheme,
	);
	if (providerNotes) lines.push(providerNotes);
	renderSavedResets(lines, providerReports, view);
	renderLimitGroups(lines, collectLimitGroups(providerReports), view);
	// Accounts with no rate limits (e.g. business/enterprise plans).
	for (const report of providerReports) {
		if (report.limits.length === 0) lines.push(formatUnlimitedReportLine(report, uiTheme));
	}
}

/** One dim line of the distinct notes, bullet-joined and truncated, or undefined when there are none. */
function formatUsageNotes(notes: readonly string[], uiTheme: typeof theme): string | undefined {
	if (notes.length === 0) return undefined;
	const joined = Array.from(new Set(notes), note => note.replace(/[\r\n]+/g, " ")).join(" • ");
	return `  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(joined), 110)))}`.trimEnd();
}

/** The saved rate-limit resets each account holds, with each credit's expiry. */
function renderSavedResets(lines: string[], providerReports: UsageReport[], view: UsageSectionView): void {
	const resetLines: string[] = [];
	for (const report of providerReports) pushSavedResetLines(resetLines, report, view);
	if (resetLines.length === 0) return;
	const { uiTheme } = view;
	lines.push(`  ${uiTheme.fg("accent", "Saved rate-limit resets")} ${uiTheme.fg("dim", "(/usage reset to spend)")}`);
	for (const line of resetLines) lines.push(uiTheme.fg("dim", line));
}

/** One account's saved-reset count line and one expiry line per credit; nothing for an account with none. */
function pushSavedResetLines(resetLines: string[], report: UsageReport, view: UsageSectionView): void {
	const count = report.resetCredits?.availableCount ?? 0;
	if (count <= 0) return;
	const active = savedResetsAreActive(report, view.activeAccount) ? " (active)" : "";
	resetLines.push(`    • ${savedResetsLabel(report)}: ${count} saved reset${count === 1 ? "" : "s"}${active}`);
	for (const credit of report.resetCredits?.credits ?? []) {
		const expiry = formatResetCreditExpiry(credit.expiresAt, view.nowMs);
		if (expiry) resetLines.push(`        ${expiry}`);
	}
}

function savedResetsLabel(report: UsageReport): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId) return accountId;
	return "account";
}

/** Whether a report's saved resets belong to the session's account, by account id or by email. */
function savedResetsAreActive(report: UsageReport, activeAccount: OAuthAccountIdentity | undefined): boolean {
	if (!activeAccount) return false;
	if (activeAccount.accountId && activeAccount.accountId === report.metadata?.accountId) return true;
	return !!activeAccount.email && activeAccount.email === report.metadata?.email;
}

/** `expires in <duration> (<date>)` or `expired (<date>)`, or undefined for a credit with no valid expiry. */
function formatResetCreditExpiry(expiresAt: string | undefined, nowMs: number): string | undefined {
	if (!expiresAt) return undefined;
	const expiryMs = Date.parse(expiresAt);
	if (Number.isNaN(expiryMs)) return undefined;
	const remaining = expiryMs - nowMs;
	const expiryDate = expiresAt.slice(0, 10);
	return remaining > 0 ? `expires in ${formatDuration(remaining)} (${expiryDate})` : `expired (${expiryDate})`;
}

/** The provider's limits grouped by title and window, in first-seen order. */
function collectLimitGroups(providerReports: UsageReport[]): Iterable<UsageLimitGroup> {
	const groups = new Map<string, UsageLimitGroup>();
	for (const report of providerReports) {
		for (const limit of report.limits) {
			const label = formatLimitTitle(limit);
			const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
			const key = `${label}|${windowId}`;
			let group = groups.get(key);
			if (!group) {
				group = { label, windowLabel: limit.window?.label ?? windowId, columns: [] };
				groups.set(key, group);
			}
			group.columns.push({ limit, report });
		}
	}
	return groups.values();
}

/** Renders every limit group of a provider at one shared column width. */
function renderLimitGroups(lines: string[], groups: Iterable<UsageLimitGroup>, view: UsageSectionView): void {
	const sortedGroups = Array.from(groups, sortLimitGroupByUse);
	let sectionCount = 0;
	let sectionTrailing = 0;
	for (const { sortedLimits, amountText } of sortedGroups) {
		sectionCount = Math.max(sectionCount, sortedLimits.length);
		sectionTrailing = Math.max(sectionTrailing, visibleWidth(amountText));
	}
	const columnWidth = resolveColumnWidth(sectionCount, view.availableWidth, sectionTrailing);
	for (const sortedGroup of sortedGroups) renderLimitGroup(lines, sortedGroup, columnWidth, view);
}

/** Orders a group's columns by used fraction, most used first, a limit with no fraction last, ties in order. */
function sortLimitGroupByUse(group: UsageLimitGroup): SortedUsageLimitGroup {
	const entries = group.columns.map(({ limit, report }, index) => ({
		limit,
		report,
		fraction: resolveUsedFraction(limit) ?? -1,
		index,
	}));
	entries.sort((a, b) => (a.fraction !== b.fraction ? b.fraction - a.fraction : a.index - b.index));
	const sortedLimits = entries.map(entry => entry.limit);
	return {
		group,
		sortedLimits,
		sortedReports: entries.map(entry => entry.report),
		amountText: formatAggregateAmount(sortedLimits),
	};
}

function renderLimitGroup(
	lines: string[],
	{ group, sortedLimits, sortedReports, amountText }: SortedUsageLimitGroup,
	columnWidth: number,
	view: UsageSectionView,
): void {
	const { uiTheme, nowMs } = view;
	const statusIcon = resolveStatusIcon(resolveAggregateStatus(sortedLimits), uiTheme);
	const windowSuffix = formatWindowSuffix(group.label, group.windowLabel, uiTheme);
	lines.push(`${statusIcon} ${uiTheme.bold(group.label)} ${windowSuffix}`.trim());
	const accountLabels = formatAccountHeaderRow(
		sortedLimits,
		sortedReports,
		nowMs,
		columnWidth,
		uiTheme,
		view.activeAccount,
	);
	lines.push(`  ${accountLabels.join(" ")}`.trimEnd());
	const bars = sortedLimits.map(limit => padColumn(renderUsageBar(limit, uiTheme, columnWidth), columnWidth));
	lines.push(`  ${bars.join(" ")} ${amountText}`.trimEnd());
	const resetText = sortedLimits.length <= 1 ? resolveResetRange(sortedLimits, nowMs) : null;
	if (resetText) lines.push(`  ${uiTheme.fg("dim", resetText)}`.trimEnd());
	const notes = formatUsageNotes(
		sortedLimits.flatMap(limit => limit.notes ?? []),
		uiTheme,
	);
	if (notes) lines.push(notes);
}

function formatUnlimitedReportLine(report: UsageReport, uiTheme: typeof theme): string {
	const label = formatUnlimitedReportLabel(report, 0);
	const tier = report.metadata?.planType;
	const tierSuffix = typeof tier === "string" && tier ? ` ${uiTheme.fg("dim", `(${tier})`)}` : "";
	return `${uiTheme.fg("success", uiTheme.status.success)} ${label}${tierSuffix} ${uiTheme.fg("dim", "-- no limits")}`;
}
