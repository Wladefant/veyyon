/**
 * Hard-refusal guard for Bavariance/polysimulator main branch.
 *
 * GitHub Free cannot enforce branch protection rulesets server-side,
 * so this agent tooling fail-closed guard ensures that no agent can
 * ever merge a PR into `main` or push to `main` on Bavariance/polysimulator.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRepositorySync } from "../../utils/git-head";
import { splitCommandSegments, splitWords } from "../shell/bash-guard";

export const POLYSIM_MAIN_DENIAL_MESSAGE =
	"main requires both founders' approval; agents never merge or push to main";

export const POLYSIM_REPO_SLUG = "bavariance/polysimulator";

export interface PolysimDenialResult {
	readonly reason: string;
	readonly targetRepo?: string;
	readonly command?: string;
}

export type PrBaseResolver = (
	pr: string | number | undefined,
	repo: string | undefined,
	cwd: string,
) => string | undefined;

export interface PolysimGuardOptions {
	readonly resolvePrBase?: PrBaseResolver;
	readonly getRemotes?: (cwd: string) => Record<string, string>;
	readonly getCurrentBranch?: (cwd: string) => string | undefined;
}

/**
 * Returns true if the string matches `Bavariance/polysimulator` (case-insensitive).
 */
export function isPolysimulatorRepo(repo?: string): boolean {
	if (!repo || typeof repo !== "string") return false;
	const normalized = repo.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
	return (
		normalized === POLYSIM_REPO_SLUG ||
		normalized === `${POLYSIM_REPO_SLUG}.git` ||
		normalized.endsWith(`/${POLYSIM_REPO_SLUG}`) ||
		normalized.endsWith(`/${POLYSIM_REPO_SLUG}.git`)
	);
}

/**
 * Returns true if a remote URL points to `Bavariance/polysimulator`.
 */
export function isPolysimulatorRemoteUrl(url?: string): boolean {
	if (!url || typeof url !== "string") return false;
	const lower = url.trim().toLowerCase();
	return (
		lower.includes("github.com/bavariance/polysimulator") ||
		lower.includes("github.com:bavariance/polysimulator")
	);
}

/**
 * Reads git remotes from the repository's configuration synchronously.
 */
export function getGitRemoteUrlsSync(cwd: string): Record<string, string> {
	const remotes: Record<string, string> = {};
	try {
		const repo = resolveRepositorySync(cwd);
		if (!repo) return remotes;
		const configPath = path.join(repo.commonDir, "config");
		if (!fs.existsSync(configPath)) return remotes;
		const content = fs.readFileSync(configPath, "utf8");
		const lines = content.split(/\r?\n/);
		let currentRemote: string | null = null;
		for (const line of lines) {
			const trimmed = line.trim();
			const sectionMatch = trimmed.match(/^\[remote\s+"([^"]+)"\]$/i);
			if (sectionMatch) {
				currentRemote = sectionMatch[1];
				continue;
			}
			if (currentRemote && trimmed.startsWith("[")) {
				currentRemote = null;
				continue;
			}
			if (currentRemote) {
				const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/i);
				if (urlMatch) {
					remotes[currentRemote] = urlMatch[1].trim();
				}
			}
		}
	} catch {
		// Ignore filesystem errors
	}
	return remotes;
}

/**
 * Returns true if any configured remote in cwd points to `Bavariance/polysimulator`.
 */
export function isCwdPolysimulatorRepo(
	cwd: string,
	getRemotes: (dir: string) => Record<string, string> = getGitRemoteUrlsSync,
): boolean {
	const remotes = getRemotes(cwd);
	for (const url of Object.values(remotes)) {
		if (isPolysimulatorRemoteUrl(url)) {
			return true;
		}
	}
	return false;
}

/**
 * Checks if a refspec string targets `main` or `refs/heads/main`.
 */
export function isMainRefspec(refspec: string): boolean {
	let ref = refspec.trim();
	if (ref.startsWith("+")) ref = ref.slice(1);
	if (ref.includes(":")) {
		const parts = ref.split(":");
		ref = parts[parts.length - 1];
	}
	ref = ref.trim().toLowerCase();
	return ref === "main" || ref === "refs/heads/main" || ref.endsWith("/main");
}

/**
 * Default resolver for a PR's base branch using `gh pr view`.
 */
export function defaultResolvePrBase(
	pr: string | number | undefined,
	repo: string | undefined,
	cwd: string,
): string | undefined {
	try {
		const args = ["pr", "view"];
		if (pr !== undefined && String(pr).trim() !== "") {
			args.push(String(pr).trim());
		}
		if (repo) {
			args.push("--repo", repo);
		}
		args.push("--json", "baseRefName", "-q", ".baseRefName");
		const output = execFileSync("gh", args, {
			cwd: cwd || process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Get current git branch for a directory synchronously.
 */
export function getCurrentGitBranchSync(cwd: string): string | undefined {
	try {
		const repo = resolveRepositorySync(cwd);
		if (!repo) return undefined;
		const headContent = fs.readFileSync(repo.headPath, "utf8").trim();
		if (headContent.startsWith("ref:")) {
			const ref = headContent.slice(4).trim();
			return ref.replace(/^refs\/heads\//, "");
		}
	} catch {
		// Ignore error
	}
	return undefined;
}

interface ParsedCommandInvocation {
	readonly binary: string;
	readonly words: string[];
	readonly rawSegment: string;
}

function parseSegmentWords(segment: string): ParsedCommandInvocation | null {
	const wordObjects = splitWords(segment);
	if (wordObjects.length === 0) return null;
	const words = wordObjects.map(w => w.text.trim()).filter(Boolean);
	if (words.length === 0) return null;
	const binary = path.basename(words[0]).toLowerCase().replace(/\.exe$/i, "");
	return { binary, words, rawSegment: segment };
}

/**
 * Checks a `git push` invocation.
 */
function checkGitPushInvocation(
	words: string[],
	cwd: string,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const getRemotes = options?.getRemotes ?? getGitRemoteUrlsSync;
	const getCurrentBranch = options?.getCurrentBranch ?? getCurrentGitBranchSync;

	let index = 1;
	let effectiveCwd = cwd;

	// Handle leading options before git subcommand
	while (index < words.length) {
		const word = words[index];
		if (word === "-C" && index + 1 < words.length) {
			effectiveCwd = path.resolve(effectiveCwd, words[index + 1]);
			index += 2;
			continue;
		}
		if (word.startsWith("-C") && word.length > 2) {
			effectiveCwd = path.resolve(effectiveCwd, word.slice(2));
			index++;
			continue;
		}
		if (!word.startsWith("-")) {
			break;
		}
		index++;
	}

	if (index >= words.length || words[index] !== "push") {
		return undefined;
	}

	// Move past "push"
	index++;

	const pushFlagsWithValue: Record<string, true> = {
		"--repo": true,
		"-o": true,
		"--push-option": true,
		"--receive-pack": true,
		"--exec": true,
	};

	let explicitRemoteUrl: string | undefined;
	let explicitRemoteName: string | undefined;
	const positionalArgs: string[] = [];
	let hasAllFlag = false;
	let hasMirrorFlag = false;

	while (index < words.length) {
		const word = words[index];
		if (word === "--all") {
			hasAllFlag = true;
			index++;
			continue;
		}
		if (word === "--mirror") {
			hasMirrorFlag = true;
			index++;
			continue;
		}
		if (word.startsWith("--repo=")) {
			explicitRemoteUrl = word.slice(7);
			index++;
			continue;
		}
		if (word === "--repo" && index + 1 < words.length) {
			explicitRemoteUrl = words[index + 1];
			index += 2;
			continue;
		}
		if (pushFlagsWithValue[word] && index + 1 < words.length) {
			index += 2;
			continue;
		}
		if (word.startsWith("-")) {
			// Other flags like -u, --force, --force-with-lease, etc.
			index++;
			continue;
		}
		positionalArgs.push(word);
		index++;
	}

	const remotes = getRemotes(effectiveCwd);

	// Determine destination remote
	let isTargetPolysim = false;
	let refspecs: string[] = [];

	if (explicitRemoteUrl) {
		isTargetPolysim = isPolysimulatorRepo(explicitRemoteUrl) || isPolysimulatorRemoteUrl(explicitRemoteUrl);
		refspecs = positionalArgs;
	} else if (positionalArgs.length > 0) {
		const firstPositional = positionalArgs[0];
		if (isPolysimulatorRemoteUrl(firstPositional) || isPolysimulatorRepo(firstPositional)) {
			isTargetPolysim = true;
			refspecs = positionalArgs.slice(1);
		} else if (Object.hasOwn(remotes, firstPositional)) {
			explicitRemoteName = firstPositional;
			const remoteUrl = remotes[firstPositional];
			isTargetPolysim = isPolysimulatorRemoteUrl(remoteUrl);
			refspecs = positionalArgs.slice(1);
		} else {
			// The first positional may be a refspec pushing to default remote
			isTargetPolysim = isCwdPolysimulatorRepo(effectiveCwd, getRemotes);
			refspecs = positionalArgs;
		}
	} else {
		// Bare `git push` with no repository or refspec
		isTargetPolysim = isCwdPolysimulatorRepo(effectiveCwd, getRemotes);
	}

	if (!isTargetPolysim) {
		return undefined;
	}

	// It IS target Polysimulator. Now check what is being pushed.
	if (hasAllFlag || hasMirrorFlag) {
		return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
	}

	if (refspecs.length > 0) {
		for (const ref of refspecs) {
			if (isMainRefspec(ref)) {
				return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
			}
		}
		return undefined;
	}

	// No explicit refspecs: git push pushes current branch or tracking branch.
	// Fail closed if on main or if branch is unknown.
	const currentBranch = getCurrentBranch(effectiveCwd);
	if (!currentBranch || currentBranch.toLowerCase() === "main") {
		return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
	}

	return undefined;
}

/**
 * Checks a `gh pr merge` invocation.
 */
function checkGhPrMergeInvocation(
	words: string[],
	cwd: string,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const getRemotes = options?.getRemotes ?? getGitRemoteUrlsSync;
	const resolvePr = options?.resolvePrBase ?? defaultResolvePrBase;

	let explicitRepo: string | undefined;
	let prIdentifier: string | undefined;
	let isPrMerge = false;

	// Extract flags and subcommands
	let i = 1;
	while (i < words.length) {
		const word = words[i];
		if (word === "pr" && i + 1 < words.length && words[i + 1] === "merge") {
			isPrMerge = true;
			i += 2;
			continue;
		}
		if (word === "--repo" && i + 1 < words.length) {
			explicitRepo = words[i + 1];
			i += 2;
			continue;
		}
		if (word.startsWith("--repo=")) {
			explicitRepo = word.slice(7);
			i++;
			continue;
		}
		if (word === "-R" && i + 1 < words.length) {
			explicitRepo = words[i + 1];
			i += 2;
			continue;
		}
		if (word.startsWith("-R=")) {
			explicitRepo = word.slice(3);
			i++;
			continue;
		}
		if (isPrMerge && !word.startsWith("-") && prIdentifier === undefined) {
			prIdentifier = word;
			i++;
			continue;
		}
		i++;
	}

	if (!isPrMerge) {
		return undefined;
	}

	// Check if target is Polysimulator
	let isTargetPolysim = false;
	if (explicitRepo) {
		isTargetPolysim = isPolysimulatorRepo(explicitRepo) || isPolysimulatorRemoteUrl(explicitRepo);
	} else if (prIdentifier && isPolysimulatorRemoteUrl(prIdentifier)) {
		isTargetPolysim = true;
	} else {
		isTargetPolysim = isCwdPolysimulatorRepo(cwd, getRemotes);
	}

	if (!isTargetPolysim) {
		return undefined;
	}

	// Target IS Polysimulator.
	// Resolve base branch. Fail-closed: if base is main OR unknown, deny!
	const base = resolvePr(prIdentifier, explicitRepo, cwd);
	if (!base || base.toLowerCase().trim() === "main" || base.toLowerCase().trim() === "refs/heads/main") {
		return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
	}

	return undefined;
}

/**
 * Checks a `gh api` invocation.
 */
function checkGhApiInvocation(
	words: string[],
	cwd: string,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const getRemotes = options?.getRemotes ?? getGitRemoteUrlsSync;

	let i = 1;
	let endpoint: string | undefined;
	let method: string | undefined;
	let explicitRepo: string | undefined;

	while (i < words.length) {
		const word = words[i];
		if (word === "api") {
			i++;
			continue;
		}
		if (word === "-X" && i + 1 < words.length) {
			i += 2;
			continue;
		}
		if (word.startsWith("-X") && word.length > 2) {
			method = word.slice(2).toUpperCase();
			i++;
			continue;
		}
		if (word === "--method" && i + 1 < words.length) {
			method = words[i + 1].toUpperCase();
			i += 2;
			continue;
		}
		if (word.startsWith("--method=")) {
			method = word.slice(9).toUpperCase();
			i++;
			continue;
		}
		if (word === "-R" && i + 1 < words.length) {
			explicitRepo = words[i + 1];
			i += 2;
			continue;
		}
		if (word.startsWith("-R=")) {
			explicitRepo = word.slice(3);
			i++;
			continue;
		}
		if (word === "--repo" && i + 1 < words.length) {
			explicitRepo = words[i + 1];
			i += 2;
			continue;
		}
		if (word.startsWith("--repo=")) {
			explicitRepo = word.slice(7);
			i++;
			continue;
		}
		if (word.startsWith("-")) {
			i++;
			continue;
		}
		if (!endpoint) {
			endpoint = word;
		}
		i++;
	}

	if (!endpoint) return undefined;

	const normalizedEndpoint = endpoint.trim().replace(/^\/+/, "");

	// Check if endpoint is for Bavariance/polysimulator
	let isTargetPolysim = false;
	let relativeEndpoint = normalizedEndpoint;

	if (
		normalizedEndpoint.toLowerCase().startsWith("repos/bavariance/polysimulator/") ||
		normalizedEndpoint.toLowerCase().startsWith("repos/bavariance/polysimulator.git/")
	) {
		isTargetPolysim = true;
		relativeEndpoint = normalizedEndpoint.slice(normalizedEndpoint.indexOf("/", 6) + 1);
		if (relativeEndpoint.toLowerCase().startsWith("polysimulator/")) {
			relativeEndpoint = relativeEndpoint.slice("polysimulator/".length);
		}
	} else if (explicitRepo) {
		isTargetPolysim = isPolysimulatorRepo(explicitRepo) || isPolysimulatorRemoteUrl(explicitRepo);
		if (relativeEndpoint.toLowerCase().startsWith("repos/:owner/:repo/")) {
			relativeEndpoint = relativeEndpoint.slice("repos/:owner/:repo/".length);
		}
	} else {
		isTargetPolysim = isCwdPolysimulatorRepo(cwd, getRemotes);
		if (relativeEndpoint.toLowerCase().startsWith("repos/:owner/:repo/")) {
			relativeEndpoint = relativeEndpoint.slice("repos/:owner/:repo/".length);
		}
	}

	if (!isTargetPolysim) return undefined;

	// Check Form 3a: PUT to .../pulls/<n>/merge
	if (/^pulls\/\d+\/merge$/i.test(relativeEndpoint)) {
		// gh api default method for merge is PUT, or explicit PUT, or mutating
		const effectiveMethod = method ?? "PUT";
		if (effectiveMethod === "PUT" || effectiveMethod === "POST") {
			return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
		}
	}

	// Check Form 3b: PATCH/POST to git/refs/heads/main
	if (
		relativeEndpoint.toLowerCase() === "git/refs/heads/main" ||
		relativeEndpoint.toLowerCase() === "git/refs/heads/main/"
	) {
		const effectiveMethod = method ?? "PATCH";
		if (effectiveMethod === "PATCH" || effectiveMethod === "POST" || effectiveMethod === "PUT") {
			return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
		}
	}

	return undefined;
}

/**
 * Checks a single bash command string against all Bavariance/polysimulator main rules.
 */
export function checkPolysimMainDenial(
	command: string,
	cwd: string,
	_env?: NodeJS.ProcessEnv,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	if (!command || typeof command !== "string") return undefined;

	const segments = splitCommandSegments(command);
	for (const segment of segments) {
		const parsed = parseSegmentWords(segment);
		if (!parsed) continue;

		if (parsed.binary === "git") {
			const denial = checkGitPushInvocation(parsed.words, cwd, options);
			if (denial) return denial;
		} else if (parsed.binary === "gh") {
			if (parsed.words.includes("pr") && parsed.words.includes("merge")) {
				const denial = checkGhPrMergeInvocation(parsed.words, cwd, options);
				if (denial) return denial;
			}
			if (parsed.words.includes("api")) {
				const denial = checkGhApiInvocation(parsed.words, cwd, options);
				if (denial) return denial;
			}
		}
	}

	return undefined;
}

/**
 * Checks a `github` tool call invocation against the Bavariance/polysimulator main rules.
 */
export function checkGithubToolPolysimMainDenial(
	args: unknown,
	cwd: string,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const op = typeof record.op === "string" ? record.op : "";

	if (op !== "pr_merge" && op !== "pr_push") {
		return undefined;
	}

	const getRemotes = options?.getRemotes ?? getGitRemoteUrlsSync;
	const resolvePr = options?.resolvePrBase ?? defaultResolvePrBase;

	const repo = typeof record.repo === "string" ? record.repo : undefined;
	let isTargetPolysim = false;

	if (repo) {
		isTargetPolysim = isPolysimulatorRepo(repo) || isPolysimulatorRemoteUrl(repo);
	} else {
		isTargetPolysim = isCwdPolysimulatorRepo(cwd, getRemotes);
	}

	if (!isTargetPolysim) {
		return undefined;
	}
	if (op === "pr_push") {
		const branch = typeof record.branch === "string" ? record.branch.trim().toLowerCase() : undefined;
		if (branch && (branch === "main" || branch === "refs/heads/main" || branch.endsWith("/main"))) {
			return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
		}
		return undefined;
	}


	const explicitBase = typeof record.base === "string" ? record.base.trim().toLowerCase() : undefined;
	if (explicitBase) {
		if (explicitBase === "main" || explicitBase === "refs/heads/main" || explicitBase.endsWith("/main")) {
			return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
		}
		// Explicit base is not main
		return undefined;
	}

	// Base not specified: resolve it. Fail closed if base is main or unknown.
	const pr =
		typeof record.pr === "string" || typeof record.pr === "number"
			? record.pr
			: Array.isArray(record.pr) && record.pr.length > 0
				? (record.pr[0] as string | number)
				: undefined;

	const resolvedBase = resolvePr(pr, repo, cwd);
	if (
		!resolvedBase ||
		resolvedBase.trim().toLowerCase() === "main" ||
		resolvedBase.trim().toLowerCase() === "refs/heads/main" ||
		resolvedBase.trim().toLowerCase().endsWith("/main")
	) {
		return { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };
	}

	return undefined;
}
