/**
 * Hard-refusal guard for Bavariance/polysimulator main branch.
 *
 * GitHub Free cannot enforce branch protection rulesets server-side,
 * so this agent tooling fail-closed guard ensures that no agent can
 * ever merge a PR into `main` or push to `main` on Bavariance/polysimulator.
 *
 * The guard reads a command the way the shell will run it, and where it cannot
 * tell (an unresolvable `cd`, `GIT_DIR=$X`, a remote it cannot read, a refspec
 * built from a variable) it assumes the target is polysimulator `main` and
 * refuses. Known limit: a `gh` alias or a script file the command runs by path
 * is not read.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepositorySync } from "../../utils/git-head";
import {
	INTERPRETED_SCRIPT_COMMANDS,
	MAX_INTERPRETED_SHELL_DEPTH,
	SCRIPT_FLAG,
	splitCommandSegments,
	splitWords,
} from "../shell/bash-guard";

export const POLYSIM_MAIN_DENIAL_MESSAGE = "main requires both founders' approval; agents never merge or push to main";

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

const DENIAL: PolysimDenialResult = { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };

/**
 * Returns true if the string matches `Bavariance/polysimulator` (case-insensitive).
 */
export function isPolysimulatorRepo(repo?: string): boolean {
	if (!repo || typeof repo !== "string") return false;
	const normalized = repo
		.trim()
		.toLowerCase()
		.replace(/^\/+|\/+$/g, "");
	return (
		normalized === POLYSIM_REPO_SLUG ||
		normalized === `${POLYSIM_REPO_SLUG}.git` ||
		normalized.endsWith(`/${POLYSIM_REPO_SLUG}`) ||
		normalized.endsWith(`/${POLYSIM_REPO_SLUG}.git`)
	);
}

/**
 * Returns true if a remote URL points to `Bavariance/polysimulator`.
 *
 * Host-agnostic on purpose: an SSH host alias (`bav:Bavariance/polysimulator`)
 * or `ssh://git@ssh.github.com:443/...` reaches the same repository.
 */
export function isPolysimulatorRemoteUrl(url?: string): boolean {
	if (!url || typeof url !== "string") return false;
	return url.trim().toLowerCase().replaceAll("\\", "/").includes(POLYSIM_REPO_SLUG);
}

/**
 * Reads git remotes from the repository's configuration synchronously.
 *
 * A remote's value carries its `pushurl` as well as its `url`, space-joined,
 * because `git push` goes to the push URL: a remote fetching from a fork and
 * pushing to polysimulator is a polysimulator remote.
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
				const urlMatch = trimmed.match(/^(?:push)?url\s*=\s*(.+)$/i);
				if (urlMatch) {
					const previous = remotes[currentRemote];
					remotes[currentRemote] = previous ? `${previous} ${urlMatch[1].trim()}` : urlMatch[1].trim();
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
	return isMainBranchName(ref);
}

/** True for `main` in any spelling, and for a branch the guard could not learn. */
function isMainBranchName(branch: string | undefined): boolean {
	if (branch === undefined) return true;
	const name = branch.trim().toLowerCase();
	return name === "" || name === "main" || name === "refs/heads/main" || name.endsWith("/main");
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

/**
 * Where the next command of a line runs, as far as the guard can tell.
 *
 * `cwd` is `undefined` once the line moved somewhere the guard cannot name
 * (`cd "$DIR"`, `cd -`, `GIT_DIR=$X`); an unknown place counts as
 * polysimulator. `ghRepo` is the `GH_REPO` a `gh` call inherits.
 */
interface CommandScope {
	cwd: string | undefined;
	ghRepo: string | undefined;
}

/** `C:\Program Files\Git\cmd\git.exe` and `/usr/bin/git` are both `git`. */
function commandName(word: string): string {
	const last = word.split(/[\\/]/).pop() ?? word;
	return last.toLowerCase().replace(/\.exe$/, "");
}

function isUnresolvable(word: string): boolean {
	return word.includes("$") || word.includes("`");
}

function resolveIn(cwd: string | undefined, target: string): string | undefined {
	if (cwd === undefined || isUnresolvable(target)) return undefined;
	let expanded = target;
	if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = path.join(os.homedir(), expanded.slice(1));
	}
	return path.resolve(cwd, expanded);
}

/** A `GIT_DIR` of `<repo>/.git` names the repository `<repo>`. */
function gitDirWorktree(dir: string | undefined): string | undefined {
	if (dir === undefined) return undefined;
	return path.basename(dir).toLowerCase() === ".git" ? path.dirname(dir) : dir;
}

/** The remotes at `cwd`, or `undefined` when there is nothing the guard can read. */
function remotesIn(cwd: string | undefined, options?: PolysimGuardOptions): Record<string, string> | undefined {
	if (cwd === undefined) return undefined;
	const remotes = (options?.getRemotes ?? getGitRemoteUrlsSync)(cwd);
	return Object.keys(remotes).length === 0 ? undefined : remotes;
}

function scopeIsPolysim(scope: CommandScope, options?: PolysimGuardOptions): boolean {
	const remotes = remotesIn(scope.cwd, options);
	return remotes === undefined || Object.values(remotes).some(isPolysimulatorRemoteUrl);
}

function repoIsPolysim(repo: string, scope: CommandScope, options?: PolysimGuardOptions): boolean {
	if (isUnresolvable(repo)) return true;
	return (
		isPolysimulatorRepo(repo) || isPolysimulatorRemoteUrl(repo) || (repo === "." && scopeIsPolysim(scope, options))
	);
}

function applyScopeVariable(scope: CommandScope, name: string, value: string): void {
	if (name === "GH_REPO") {
		scope.ghRepo = value;
		return;
	}
	// GIT_DIR and GIT_WORK_TREE both move where git (and gh, through git) reads remotes.
	scope.cwd = gitDirWorktree(resolveIn(scope.cwd, value));
}

const SCOPE_VARIABLE = /^(GIT_DIR|GIT_WORK_TREE|GH_REPO)=(.*)$/;
const CD_COMMANDS: Record<string, true> = { cd: true, pushd: true, chdir: true, "set-location": true, sl: true };

function applyCd(words: readonly string[], scope: CommandScope): void {
	let target: string | undefined;
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (/^-(path|literalpath)$/i.test(word)) {
			target = words[index + 1];
			break;
		}
		if (word === "-" || !(word.startsWith("-") || /^\/d$/i.test(word))) {
			target = word;
			break;
		}
	}
	if (target === undefined) {
		scope.cwd = os.homedir();
		return;
	}
	scope.cwd = target === "-" ? undefined : resolveIn(scope.cwd, target);
}

const GIT_GLOBAL_VALUE_OPTIONS: Record<string, true> = {
	"-c": true,
	"--namespace": true,
	"--config-env": true,
	"--super-prefix": true,
	"--attr-source": true,
};
const GIT_PUSH_VALUE_OPTIONS: Record<string, true> = {
	"-o": true,
	"--push-option": true,
	"--receive-pack": true,
	"--exec": true,
};

/**
 * Whether the repository a `git push` names is polysimulator.
 *
 * `target` is the `<repository>` argument; `undefined` means the default
 * remote, which is one of the configured ones.
 */
function pushTargetIsPolysim(target: string | undefined, remotes: Record<string, string> | undefined): boolean {
	if (target === undefined) {
		return remotes === undefined || Object.values(remotes).some(isPolysimulatorRemoteUrl);
	}
	if (isUnresolvable(target) || isPolysimulatorRemoteUrl(target) || isPolysimulatorRepo(target)) return true;
	if (remotes !== undefined && Object.hasOwn(remotes, target)) return isPolysimulatorRemoteUrl(remotes[target]);
	// A URL or path that is not polysimulator. A bare name that is no configured
	// remote is refused by git itself, unless the remotes were unreadable.
	if (/[:/\\]/.test(target)) return false;
	return remotes === undefined;
}

/**
 * Checks a `git push` invocation.
 */
function checkGitPushInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	let cwd = scope.cwd;
	let index = 1;
	while (index < words.length) {
		const word = words[index];
		const valued = /^--(?:git-dir|work-tree)=(.*)$/.exec(word);
		if (valued) {
			cwd = gitDirWorktree(resolveIn(cwd, valued[1]));
			index++;
			continue;
		}
		if (word === "--git-dir" || word === "--work-tree") {
			cwd = index + 1 < words.length ? gitDirWorktree(resolveIn(cwd, words[index + 1])) : cwd;
			index += 2;
			continue;
		}
		if (word === "-C") {
			cwd = index + 1 < words.length ? resolveIn(cwd, words[index + 1]) : cwd;
			index += 2;
			continue;
		}
		if (word.startsWith("-C") && word.length > 2) {
			cwd = resolveIn(cwd, word.slice(2));
			index++;
			continue;
		}
		if (GIT_GLOBAL_VALUE_OPTIONS[word] === true) {
			index += 2;
			continue;
		}
		if (!word.startsWith("-")) break;
		index++;
	}
	if (words[index] !== "push") return undefined;
	index++;

	let repoOption: string | undefined;
	const positional: string[] = [];
	let pushesEveryBranch = false;
	while (index < words.length) {
		const word = words[index];
		if (word === "--") {
			positional.push(...words.slice(index + 1));
			break;
		}
		if (word === "--all" || word === "--mirror" || word === "--branches") {
			pushesEveryBranch = true;
		} else if (word.startsWith("--repo=")) {
			repoOption = word.slice("--repo=".length);
		} else if (word === "--repo" || GIT_PUSH_VALUE_OPTIONS[word] === true) {
			if (word === "--repo") repoOption = words[index + 1];
			index++;
		} else if (!word.startsWith("-")) {
			positional.push(word);
		}
		index++;
	}

	// `--repo` is the `<repository>` argument; a positional one takes precedence.
	const target = positional[0] ?? repoOption;
	const refspecs = positional.slice(1);
	if (!pushTargetIsPolysim(target, remotesIn(cwd, options))) return undefined;
	if (pushesEveryBranch) return DENIAL;

	const currentBranchIsMain = (): boolean =>
		isMainBranchName(cwd === undefined ? undefined : (options?.getCurrentBranch ?? getCurrentGitBranchSync)(cwd));

	// No refspec pushes the current branch; a detached or unreadable HEAD fails closed.
	if (refspecs.length === 0) return currentBranchIsMain() ? DENIAL : undefined;
	for (const ref of refspecs) {
		// A glob can include main, and a variable can be main.
		if (ref.includes("*") || isUnresolvable(ref) || isMainRefspec(ref)) return DENIAL;
		const source = ref.replace(/^\+/, "").toLowerCase();
		if ((source === "head" || source === "@") && currentBranchIsMain()) return DENIAL;
	}
	return undefined;
}

/** The value of `-R`/`--repo` anywhere in a `gh` command. */
function ghRepoFlag(words: readonly string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "-R" || word === "--repo") return words[index + 1];
		if (word.startsWith("--repo=")) return word.slice("--repo=".length);
		if (word.startsWith("-R=")) return word.slice(3);
		if (word.startsWith("-R") && word.length > 2) return word.slice(2);
	}
	return undefined;
}

/** The words after `gh` that name the command: `gh -R x pr merge` is `pr merge`. */
function ghCommandPath(words: readonly string[]): string[] {
	const commandPath: string[] = [];
	for (let index = 1; index < words.length && commandPath.length < 2; index++) {
		const word = words[index];
		if (word === "-R" || word === "--repo") {
			index++;
			continue;
		}
		if (!word.startsWith("-")) commandPath.push(word.toLowerCase());
	}
	return commandPath;
}

/** Index just past the word `word` in `words`, or `words.length` when absent. */
function after(words: readonly string[], word: string): number {
	const index = words.indexOf(word);
	return index === -1 ? words.length : index + 1;
}

const GH_PR_MERGE_VALUE_OPTIONS: Record<string, true> = {
	"-R": true,
	"--repo": true,
	"-t": true,
	"--subject": true,
	"-b": true,
	"--body": true,
	"-F": true,
	"--body-file": true,
	"-A": true,
	"--author-email": true,
	"--match-head-commit": true,
};

/**
 * Checks a `gh pr merge` invocation.
 */
function checkGhPrMergeInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const repo = ghRepoFlag(words) ?? scope.ghRepo;
	let pr: string | undefined;
	for (let index = after(words, "merge"); index < words.length; index++) {
		const word = words[index];
		if (GH_PR_MERGE_VALUE_OPTIONS[word] === true) {
			index++;
			continue;
		}
		if (!word.startsWith("-")) pr ??= word;
	}

	const prIsUrl = pr !== undefined && /github\.com[/:]/i.test(pr);
	let isTargetPolysim: boolean;
	if (prIsUrl) {
		isTargetPolysim = isPolysimulatorRemoteUrl(pr);
	} else if (repo !== undefined) {
		isTargetPolysim = repoIsPolysim(repo, scope, options);
	} else {
		isTargetPolysim = scopeIsPolysim(scope, options);
	}
	if (!isTargetPolysim) return undefined;
	// Nowhere to ask `gh` from: the base cannot be learned, so it counts as main.
	if (!prIsUrl && repo === undefined && scope.cwd === undefined) return DENIAL;
	if (pr !== undefined && isUnresolvable(pr)) return DENIAL;

	const base = (options?.resolvePrBase ?? defaultResolvePrBase)(pr, repo, scope.cwd ?? process.cwd());
	return isMainBranchName(base) ? DENIAL : undefined;
}

const GH_API_VALUE_OPTIONS: Record<string, true> = {
	"-R": true,
	"--repo": true,
	"-H": true,
	"--header": true,
	"-q": true,
	"--jq": true,
	"-t": true,
	"--template": true,
	"--cache": true,
	"--hostname": true,
	"-p": true,
	"--preview": true,
};
const GH_API_FIELD_OPTIONS: Record<string, true> = { "-f": true, "-F": true, "--field": true, "--raw-field": true };
const GRAPHQL_MAIN_MUTATIONS =
	/\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|updateRefs?|createCommitOnBranch)\b/;
/** `{owner}`/`{repo}` and the older `:owner`/`:repo`, which gh fills from the repository context. */
const REPO_PLACEHOLDER = /^(?:\{owner\}|\{repo\}|:owner|:repo)$/;

/**
 * Checks a `gh api` invocation.
 */
function checkGhApiInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const repo = ghRepoFlag(words) ?? scope.ghRepo;
	let method: string | undefined;
	let endpoint: string | undefined;
	const fields = new Map<string, string>();
	let bodyIsOpaque = false;
	const addField = (pair: string | undefined): void => {
		if (pair === undefined) return;
		const separator = pair.indexOf("=");
		const key = (separator === -1 ? pair : pair.slice(0, separator)).toLowerCase();
		const value = separator === -1 ? "" : pair.slice(separator + 1);
		// `-F body=@file` reads the value from a file the guard does not open.
		if (value.startsWith("@") || isUnresolvable(value)) bodyIsOpaque = true;
		fields.set(key, value);
	};

	for (let index = after(words, "api"); index < words.length; index++) {
		const word = words[index];
		if (word === "-X" || word === "--method") {
			method = words[index + 1]?.toUpperCase();
			index++;
		} else if (word.startsWith("--method=")) {
			method = word.slice("--method=".length).toUpperCase();
		} else if (word.startsWith("-X")) {
			method = word.slice(2).toUpperCase();
		} else if (GH_API_FIELD_OPTIONS[word] === true) {
			addField(words[index + 1]);
			index++;
		} else if (/^--(?:raw-)?field=/.test(word)) {
			addField(word.slice(word.indexOf("=") + 1));
		} else if (/^-[fF]./.test(word)) {
			addField(word.slice(2));
		} else if (word === "--input" || word.startsWith("--input=")) {
			bodyIsOpaque = true;
			if (word === "--input") index++;
		} else if (GH_API_VALUE_OPTIONS[word] === true) {
			index++;
		} else if (!word.startsWith("-")) {
			endpoint ??= word;
		}
	}
	if (endpoint === undefined) return undefined;
	if (method === "GET" || method === "HEAD") return undefined;
	if (method !== undefined && isUnresolvable(method)) method = undefined;

	const normalized = endpoint
		.trim()
		.replace(/^https?:\/\/[^/]+\//i, "")
		.replace(/[?#].*$/, "")
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	const repoScopeIsPolysim = (): boolean =>
		repo !== undefined ? repoIsPolysim(repo, scope, options) : scopeIsPolysim(scope, options);

	if (normalized === "graphql") {
		// A GraphQL mutation names its pull request by node ID, so the repository
		// is whatever the call's context says it is.
		const text = [...fields.values()].join("\n");
		const merges = bodyIsOpaque || GRAPHQL_MAIN_MUTATIONS.test(text);
		if (!merges) return undefined;
		return text.toLowerCase().includes("polysimulator") || repoScopeIsPolysim() ? DENIAL : undefined;
	}

	let relative = normalized;
	const repoPath = /^repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(normalized);
	if (repoPath) {
		const [, owner, name, rest] = repoPath;
		const polysim =
			REPO_PLACEHOLDER.test(owner) || REPO_PLACEHOLDER.test(name)
				? repoScopeIsPolysim()
				: isUnresolvable(owner) ||
					isUnresolvable(name) ||
					`${owner}/${name.replace(/\.git$/, "")}` === POLYSIM_REPO_SLUG;
		if (!polysim) return undefined;
		relative = rest;
	} else if (!repoScopeIsPolysim()) {
		return undefined;
	}

	// Without `-X` gh sends GET, or POST once a field or body is attached. The
	// merge and main-ref endpoints fail closed on a missing method all the same.
	const effectiveMethod = method ?? (fields.size > 0 || bodyIsOpaque ? "POST" : "GET");
	const field = (key: string): string | undefined => (bodyIsOpaque ? undefined : fields.get(key));

	if (/^pulls\/[^/]+\/merge$/.test(relative)) return DENIAL;
	if (relative === "git/refs/heads/main") return DENIAL;
	if (effectiveMethod === "GET") return undefined;
	if (relative === "git/refs" && isMainRefspec(field("ref") ?? "")) return DENIAL;
	if (relative === "merges" && isMainBranchName(field("base"))) return DENIAL;
	// A contents write without `branch` commits to the default branch, main.
	if (relative.startsWith("contents/") && isMainBranchName(field("branch"))) return DENIAL;
	return undefined;
}

/**
 * Checks `gh repo sync <destination>`, which moves a branch on the destination
 * repository (the default branch, main, unless `--branch` says otherwise).
 */
function checkGhRepoSyncInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	let destination: string | undefined;
	let branch: string | undefined;
	for (let index = after(words, "sync"); index < words.length; index++) {
		const word = words[index];
		if (word === "-b" || word === "--branch") {
			branch = words[index + 1];
			index++;
		} else if (word.startsWith("--branch=")) {
			branch = word.slice("--branch=".length);
		} else if (word === "-s" || word === "--source") {
			index++;
		} else if (!word.startsWith("-")) {
			destination ??= word;
		}
	}
	// Without a destination the local clone is synced; nothing leaves the machine.
	if (destination === undefined || !repoIsPolysim(destination, scope, options)) return undefined;
	return isMainBranchName(branch) || isUnresolvable(branch ?? "") ? DENIAL : undefined;
}

function checkGhInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	const [group, action] = ghCommandPath(words);
	if (group === "pr" && action === "merge") return checkGhPrMergeInvocation(words, scope, options);
	if (group === "api") return checkGhApiInvocation(words, scope, options);
	if (group === "repo" && action === "sync") return checkGhRepoSyncInvocation(words, scope, options);
	return undefined;
}

const POWERSHELL_COMMANDS: Record<string, true> = { pwsh: true, powershell: true };
const POWERSHELL_SCRIPT_FLAG = /^-(?:c|command)$/i;
const CMD_SCRIPT_FLAG = /^\/[ck]$/i;

/** The shell text a `sh -c`, `eval`, `pwsh -Command` or `cmd /c` at `position` runs. */
function interpretedScript(words: readonly string[], position: number, name: string): string | undefined {
	const shape = INTERPRETED_SCRIPT_COMMANDS.get(name);
	if (shape === "nextWord") return words[position + 1];
	if (shape === "afterScriptFlag") {
		const flag = words.findIndex((word, index) => index > position && SCRIPT_FLAG.test(word));
		return flag === -1 ? undefined : words[flag + 1];
	}
	const flagPattern =
		POWERSHELL_COMMANDS[name] === true ? POWERSHELL_SCRIPT_FLAG : name === "cmd" ? CMD_SCRIPT_FLAG : undefined;
	if (flagPattern === undefined) return undefined;
	const flag = words.findIndex((word, index) => index > position && flagPattern.test(word));
	return flag === -1 ? undefined : words.slice(flag + 1).join(" ");
}

/** The bodies of the top-level `$(…)` and backtick substitutions in `command`. */
function substitutionBodies(command: string): string[] {
	const bodies: string[] = [];
	for (let index = 0; index < command.length; index++) {
		if (command[index] !== "$" || command[index + 1] !== "(") continue;
		let depth = 0;
		let end = command.length;
		for (let cursor = index + 1; cursor < command.length; cursor++) {
			if (command[cursor] === "(") depth++;
			else if (command[cursor] === ")" && --depth === 0) {
				end = cursor;
				break;
			}
		}
		bodies.push(command.slice(index + 2, end));
		index = end;
	}
	for (const match of command.matchAll(/`([^`]*)`/g)) bodies.push(match[1]);
	return bodies;
}

/**
 * Checks one command's words. Every word position is a possible command, the
 * way `bash-guard` reads a segment, so `sudo -E env X=1 timeout 5 git push`
 * and `xargs git push` are read without a list of wrappers to keep current.
 */
function checkWords(
	words: readonly string[],
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
	depth: number,
): PolysimDenialResult | undefined {
	if (words.length === 0) return undefined;
	if (CD_COMMANDS[commandName(words[0])] === true) {
		applyCd(words, scope);
		return undefined;
	}
	for (const word of words) {
		const assignment = SCOPE_VARIABLE.exec(word);
		if (assignment) applyScopeVariable(scope, assignment[1], assignment[2]);
	}
	for (let position = 0; position < words.length; position++) {
		const name = commandName(words[position]);
		let found: PolysimDenialResult | undefined;
		if (name === "git") {
			found = checkGitPushInvocation(words.slice(position), scope, options);
		} else if (name === "gh") {
			found = checkGhInvocation(words.slice(position), scope, options);
		} else {
			const script = interpretedScript(words, position, name);
			if (script !== undefined) found = checkScript(script, { ...scope }, options, depth + 1);
		}
		if (found) return found;
	}
	return undefined;
}

function checkScript(
	command: string,
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
	depth: number,
): PolysimDenialResult | undefined {
	// Past the nesting bound the guard stops reading; text that could still be
	// a push or a merge is refused rather than waved through.
	if (depth > MAX_INTERPRETED_SHELL_DEPTH) return /\b(?:git|gh)\b/i.test(command) ? DENIAL : undefined;
	for (const body of substitutionBodies(command)) {
		const found = checkScript(body, { ...scope }, options, depth + 1);
		if (found) return found;
	}
	for (const segment of splitCommandSegments(command)) {
		const words = splitWords(segment)
			.map(word => word.text.trim())
			.filter(Boolean);
		const found = checkWords(words, scope, options, depth);
		if (found) return found;
	}
	return undefined;
}

function initialScope(
	cwd: string | undefined,
	env: NodeJS.ProcessEnv | Record<string, string> | undefined,
): CommandScope {
	const scope: CommandScope = { cwd, ghRepo: undefined };
	if (env) {
		// GIT_DIR last: it decides where git reads remotes when both are set.
		for (const name of ["GIT_WORK_TREE", "GIT_DIR", "GH_REPO"]) {
			const value = env[name];
			if (typeof value === "string" && value !== "") applyScopeVariable(scope, name, value);
		}
	}
	return scope;
}

/**
 * Checks a single bash command string against all Bavariance/polysimulator main rules.
 *
 * `env` is the environment the command runs with (the bash tool's `env`
 * argument), so a `GIT_DIR` or `GH_REPO` handed in beside the command counts.
 * An `undefined` cwd means the directory is not known (text typed into a
 * launched shell), and is judged as if it were polysimulator.
 */
export function checkPolysimMainDenial(
	command: string,
	cwd: string | undefined,
	env?: NodeJS.ProcessEnv | Record<string, string>,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	if (!command || typeof command !== "string") return undefined;
	return checkScript(command, initialScope(cwd, env), options, 0);
}

/**
 * Checks a process started from an argv (the `launch` tool), with the same
 * rules as a shell command: `git push …`, `gh pr merge …`, and a shell handed
 * one as a script (`bash -c`, `cmd /c`, `pwsh -Command`).
 */
export function checkPolysimMainArgv(
	argv: readonly string[],
	cwd: string,
	env?: NodeJS.ProcessEnv | Record<string, string>,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
	return checkWords(argv, initialScope(cwd, env), options, 0);
}

/**
 * Checks where a `github` tool `pr_push` is about to push: the PR's head branch
 * on the remote it resolved, which the tool call itself never names.
 */
export function checkPushTargetPolysimMainDenial(
	remoteUrl: string | undefined,
	remoteBranch: string,
): PolysimDenialResult | undefined {
	if (remoteUrl !== undefined && !isPolysimulatorRemoteUrl(remoteUrl)) return undefined;
	return isMainRefspec(remoteBranch) ? DENIAL : undefined;
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
		// The real destination is the PR head, checked at push time by
		// `checkPushTargetPolysimMainDenial`; a local `main` is refused up front.
		const branch = typeof record.branch === "string" ? record.branch : undefined;
		return branch !== undefined && isMainRefspec(branch) ? DENIAL : undefined;
	}

	const explicitBase = typeof record.base === "string" ? record.base.trim() : undefined;
	if (explicitBase) {
		return isMainBranchName(explicitBase) ? DENIAL : undefined;
	}

	// Base not specified: resolve it. Fail closed if base is main or unknown.
	const pr =
		typeof record.pr === "string" || typeof record.pr === "number"
			? record.pr
			: Array.isArray(record.pr) && record.pr.length > 0
				? (record.pr[0] as string | number)
				: undefined;

	return isMainBranchName(resolvePr(pr, repo, cwd)) ? DENIAL : undefined;
}
