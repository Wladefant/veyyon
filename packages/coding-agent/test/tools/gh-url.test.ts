/**
 * SPEC-ONE-PLACE-AUDIT F5: `gh.ts` and `gh-cache-invalidation.ts` used to
 * carry two divergent issue/PR URL regexes (case sensitivity, query/fragment
 * tolerance), so a URL like `…/issues/5?notification_referrer_id=…` or a
 * mixed-case host parsed one way in the fetch path and another in the
 * cache-invalidation path. Both now import the same parsers from `gh-url.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateGithubCacheForBashCommand } from "@veyyon/coding-agent/tools/core/gh-cache-invalidation";
import { parseIssueUrl, parsePrUrl } from "@veyyon/coding-agent/tools/web/gh-url";
import { getCached, putCached, resetForTests } from "@veyyon/coding-agent/tools/web/github-cache";
import { removeWithRetries } from "@veyyon/utils";

describe("parseIssueUrl / parsePrUrl (F5)", () => {
	it("parses a query-string-suffixed issue URL", () => {
		expect(parseIssueUrl("https://github.com/o/r/issues/5?notification_referrer_id=abc")).toEqual({
			repo: "github.com/o/r",
			issueNumber: 5,
		});
	});

	it("parses a mixed-case host issue URL", () => {
		expect(parseIssueUrl("https://GitHub.com/o/r/issues/5")).toEqual({ repo: "GitHub.com/o/r", issueNumber: 5 });
	});

	it("parses a query-string-suffixed PR URL", () => {
		expect(parsePrUrl("https://github.com/o/r/pull/9?diff=unified")).toEqual({
			repo: "github.com/o/r",
			prNumber: 9,
		});
	});

	it("parses a mixed-case host PR URL", () => {
		expect(parsePrUrl("https://GitHub.COM/o/r/pull/9")).toEqual({ repo: "GitHub.COM/o/r", prNumber: 9 });
	});

	it("parses a fragment-suffixed issue URL", () => {
		expect(parseIssueUrl("https://github.com/o/r/issues/5#issuecomment-1")).toEqual({
			repo: "github.com/o/r",
			issueNumber: 5,
		});
	});

	it("rejects whitespace inside owner/repo", () => {
		expect(parseIssueUrl("https://github.com/o r/issues/5")).toEqual({});
		expect(parsePrUrl("https://github.com/o r/pull/5")).toEqual({});
	});

	it("returns {} for non-matching input", () => {
		expect(parseIssueUrl(undefined)).toEqual({});
		expect(parseIssueUrl("not a url")).toEqual({});
		expect(parsePrUrl("https://gitlab.com/o/r/pull/5")).toEqual({});
		expect(parseIssueUrl("https://gitlab.com/o/r/issues/5")).toEqual({});
		expect(parsePrUrl("https://bitbucket.org/o/r/pull/5")).toEqual({});
	});

	it("parses enterprise host issue and PR URLs while preserving host", () => {
		expect(parseIssueUrl("https://ghe.corp.internal/o/r/issues/7")).toEqual({
			repo: "ghe.corp.internal/o/r",
			issueNumber: 7,
		});
		expect(parsePrUrl("https://ghe.corp.internal/o/r/pull/12")).toEqual({
			repo: "ghe.corp.internal/o/r",
			prNumber: 12,
		});
	});
});

describe("gh.ts and gh-cache-invalidation.ts key the same URL identically (F5)", () => {
	let tempDir: string;
	let originalEnv: string | undefined;

	async function withCache(fn: () => Promise<void> | void): Promise<void> {
		originalEnv = process.env.VEYYON_GITHUB_CACHE_DB;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-url-f5-"));
		process.env.VEYYON_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
		resetForTests();
		try {
			await fn();
		} finally {
			resetForTests();
			if (originalEnv === undefined) delete process.env.VEYYON_GITHUB_CACHE_DB;
			else process.env.VEYYON_GITHUB_CACHE_DB = originalEnv;
			await removeWithRetries(tempDir);
		}
	}

	it("invalidates via a query-string issue URL the same way parseIssueUrl parses it", async () => {
		await withCache(() => {
			const repo = "query-string/repo";
			putCached({
				repo,
				kind: "issue",
				number: 5,
				includeComments: true,
				payload: { number: 5 },
				rendered: `issue-${repo}-5`,
				fetchedAt: 1_000,
			});
			const url = "https://github.com/query-string/repo/issues/5?notification_referrer_id=abc";
			expect(parseIssueUrl(url)).toEqual({ repo: `github.com/${repo}`, issueNumber: 5 });
			invalidateGithubCacheForBashCommand(`gh issue close ${url}`);
			expect(getCached(repo, "issue", 5, true)).toBeNull();
			expect(getCached(`github.com/${repo}`, "issue", 5, true)).toBeNull();
		});
	});

	it("invalidates via a mixed-case host PR URL the same way parsePrUrl parses it", async () => {
		await withCache(() => {
			const repo = "mixed-case/repo";
			putCached({
				repo,
				kind: "pr",
				number: 9,
				includeComments: true,
				payload: { number: 9 },
				rendered: `pr-${repo}-9`,
				fetchedAt: 1_000,
			});
			const url = "https://GitHub.com/mixed-case/repo/pull/9";
			expect(parsePrUrl(url)).toEqual({ repo: `GitHub.com/${repo}`, prNumber: 9 });
			invalidateGithubCacheForBashCommand(`gh pr close ${url}`);
			expect(getCached(repo, "pr", 9, true)).toBeNull();
			expect(getCached(`GitHub.com/${repo}`, "pr", 9, true)).toBeNull();
		});
	});

	it("invalidates via an enterprise host PR URL with matching cache key", async () => {
		await withCache(() => {
			const repo = "ghe.corp.internal/enterprise/repo";
			putCached({
				repo,
				kind: "pr",
				number: 12,
				includeComments: true,
				payload: { number: 12 },
				rendered: `pr-${repo}-12`,
				fetchedAt: 1_000,
			});
			const url = "https://ghe.corp.internal/enterprise/repo/pull/12";
			expect(parsePrUrl(url)).toEqual({ repo, prNumber: 12 });
			invalidateGithubCacheForBashCommand(`gh pr close ${url}`);
			expect(getCached(repo, "pr", 12, true)).toBeNull();
		});
	});

	it("invalidates via an enterprise host issue URL with matching cache key", async () => {
		await withCache(() => {
			const repo = "ghe.corp.internal/enterprise/repo";
			putCached({
				repo,
				kind: "issue",
				number: 7,
				includeComments: true,
				payload: { number: 7 },
				rendered: `issue-${repo}-7`,
				fetchedAt: 1_000,
			});
			const url = "https://ghe.corp.internal/enterprise/repo/issues/7";
			expect(parseIssueUrl(url)).toEqual({ repo, issueNumber: 7 });
			invalidateGithubCacheForBashCommand(`gh issue close ${url}`);
			expect(getCached(repo, "issue", 7, true)).toBeNull();
		});
	});
});
