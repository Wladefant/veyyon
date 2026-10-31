import type { SegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import { NO_SESSION_FACTS } from "@veyyon/coding-agent/modes/terminal/components/status-line/session-facts";

/** A session that has spent nothing: every counter zero, no rate yet. Spread it to vary a counter. */
export const RESTING_USAGE_STATS: Readonly<SegmentContext["usageStats"]> = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
	tokensPerSecond: null,
});

/**
 * The context a status-line segment renders against when nothing has happened: no session facts,
 * no mode, nothing spent, no repository, a 120-column row. Each call builds fresh `usageStats`,
 * `options` and `git` objects, so a suite may assign into them; `facts` is the shared
 * `NO_SESSION_FACTS`, so a suite spreads it rather than assigning into it. Each override replaces its
 * field whole, so a suite states only the fields its segment reads.
 */
export function segmentContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		facts: NO_SESSION_FACTS,
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: { ...RESTING_USAGE_STATS },
		contextPercent: 0,
		contextWindow: 0,
		contextLimit: 0,
		contextLimitKind: "window",
		autoCompactEnabled: false,
		agentCount: 0,
		backgroundSessionCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		account: null,
		usage: null,
		...overrides,
	};
}
