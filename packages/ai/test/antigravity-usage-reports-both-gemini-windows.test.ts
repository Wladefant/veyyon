/**
 * WHY: `/usage`, the provider selector and `veyyon usage --json` showed only the
 * Claude and GPT rows for Google Antigravity. The Gemini 5-hour and weekly rows
 * were gone. `retrieveUserQuotaSummary` lists the "Gemini Models" group only to a
 * client whose `antigravity/hub/<version>` user agent reports 3.0.0 or later. A
 * live probe on 2026-10-20 returned only "Claude and GPT models" for 2.1.4 and
 * both groups for 3.0.0. A build that sent 2.1.4 therefore got a summary without
 * Gemini, and the models listing cannot restore it: a listing entry carries one
 * reset and names no window, so it yields at most one Gemini row, never both.
 *
 * The class this closes: any change that makes the usage probe identify as a
 * client the summary endpoint hides Gemini from (a version rollback, a dropped or
 * renamed User-Agent header, a second header builder) leaves the report without
 * the Gemini windows, and this suite turns red.
 *
 * Gap: the fake server models the summary gating only. It does not model how the
 * listing is gated, and it does not prove that the real endpoint still uses 3.0.0
 * as its threshold; a later server-side bump needs a new live probe.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai/types";
import type { UsageFetchParams } from "@veyyon/ai/usage";
import { antigravityUsageProvider } from "@veyyon/ai/usage/google-antigravity";

const HOUR_MS = 60 * 60 * 1000;

function credential(): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: "access-token-fixture",
		refreshToken: "refresh-token-fixture",
		expiresAt: Date.now() + HOUR_MS,
		projectId: "project-fixture",
		email: "user@example.com",
	};
}

/** The 3p group, as the endpoint returns it to every client version. */
function claudeAndGptGroup(nowMs: number) {
	return {
		displayName: "Claude and GPT models",
		description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
		buckets: [
			{
				bucketId: "3p-weekly",
				displayName: "Weekly Limit Remaining",
				window: "weekly",
				resetTime: new Date(nowMs + 6 * 24 * HOUR_MS).toISOString(),
				remainingFraction: 1,
			},
			{
				bucketId: "3p-5h",
				displayName: "Five Hour Limit Remaining",
				window: "5h",
				resetTime: new Date(nowMs + 4 * HOUR_MS).toISOString(),
				remainingFraction: 1,
			},
		],
	};
}

/**
 * The Gemini group in the shape the live endpoint returned: the weekly limit is
 * spent, so the 5-hour bucket is disabled and still carries a stale fraction.
 */
function geminiGroup(nowMs: number) {
	return {
		displayName: "Gemini Models",
		description: "Models within this group: Gemini Flash, Gemini Pro",
		buckets: [
			{
				bucketId: "gemini-weekly",
				displayName: "Weekly Limit Remaining",
				window: "weekly",
				resetTime: new Date(nowMs + 3 * 24 * HOUR_MS).toISOString(),
				description: "You have hit your weekly limit.",
				remainingFraction: 0,
			},
			{
				bucketId: "gemini-5h",
				displayName: "Five Hour Limit Remaining",
				window: "5h",
				resetTime: new Date(nowMs + HOUR_MS).toISOString(),
				description: "You have hit your weekly limit, the 5-hour limit does not currently apply.",
				disabled: true,
				remainingFraction: 0.7,
			},
		],
	};
}

/** The major version an `antigravity/hub/<version> <os>/<arch>` user agent reports. */
function reportedMajorVersion(userAgent: string | null): number | undefined {
	const match = /^antigravity\/hub\/(\d+)\./.exec(userAgent ?? "");
	return match ? Number(match[1]) : undefined;
}

/**
 * A Cloud Code Assist stand-in that gates the summary the way the live endpoint
 * does: Gemini is listed only to a client reporting 3.0.0 or later.
 */
function gatedEndpoint(nowMs: number): { fetch: FetchImpl; userAgents: (string | null)[] } {
	const userAgents: (string | null)[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const userAgent = new Headers(init?.headers).get("User-Agent");
		userAgents.push(userAgent);
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		if (String(input).endsWith("/v1internal:retrieveUserQuotaSummary")) {
			const showsGemini = (reportedMajorVersion(userAgent) ?? 0) >= 3;
			const groups = showsGemini ? [geminiGroup(nowMs), claudeAndGptGroup(nowMs)] : [claudeAndGptGroup(nowMs)];
			return json({ groups });
		}
		// Not modelled: what the listing returns to an old client. Answering with
		// no models keeps the summary the only source of Gemini rows.
		return json({ models: {} });
	};
	return { fetch, userAgents };
}

describe("an Antigravity usage probe reports both Gemini windows", () => {
	it("identifies as a client the quota summary lists the Gemini group to", async () => {
		const nowMs = Date.now();
		const endpoint = gatedEndpoint(nowMs);
		const report = await antigravityUsageProvider.fetchUsage(
			{ provider: "google-antigravity", credential: credential(), baseUrl: "https://gateway.example" },
			{ fetch: endpoint.fetch },
		);

		const rows = (report?.limits ?? []).map(limit => [limit.id, limit.label, limit.window?.id, limit.status]);
		expect(rows).toEqual(
			expect.arrayContaining([
				["google-antigravity:google:default:weekly", "Gemini Models", "weekly", "exhausted"],
				["google-antigravity:google:default:5h", "Gemini Models", "5h", "exhausted"],
				["google-antigravity:claude-gpt:default:weekly", "Claude and GPT models", "weekly", "ok"],
				["google-antigravity:claude-gpt:default:5h", "Claude and GPT models", "5h", "ok"],
			]),
		);
		expect(rows).toHaveLength(4);
		// Every call identified itself; none fell back to a header-less request.
		expect(endpoint.userAgents.every(userAgent => reportedMajorVersion(userAgent) !== undefined)).toBe(true);
	});

	it("marks the disabled Gemini 5-hour bucket inapplicable with the endpoint's own reason", async () => {
		const nowMs = Date.now();
		const report = await antigravityUsageProvider.fetchUsage(
			{ provider: "google-antigravity", credential: credential(), baseUrl: "https://gateway.example" },
			{ fetch: gatedEndpoint(nowMs).fetch },
		);

		const gemini5h = report?.limits.find(limit => limit.id === "google-antigravity:google:default:5h");
		expect(gemini5h?.amount.remainingFraction).toBe(0);
		expect(gemini5h?.display).toEqual({ remaining: true, inapplicable: true });
		expect(gemini5h?.notes).toEqual(["You have hit your weekly limit, the 5-hour limit does not currently apply."]);
		expect(gemini5h?.window?.resetsAt).toBe(nowMs + HOUR_MS);
	});
});
