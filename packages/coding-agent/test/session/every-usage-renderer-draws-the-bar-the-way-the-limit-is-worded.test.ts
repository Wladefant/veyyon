/**
 * WHY: a limit that carries `display.remaining` is worded as what is LEFT ("5% left"), and the
 * interactive `/usage` renderer drew its bar from the used fraction anyway, so the row read `5% free`
 * beside a 95%-full bar while `veyyon usage` and the account manager drew the same limit 5% full
 * (review of veyyon#204). The class: every surface that draws a `UsageLimit` bar agrees on which way
 * it points, and a limit the provider marks inapplicable draws no bar on any of them.
 *
 * Each surface is compared against itself: a remaining-style limit at 5% left must render the bar a
 * default limit at 5% USED renders, and a window at 95% left must render the 95%-full bar. Gap: the
 * bar ramp glyphs are not pinned here, only that the surfaces agree on the fill. The four surfaces are
 * listed by hand (interactive `/usage`, non-TUI `/usage` text, `veyyon usage`, the account line): a
 * fifth renderer that draws a `UsageLimit` bar must be added here, and nothing fails until it is.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import { fractionToDraw, resolveDisplayFraction } from "@veyyon/ai/usage";
import { formatUsageBreakdown } from "@veyyon/coding-agent/cli/usage-cli";
import { renderUsageReports } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { buildUsageReportText } from "@veyyon/coding-agent/slash-commands/helpers/usage-report";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { formatUsageWindowLine } from "../../src/slash-commands/helpers/format";

beforeAll(async () => {
	await initTheme();
});

function limit(usedFraction: number, display?: UsageLimit["display"]): UsageLimit {
	return {
		id: "weekly",
		label: "Weekly limit",
		scope: { provider: "google-antigravity", windowId: "weekly" },
		window: { id: "weekly", label: "Weekly limit", durationMs: 7 * 24 * 3_600_000 },
		amount: { unit: "percent", usedFraction, remainingFraction: 1 - usedFraction },
		status: usedFraction >= 0.9 ? "warning" : "ok",
		...(display ? { display } : {}),
	};
}

function report(one: UsageLimit): UsageReport {
	return {
		provider: "google-antigravity",
		fetchedAt: Date.now(),
		limits: [one],
		metadata: { email: "first@example.test" },
	};
}

const strip = (text: string): string => stripVTControlCharacters(text);

/** `/usage`: the bar sits on the line that ends with the aggregate amount (`NN% free`). */
function interactiveBar(one: UsageLimit): string {
	const text = strip(renderUsageReports([report(one)], theme, Date.now(), 120));
	const barLine = text.split("\n").find(line => /% free$/.test(line.trimEnd()));
	if (!barLine) throw new Error(`no bar line in:\n${text}`);
	return barLine.trim().replace(/\s+[\d.]+% free$/, "");
}

/** `veyyon usage`: the bar sits between the padded title and the details, split by two spaces. */
function cliBar(one: UsageLimit): string {
	const text = strip(
		formatUsageBreakdown(
			[report(one)],
			[{ provider: "google-antigravity", type: "oauth", email: "first@example.test" }],
			Date.now(),
		),
	);
	const line = text.split("\n").find(row => row.includes("Weekly limit"));
	if (!line) throw new Error(`no limit line in:\n${text}`);
	const [, bar] = line.trim().split(/\s{2,}/);
	return bar ?? "";
}

/** The account surfaces: the bar is the `[...]` group of the shared window line. */
function accountBar(one: UsageLimit): string {
	const line = strip(
		formatUsageWindowLine("Weekly limit", one.amount.usedFraction, 10, undefined, undefined, one.display),
	);
	return line.match(/\[[^\]]*\]/)?.[0] ?? "";
}

/** The non-TUI `/usage` (ACP and `--print`): a plain-text block whose bar is the `[...]` on its own line. */
async function plainTextReport(one: UsageLimit): Promise<string> {
	return buildUsageReportText({
		session: { model: undefined, fetchUsageReports: async () => [report(one)] },
	} as never);
}

async function plainTextBar(one: UsageLimit): Promise<string> {
	const text = await plainTextReport(one);
	const line = text.split("\n").find(row => /^\s+\[/.test(row));
	if (!line) throw new Error(`no bar line in:\n${text}`);
	return line.match(/\[[^\]]*\]/)?.[0] ?? "";
}

const SURFACES: Array<[string, (one: UsageLimit) => string]> = [
	["/usage", interactiveBar],
	["veyyon usage", cliBar],
	["the account surfaces", accountBar],
];

describe("resolveDisplayFraction", () => {
	it("fills with what is left for a remaining-style limit and with what is used otherwise", () => {
		expect(resolveDisplayFraction(limit(0.95, { remaining: true }))).toBeCloseTo(0.05, 10);
		expect(resolveDisplayFraction(limit(0.95))).toBeCloseTo(0.95, 10);
	});

	it("draws no bar for an inapplicable window or an unknown amount", () => {
		expect(resolveDisplayFraction(limit(1, { remaining: true, inapplicable: true }))).toBeUndefined();
		expect(fractionToDraw(undefined, { remaining: true })).toBeUndefined();
	});

	it("clamps an overage so the bar never runs past its ends", () => {
		expect(resolveDisplayFraction(limit(1.4, { remaining: true }))).toBe(0);
		expect(resolveDisplayFraction(limit(-0.2))).toBe(0);
	});
});

describe("every usage surface draws a remaining-style limit's bar the way it words it", () => {
	for (const [surface, bar] of SURFACES) {
		it(`${surface}: 5% left draws the bar a default limit draws at 5% used`, () => {
			expect(bar(limit(0.95, { remaining: true }))).toBe(bar(limit(0.05)));
		});

		it(`${surface}: 95% left draws the bar a default limit draws at 95% used`, () => {
			expect(bar(limit(0.05, { remaining: true }))).toBe(bar(limit(0.95)));
		});

		it(`${surface}: a remaining-style bar is not the used-style bar of the same limit`, () => {
			expect(bar(limit(0.95, { remaining: true }))).not.toBe(bar(limit(0.95)));
		});
	}

	it("/usage and veyyon usage draw no filled cell for an inapplicable window", () => {
		const inapplicable = limit(1, { remaining: true, inapplicable: true });
		expect(interactiveBar(inapplicable)).toMatch(/^·+$/);
		expect(cliBar(inapplicable)).toMatch(/^·+$/);
	});
});

describe("the non-TUI /usage text draws a limit the way the other surfaces do", () => {
	it("5% left draws the bar a default limit draws at 5% used, and is not the used-style bar", async () => {
		expect(await plainTextBar(limit(0.95, { remaining: true }))).toBe(await plainTextBar(limit(0.05)));
		expect(await plainTextBar(limit(0.95, { remaining: true }))).not.toBe(await plainTextBar(limit(0.95)));
	});

	it("95% left draws the bar a default limit draws at 95% used", async () => {
		expect(await plainTextBar(limit(0.05, { remaining: true }))).toBe(await plainTextBar(limit(0.95)));
	});

	it("words a remaining-style limit as what is left instead of what is used", async () => {
		const text = await plainTextReport(limit(0.95, { remaining: true }));
		expect(text).toContain("5.0% left");
		expect(text).not.toContain("used");
	});

	it("shows no bar, percent or reset for a window the provider says does not apply", async () => {
		const inapplicable = limit(1, { remaining: true, inapplicable: true });
		inapplicable.window = {
			id: "5h",
			label: "5-hour limit",
			durationMs: 5 * 3_600_000,
			resetsAt: Date.now() + 3_600_000,
		};
		const text = await plainTextReport(inapplicable);
		expect(text).toContain("does not apply right now");
		expect(text).not.toMatch(/\[/);
		expect(text).not.toContain("resets in");
		expect(text).not.toMatch(/\d%/);
	});
});
