/**
 * WHY THIS EXISTS. Cursor answers a plan whose allowance is spent with `resource_exhausted: … You're
 * out of usage … (ERROR_RATE_LIMITED)`. The quota rules read it as a usage limit, so the turn parked
 * the account, but the park's length comes from `parseRateLimitReason`, which strips the status token
 * and found no quota phrase left. It returned MODEL_CAPACITY_EXHAUSTED, a 45 to 75 second park sized
 * for a busy server, and the session retried the spent plan about once a minute: three attempts per
 * turn, three turns per goal, and a withheld-account notice for every one.
 *
 * THE CLASS THIS CLOSES. A failure the field produced that is an account wall, read by the park as a
 * capacity blip. The sweep below drives the field corpus through the two readings the retry runtime
 * combines for a usage-limit park, the body's own retry hint and else the reason's
 * `credential-park` backoff, and requires every usage-limit wall to park at least as long as a
 * spent quota. A wall added to the corpus that parks shorter turns this red until it is either read
 * correctly or pinned below with the reason.
 *
 * WHAT IT DOES NOT CATCH. It reads the corpus, so a wall worded in a way the field has not produced
 * yet is not covered. It computes the park from the same two readings `RetryRuntime` combines rather
 * than driving a session; the retry runtime's own suites cover what it does with the park. A body
 * that is a wall only because of its HTTP status, with no words, is decided by the status rules and
 * has its own suite.
 */
import { describe, expect, it } from "bun:test";
import { isUsageLimit } from "@veyyon/ai/error/flags";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@veyyon/ai/error/rate-limit";
import { extractRetryHint } from "@veyyon/utils/fetch-retry";
import { OBSERVED_PROVIDER_ERRORS } from "./fixtures/provider-errors-observed-in-the-field";

const SPENT_QUOTA_PARK_MS = calculateRateLimitBackoffMs("QUOTA_EXHAUSTED", "credential-park");

/**
 * Usage-limit walls that park for less than a spent quota, pinned by exact equality.
 *
 * `Connect error resource_exhausted: Error` states nothing but the status token. Google serves the
 * same token for its per-minute throttle, so a bare token reads as capacity on purpose: a wrong long
 * park ends a turn a forty-second wait would have saved.
 */
const SHORT_PARKED_WALLS: readonly string[] = ["Connect error resource_exhausted: Error"];

function parkMs(message: string): number {
	return (
		extractRetryHint(undefined, message) ??
		calculateRateLimitBackoffMs(parseRateLimitReason(message), "credential-park")
	);
}

const usageLimitWalls = OBSERVED_PROVIDER_ERRORS.filter(
	entry => entry.verdict === "wall" && isUsageLimit(entry.message),
).map(entry => entry.message);

describe("a spent allowance is parked for its window, not a capacity blip", () => {
	it("parks every usage-limit wall the field produced at least as long as a spent quota", () => {
		const short = usageLimitWalls.filter(message => parkMs(message) < SPENT_QUOTA_PARK_MS);
		expect(short).toEqual([...SHORT_PARKED_WALLS]);
	});

	it("reads Cursor's out-of-usage answer as a spent quota, with or without the status token", () => {
		const sentence =
			"Increase limits for faster responses: You're out of usage. Switch to Auto or Composer 2.5, or ask your admin to increase your limit to continue. (ERROR_RATE_LIMITED)";
		for (const message of [`Connect error resource_exhausted: ${sentence}`, sentence]) {
			expect(isUsageLimit(message)).toBe(true);
			expect(parseRateLimitReason(message)).toBe("QUOTA_EXHAUSTED");
		}
	});
});
