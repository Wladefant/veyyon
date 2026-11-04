/**
 * WHY: the Antigravity app shows quota as what REMAINS and hides a 5-hour window that cannot apply
 * once the weekly limit is spent; veyyon drew "% used" bars for both, so a spent weekly limit read as
 * a healthy 5-hour bar (veyyon#102). The class: a limit carrying `display` renders as the provider
 * words it, and a limit without it renders exactly as before. Gap: the label text itself is pinned
 * by the every-usage-window sweep, not here.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@veyyon/ai";
import { applyUsageReports, buildAccountInventory } from "../../src/session/account-inventory";
import { formatUsageWindowLine } from "../../src/slash-commands/helpers/format";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatUsageWindowLine", () => {
	test("a remaining-style window draws what is left, not what is used", () => {
		const used = strip(formatUsageWindowLine("Weekly limit", 0.9, 10));
		const left = strip(formatUsageWindowLine("Weekly limit", 0.9, 10, undefined, undefined, { remaining: true }));
		expect(used).toContain("90%");
		expect(left).toContain("10%");
		expect(left).toContain("left");
		expect(left).not.toContain("90%");
	});

	test("an inapplicable window draws no bar and no percent", () => {
		const line = strip(
			formatUsageWindowLine("5-hour limit", 1, 10, "   resets in 2h", undefined, {
				remaining: true,
				inapplicable: true,
			}),
		);
		expect(line).toContain("does not apply right now");
		expect(line).not.toMatch(/%|resets|\[/);
	});
});

describe("two Antigravity logins that share one project", () => {
	// Backtest of veyyon#102: both logins carry project `aicode-consumers`, and the /provider card gave
	// the second login the first one's bars because the project matched. Reports here name accounts by
	// email only; the project is shared.
	let store: SqliteAuthCredentialStore | null = null;
	afterEach(() => {
		store?.close();
		store = null;
	});

	test("each row keeps only the limits reported for its own email", async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const credential = (n: string) => ({
			type: "oauth" as const,
			access: `access-${n}`,
			refresh: `refresh-${n}`,
			expires: Date.now() + 3_600_000,
			email: `${n}@example.com`,
			projectId: "aicode-consumers",
		});
		await storage.set("google-antigravity", [credential("first"), credential("second")]);
		const report = (n: string, used: number): UsageReport => ({
			provider: "google-antigravity",
			fetchedAt: 1,
			metadata: { email: `${n}@example.com`, projectId: "aicode-consumers" },
			limits: [
				{
					id: `google-antigravity:${n}`,
					label: "Gemini Models",
					scope: { provider: "google-antigravity", projectId: "aicode-consumers", windowId: "weekly" },
					window: { id: "weekly", label: "Weekly limit" },
					amount: { usedFraction: used, unit: "percent" },
					display: { remaining: true },
				},
			],
		});

		const rows =
			applyUsageReports(buildAccountInventory(storage), [report("first", 0.1), report("second", 0.9)]).providers[0]
				?.rows ?? [];

		expect(rows.map(row => row.usage.map(window => window.usedFraction))).toEqual([[0.1], [0.9]]);
	});
});
