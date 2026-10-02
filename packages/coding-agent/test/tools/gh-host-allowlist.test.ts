/**
 * `gh` attaches a host's token to whatever host it is handed, so a host that
 * arrives in user or model input (a URL, a `host/owner/repo` ref, `pr://host/...`)
 * must be one of: github.com, the GH_HOST host, or the current checkout's host.
 * Anything else, `attacker.invalid` here, is refused before `gh` is spawned.
 *
 * Covers the parsers and the internal-URL protocol. The `github` tool's own routes
 * (repo, run URL, PR URL) are in `gh.test.ts`. What it does not catch: a NEW host
 * source that never calls `assertAllowedGhHost`; each route is listed by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IssueProtocolHandler, PrProtocolHandler } from "@veyyon/coding-agent/internal-urls/issue-pr-protocol";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";
import { resolveDefaultRepoMemoized } from "@veyyon/coding-agent/tools/web/gh";
import {
	appendRepoFlag,
	assertAllowedGhHost,
	parseRepoRef,
	resetCheckoutHosts,
} from "@veyyon/coding-agent/tools/web/gh-format";
import { parseIssueUrl, parsePrUrl } from "@veyyon/coding-agent/tools/web/gh-url";
import { getCached, putCached, resetForTests as resetCacheForTests } from "@veyyon/coding-agent/tools/web/github-cache";
import * as git from "@veyyon/coding-agent/utils/git";
import { removeWithRetries } from "@veyyon/utils";

const NOT_ALLOWED = /attacker\.invalid.*not allowed/;

let savedGhHost: string | undefined;
let savedCacheDb: string | undefined;
let tempDir: string;

beforeEach(async () => {
	savedGhHost = process.env.GH_HOST;
	savedCacheDb = process.env.VEYYON_GITHUB_CACHE_DB;
	delete process.env.GH_HOST;
	resetCheckoutHosts();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-host-allowlist-"));
	process.env.VEYYON_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetCacheForTests();
	resetCheckoutHosts();
	if (savedGhHost === undefined) delete process.env.GH_HOST;
	else process.env.GH_HOST = savedGhHost;
	if (savedCacheDb === undefined) delete process.env.VEYYON_GITHUB_CACHE_DB;
	else process.env.VEYYON_GITHUB_CACHE_DB = savedCacheDb;
	await removeWithRetries(tempDir);
});

describe("host allowlist on every input route", () => {
	it("refuses attacker.invalid in PR and issue URLs, repo refs and --repo", () => {
		expect(() => parsePrUrl("https://attacker.invalid/o/r/pull/1")).toThrow(NOT_ALLOWED);
		expect(() => parseIssueUrl("https://attacker.invalid/o/r/issues/1")).toThrow(NOT_ALLOWED);
		expect(() => parseRepoRef("attacker.invalid/o/r")).toThrow(NOT_ALLOWED);
		expect(() => appendRepoFlag([], "attacker.invalid/o/r")).toThrow(NOT_ALLOWED);
		// A full-URL identifier carries its own host and skips `--repo`; it is checked too.
		expect(() => appendRepoFlag([], undefined, "https://attacker.invalid/o/r/pull/1")).toThrow(NOT_ALLOWED);
		expect(() => appendRepoFlag([], undefined, "http://attacker.invalid/o/r/pull/1")).toThrow(NOT_ALLOWED);
	});

	it("refuses attacker.invalid in issue:// and pr:// URLs, in every shape", async () => {
		const spies = [
			vi.spyOn(git.github, "json").mockResolvedValue([]),
			vi.spyOn(git.github, "text").mockResolvedValue(""),
			vi.spyOn(git.github, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
		];
		const urls: Array<[IssueProtocolHandler | PrProtocolHandler, string]> = [
			[new IssueProtocolHandler(), "issue://attacker.invalid/o/r"],
			[new IssueProtocolHandler(), "issue://attacker.invalid/o/r/7"],
			[new PrProtocolHandler(), "pr://attacker.invalid/o/r"],
			[new PrProtocolHandler(), "pr://attacker.invalid/o/r/7"],
			[new PrProtocolHandler(), "pr://attacker.invalid/o/r/7/diff"],
			[new PrProtocolHandler(), "pr://attacker.invalid/o/r/7/diff/all"],
		];
		for (const [handler, url] of urls) {
			await expect(handler.resolve(parseInternalUrl(url))).rejects.toThrow(NOT_ALLOWED);
		}
		// A single-label host is only recognized by the number's position.
		await expect(new PrProtocolHandler().resolve(parseInternalUrl("pr://attacker/o/r/7"))).rejects.toThrow(
			/"attacker".*not allowed/,
		);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("accepts github.com on every route", () => {
		expect(parsePrUrl("https://github.com/o/r/pull/1")).toEqual({ repo: "github.com/o/r", prNumber: 1 });
		expect(parseIssueUrl("https://github.com/o/r/issues/1")).toEqual({ repo: "github.com/o/r", issueNumber: 1 });
		expect(parseRepoRef("github.com/o/r")).toEqual({ host: "github.com", slug: "o/r" });
		expect(() => assertAllowedGhHost("GitHub.com")).not.toThrow();
	});

	it("accepts the GH_HOST host, case-insensitively, and only while it is set", async () => {
		process.env.GH_HOST = "GHE.corp";
		expect(parsePrUrl("https://ghe.corp/o/r/pull/2")).toEqual({ repo: "ghe.corp/o/r", prNumber: 2 });
		expect(parseRepoRef("ghe.corp/o/r").host).toBe("ghe.corp");
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([]);
		await new PrProtocolHandler().resolve(parseInternalUrl("pr://ghe.corp/o/r"));
		expect(spy).toHaveBeenCalled();

		delete process.env.GH_HOST;
		expect(() => parsePrUrl("https://ghe.corp/o/r/pull/2")).toThrow(/not allowed/);
	});

	it("accepts the current checkout's host once it is resolved", async () => {
		expect(() => parseRepoRef("ghe.checkout/o/r")).toThrow(/not allowed/);
		vi.spyOn(git.github, "text").mockResolvedValue("https://ghe.checkout/acme/widgets\n");

		await resolveDefaultRepoMemoized(`${tempDir}/checkout`);

		expect(parseRepoRef("ghe.checkout/o/r").host).toBe("ghe.checkout");
		expect(parsePrUrl("https://ghe.checkout/o/r/pull/3").prNumber).toBe(3);
		expect(() => parseRepoRef("attacker.invalid/o/r")).toThrow(NOT_ALLOWED);
	});
});

describe("github cache keys with GH_HOST set", () => {
	function put(repo: string, rendered: string): void {
		putCached({
			repo,
			kind: "pr",
			number: 7,
			includeComments: true,
			payload: { number: 7 },
			rendered,
			fetchedAt: 1_000,
		});
	}

	it("keeps github.com/acme/widgets and the bare slug apart when the bare slug means ghe.corp", () => {
		process.env.GH_HOST = "ghe.corp";
		put("github.com/acme/widgets", "from github.com");
		put("acme/widgets", "from ghe.corp");

		expect(getCached("github.com/acme/widgets", "pr", 7, true)?.rendered).toBe("from github.com");
		expect(getCached("acme/widgets", "pr", 7, true)?.rendered).toBe("from ghe.corp");
		// ...while the auth host's own prefix still folds into the bare spelling.
		expect(getCached("ghe.corp/acme/widgets", "pr", 7, true)?.rendered).toBe("from ghe.corp");
	});

	it("still folds github.com/ into the bare slug without enterprise config", () => {
		put("github.com/acme/widgets", "one row");

		expect(getCached("acme/widgets", "pr", 7, true)?.rendered).toBe("one row");
	});
});
