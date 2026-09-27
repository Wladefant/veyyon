/**
 * Hard-refusal guard for Bavariance/polysimulator main branch.
 *
 * GitHub Free cannot enforce branch protection rulesets server-side,
 * so this agent tooling fail-closed guard ensures that no agent can
 * ever merge a PR into `main` or push to `main` on Bavariance/polysimulator.
 *
 * The guard applies to that one repository, named by a remote URL, a `--repo`
 * argument or an API path; every other repository is left alone.
 *
 * The guard reads a command the way the shell will run it, and where it cannot
 * tell (an unresolvable `cd`, `GIT_DIR=$X`, a remote it cannot read, a refspec
 * built from a variable, git config it cannot see) it assumes the target is
 * polysimulator `main` and refuses. Git config is read for aliases, push
 * refspecs, `push.default`, upstreams and `insteadOf` rewrites, from the global
 * and repository files and from `-c` and `GIT_CONFIG_*` overrides.
 *
 * Known limits, which no text guard can close: a script file the command runs
 * by path (`bash push.sh`, `pwsh -File x.ps1`), a `gh` alias, and a file pulled
 * in through git's `include.path` are not read. Inline interpreter code
 * (`python -c`, `node -e`) is not parsed; it is refused when it mentions a git
 * push or a GitHub merge while polysimulator is in reach.
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
	/**
	 * The refusal rests on a lookup that did not answer (gh offline, timed out,
	 * rate-limited), not on a known `main` target: the same command may pass
	 * once the lookup succeeds.
	 */
	readonly retryable?: boolean;
}

/** A pull request base lookup that did not answer, and why. */
export interface PrBaseLookupFailure {
	readonly error: string;
}

/**
 * Looks up a pull request's base branch. `undefined` or a failure means the
 * base is not known, which the guard treats as `main`.
 */
export type PrBaseResolver = (
	pr: string | number | undefined,
	repo: string | undefined,
	cwd: string,
) => string | PrBaseLookupFailure | undefined;

/** Git config as `[key, value]` pairs in the order git reads them; later pairs win. */
export type GitConfigEntries = ReadonlyArray<readonly [string, string]>;

export interface PolysimGuardOptions {
	readonly resolvePrBase?: PrBaseResolver;
	readonly getRemotes?: (cwd: string) => Record<string, string>;
	readonly getCurrentBranch?: (cwd: string) => string | undefined;
	/** The global and repository git config for a directory (`undefined`: global only). */
	readonly readGitConfig?: (cwd: string | undefined) => GitConfigEntries;
}

const DENIAL: PolysimDenialResult = { reason: POLYSIM_MAIN_DENIAL_MESSAGE, targetRepo: POLYSIM_REPO_SLUG };

function baseUnknownDenial(detail: string | undefined): PolysimDenialResult {
	return {
		reason:
			`${POLYSIM_MAIN_DENIAL_MESSAGE}. The pull request's base branch could not be looked up` +
			`${detail ? ` (${detail})` : ""}, so it counts as main. If gh was offline, timed out or ` +
			"rate-limited, run the same command again: a pull request based on another branch merges once the lookup answers.",
		targetRepo: POLYSIM_REPO_SLUG,
		retryable: true,
	};
}

/**
 * The `owner/name` a repository location names: a slug, an `https://`, `ssh://`
 * or scp-style URL, or an SSH host alias (`bav:Bavariance/polysimulator`).
 * Percent-escapes are decoded, since the server decodes them too.
 */
function repositorySlugOf(location: string): string | undefined {
	let text = location.trim().replaceAll("\\", "/");
	try {
		text = decodeURIComponent(text);
	} catch {
		// A malformed escape is left as written; the server would not decode it either.
	}
	text = text
		.toLowerCase()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const parts = text.split(/[/:]+/).filter(Boolean);
	return parts.length < 2 ? undefined : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Returns true if the string names `Bavariance/polysimulator` (case-insensitive),
 * as a slug or a URL. `Bavariance/polysimulator-docs` is another repository.
 */
export function isPolysimulatorRepo(repo?: string): boolean {
	if (!repo || typeof repo !== "string") return false;
	return repositorySlugOf(repo) === POLYSIM_REPO_SLUG;
}

/**
 * Returns true if a remote URL points to `Bavariance/polysimulator`.
 *
 * Host-agnostic on purpose: an SSH host alias (`bav:Bavariance/polysimulator`)
 * or `ssh://git@ssh.github.com:443/...` reaches the same repository. A value
 * may hold several space-separated URLs (a remote's `url` and `pushurl`).
 */
export function isPolysimulatorRemoteUrl(url?: string): boolean {
	if (!url || typeof url !== "string") return false;
	return url.split(/\s+/).some(location => location !== "" && repositorySlugOf(location) === POLYSIM_REPO_SLUG);
}

/** `Remote.Origin.PushURL` is `remote.Origin.pushurl`: section and key fold case, a subsection does not. */
function normalizeConfigKey(key: string): string {
	const first = key.indexOf(".");
	const last = key.lastIndexOf(".");
	if (first === last) return key.toLowerCase();
	return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

function configValue(raw: string): string {
	let value = "";
	let quoted = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index];
		if (character === "\\" && index + 1 < raw.length) {
			const escaped = raw[++index];
			value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && (character === "#" || character === ";")) break;
		value += character;
	}
	return value.trim();
}

/** Parses git config file text into `[key, value]` pairs. */
export function parseGitConfig(text: string): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	let section = "";
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(line);
		if (header) {
			const name = header[1];
			section =
				header[2] !== undefined
					? `${name.toLowerCase()}.${header[2].replace(/\\(.)/g, "$1")}`
					: normalizeConfigKey(`${name}.x`).slice(0, -2);
			line = header[3].trim();
			if (line === "") continue;
		}
		if (section === "") continue;
		const pair = /^([A-Za-z][\w-]*)\s*(?:=(.*))?$/.exec(line);
		if (!pair) continue;
		entries.push([`${section}.${pair[1].toLowerCase()}`, pair[2] === undefined ? "true" : configValue(pair[2])]);
	}
	return entries;
}

function readConfigFile(file: string): Array<[string, string]> {
	try {
		return parseGitConfig(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

/** The global git config, then the repository's own, as git layers them. */
export function readGitConfigSync(cwd: string | undefined): GitConfigEntries {
	const home = os.homedir();
	const globalFiles = process.env.GIT_CONFIG_GLOBAL
		? [process.env.GIT_CONFIG_GLOBAL]
		: [
				path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config"),
				path.join(home, ".gitconfig"),
			];
	const entries = globalFiles.flatMap(readConfigFile);
	if (cwd !== undefined) {
		try {
			const repo = resolveRepositorySync(cwd);
			if (repo) entries.push(...readConfigFile(path.join(repo.commonDir, "config")));
		} catch {
			// Not a repository: the global config is all git would read.
		}
	}
	return entries;
}

/**
 * Remote URLs from config pairs. A remote's value carries its `pushurl` as well
 * as its `url`, space-joined, because `git push` goes to the push URL: a remote
 * fetching from a fork and pushing to polysimulator is a polysimulator remote.
 */
function remotesFromConfig(entries: GitConfigEntries): Record<string, string> {
	const remotes: Record<string, string> = {};
	for (const [key, value] of entries) {
		const match = /^remote\.(.+)\.(?:push)?url$/.exec(key);
		if (!match || value === "") continue;
		const name = match[1];
		remotes[name] = Object.hasOwn(remotes, name) ? `${remotes[name]} ${value}` : value;
	}
	return remotes;
}

/** Reads git remotes from the repository's configuration synchronously. */
export function getGitRemoteUrlsSync(cwd: string): Record<string, string> {
	try {
		const repo = resolveRepositorySync(cwd);
		if (!repo) return {};
		return remotesFromConfig(readConfigFile(path.join(repo.commonDir, "config")));
	} catch {
		return {};
	}
}

/**
 * Returns true if any configured remote in cwd points to `Bavariance/polysimulator`.
 */
export function isCwdPolysimulatorRepo(
	cwd: string,
	getRemotes: (dir: string) => Record<string, string> = getGitRemoteUrlsSync,
): boolean {
	return Object.values(getRemotes(cwd)).some(isPolysimulatorRemoteUrl);
}

/**
 * The spellings git resolves to `refs/heads/main` on the remote. `feature/main`
 * and `refs/remotes/origin/main` are other refs.
 */
const MAIN_BRANCH_SPELLINGS: Record<string, true> = {
	"": true,
	main: true,
	"heads/main": true,
	"refs/heads/main": true,
};

/**
 * Checks if a refspec string's destination is `main`.
 */
export function isMainRefspec(refspec: string): boolean {
	let ref = refspec.trim();
	if (ref.startsWith("+")) ref = ref.slice(1);
	if (ref.includes(":")) ref = ref.slice(ref.lastIndexOf(":") + 1);
	return isMainBranchName(ref);
}

/** True for `main` in any spelling, and for a branch the guard could not learn. */
function isMainBranchName(branch: string | undefined): boolean {
	if (branch === undefined) return true;
	return MAIN_BRANCH_SPELLINGS[branch.trim().toLowerCase()] === true;
}

function describeLookupError(error: unknown): string {
	const failure = (error ?? {}) as { code?: unknown; signal?: unknown; stderr?: unknown };
	if (failure.code === "ENOENT") return "gh is not installed";
	if (failure.code === "ETIMEDOUT" || typeof failure.signal === "string") return "gh pr view timed out";
	const firstLine = String(failure.stderr ?? "")
		.trim()
		.split(/\r?\n/)[0];
	return firstLine ? `gh pr view: ${firstLine.slice(0, 200)}` : "gh pr view failed";
}

/**
 * Default resolver for a PR's base branch using `gh pr view`. A failed lookup
 * reports why, so the refusal can say the command is worth retrying.
 */
export function defaultResolvePrBase(
	pr: string | number | undefined,
	repo: string | undefined,
	cwd: string,
): string | PrBaseLookupFailure {
	const args = ["pr", "view"];
	if (pr !== undefined && String(pr).trim() !== "") args.push(String(pr).trim());
	if (repo) args.push("--repo", repo);
	args.push("--json", "baseRefName", "-q", ".baseRefName");
	try {
		const output = execFileSync("gh", args, {
			cwd: cwd || process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		}).trim();
		return output || { error: "gh pr view printed no base branch" };
	} catch (error) {
		return { error: describeLookupError(error) };
	}
}

function baseDenialFor(lookup: string | PrBaseLookupFailure | undefined): PolysimDenialResult | undefined {
	if (typeof lookup !== "string") return baseUnknownDenial(lookup?.error);
	return isMainBranchName(lookup) ? DENIAL : undefined;
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
			return headContent
				.slice(4)
				.trim()
				.replace(/^refs\/heads\//, "");
		}
	} catch {
		// A detached or unreadable HEAD is an unknown branch.
	}
	return undefined;
}

/**
 * Where the next command of a line runs, as far as the guard can tell.
 *
 * `cwd` is `undefined` once the line moved somewhere the guard cannot name
 * (`cd "$DIR"`, `cd -`, `GIT_DIR=$X`); an unknown place counts as
 * polysimulator. `ghRepo` is the `GH_REPO` a `gh` call inherits, and
 * `gitConfigEnv` the `GIT_CONFIG_*` variables git inherits.
 */
interface CommandScope {
	cwd: string | undefined;
	ghRepo: string | undefined;
	gitConfigEnv: Readonly<Record<string, string>>;
}

/** `C:\Program Files\Git\cmd\git.exe` and `/usr/bin/git` are both `git`. */
function commandName(word: string): string {
	const last = word.split(/[\\/]/).pop() ?? word;
	return last.toLowerCase().replace(/\.exe$/, "");
}

function isUnresolvable(word: string): boolean {
	return word.includes("$") || word.includes("`");
}

/** A shell glob: the word the command receives depends on files the guard does not list. */
const SHELL_GLOB = /[*?[]/;

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
	return isPolysimulatorRepo(repo) || (repo === "." && scopeIsPolysim(scope, options));
}

function applyScopeVariable(scope: CommandScope, name: string, value: string): void {
	if (name === "GH_REPO") {
		scope.ghRepo = value;
		return;
	}
	if (name.startsWith("GIT_CONFIG")) {
		scope.gitConfigEnv = { ...scope.gitConfigEnv, [name]: value };
		return;
	}
	// GIT_DIR and GIT_WORK_TREE both move where git (and gh, through git) reads remotes.
	scope.cwd = gitDirWorktree(resolveIn(scope.cwd, value));
}

const SCOPE_VARIABLE = /^(GIT_DIR|GIT_WORK_TREE|GH_REPO|GIT_CONFIG(?:_[A-Z0-9_]+)?)=(.*)$/;
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

/** Config that can change where a push goes, what it pushes, or which command runs. */
const ROUTING_CONFIG_KEY = /^(?:alias|remote|url|push|branch|include|includeif)\./;

/** Config git reads from the environment (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_CONFIG_PARAMETERS`, config file overrides). */
function environmentConfig(env: Readonly<Record<string, string>>): {
	entries: Array<[string, string]>;
	opaque: boolean;
} {
	const entries: Array<[string, string]> = [];
	let opaque = false;
	const add = (key: string, value: string): void => {
		const normalized = normalizeConfigKey(key);
		if (isUnresolvable(key) || (isUnresolvable(value) && ROUTING_CONFIG_KEY.test(normalized))) opaque = true;
		else entries.push([normalized, value]);
	};
	for (const name of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG"]) {
		const file = env[name];
		if (file === undefined || file === "") continue;
		if (isUnresolvable(file)) opaque = true;
		else entries.push(...readConfigFile(file));
	}
	const parameters = env.GIT_CONFIG_PARAMETERS;
	if (parameters !== undefined && parameters !== "") {
		if (isUnresolvable(parameters)) opaque = true;
		for (const match of parameters.matchAll(/'([^']*)'(?:='([^']*)')?/g)) {
			if (match[2] !== undefined) add(match[1], match[2]);
			else {
				const separator = match[1].indexOf("=");
				add(
					separator === -1 ? match[1] : match[1].slice(0, separator),
					separator === -1 ? "true" : match[1].slice(separator + 1),
				);
			}
		}
	}
	const count = env.GIT_CONFIG_COUNT;
	if (count !== undefined && count !== "") {
		const total = Number(count);
		if (!Number.isInteger(total) || total < 0 || total > 1000) opaque = true;
		else {
			for (let index = 0; index < total; index++) {
				const key = env[`GIT_CONFIG_KEY_${index}`];
				if (key !== undefined) add(key, env[`GIT_CONFIG_VALUE_${index}`] ?? "");
			}
		}
	}
	return { entries, opaque };
}

function lastConfigValue(config: GitConfigEntries, key: string): string | undefined {
	for (let index = config.length - 1; index >= 0; index--) {
		if (config[index][0] === key) return config[index][1];
	}
	return undefined;
}

/**
 * Whether a remote location reaches polysimulator, before or after the
 * `url.<base>.insteadOf` / `pushInsteadOf` rewrites git applies to it.
 */
function locationIsPolysim(location: string, config: GitConfigEntries): boolean {
	if (isPolysimulatorRemoteUrl(location)) return true;
	for (const [key, prefix] of config) {
		const rewrite = /^url\.(.+)\.(?:push)?insteadof$/.exec(key);
		if (!rewrite || prefix === "") continue;
		for (const url of location.split(/\s+/)) {
			if (url.startsWith(prefix) && isPolysimulatorRemoteUrl(`${rewrite[1]}${url.slice(prefix.length)}`))
				return true;
		}
	}
	return false;
}

/** A refspec whose destination is main, or could be once the shell expands it. */
function refspecMayBeMain(refspec: string): boolean {
	return SHELL_GLOB.test(refspec) || isUnresolvable(refspec) || isMainRefspec(refspec);
}

const GIT_GLOBAL_VALUE_OPTIONS: Record<string, true> = {
	"--namespace": true,
	"--super-prefix": true,
	"--attr-source": true,
};
const GIT_PUSH_VALUE_OPTIONS: Record<string, true> = {
	"-o": true,
	"--push-option": true,
	"--receive-pack": true,
	"--exec": true,
};
/** The git commands that send refs to a remote. */
const GIT_PUSH_COMMANDS: Record<string, true> = { push: true, "send-pack": true, "http-push": true };
/** Builtins git runs even when an alias of the same name exists. */
const GIT_BUILTINS: Record<string, true> = {
	add: true,
	am: true,
	apply: true,
	blame: true,
	branch: true,
	checkout: true,
	"cherry-pick": true,
	clean: true,
	clone: true,
	commit: true,
	config: true,
	describe: true,
	diff: true,
	fetch: true,
	grep: true,
	init: true,
	log: true,
	"ls-files": true,
	"ls-remote": true,
	merge: true,
	mv: true,
	pull: true,
	rebase: true,
	reflog: true,
	remote: true,
	reset: true,
	restore: true,
	"rev-list": true,
	"rev-parse": true,
	revert: true,
	rm: true,
	show: true,
	stash: true,
	status: true,
	submodule: true,
	switch: true,
	tag: true,
	worktree: true,
};
const SUBTREE_VALUE_OPTIONS: Record<string, true> = {
	"-P": true,
	"--prefix": true,
	"-m": true,
	"--message": true,
	"--onto": true,
	"-b": true,
	"--branch": true,
};

/** What a git invocation runs with: its directory and the config it sees. */
interface GitContext {
	readonly cwd: string | undefined;
	readonly config: () => GitConfigEntries;
	/** Config the guard cannot read reaches this invocation. */
	readonly opaque: boolean;
}

/**
 * Checks `git push`, `git send-pack` and `git http-push` arguments (the words
 * after the command name).
 */
function checkPushArguments(
	command: string,
	args: readonly string[],
	context: GitContext,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	let repoOption: string | undefined;
	const positional: string[] = [];
	let pushesEveryBranch = false;
	for (let index = 0; index < args.length; index++) {
		const word = args[index];
		if (word === "--") {
			positional.push(...args.slice(index + 1));
			break;
		}
		if (word === "--all" || word === "--mirror" || word === "--branches" || word === "--stdin") {
			pushesEveryBranch = true;
		} else if (word.startsWith("--repo=")) {
			repoOption = word.slice("--repo=".length);
		} else if (word === "--repo" || GIT_PUSH_VALUE_OPTIONS[word] === true) {
			if (word === "--repo") repoOption = args[index + 1];
			index++;
		} else if (!word.startsWith("-")) {
			positional.push(word);
		}
	}

	// `--repo` is the `<repository>` argument; a positional one takes precedence.
	const target = positional[0] ?? repoOption;
	const refspecs = positional.slice(1);
	const config = context.config();
	const remotes = remotesIn(context.cwd, options);
	const configured = remotesFromConfig(config);
	const known = (name: string): boolean =>
		(remotes !== undefined && Object.hasOwn(remotes, name)) || Object.hasOwn(configured, name);
	const urlsOf = (name: string): string => [remotes?.[name], configured[name]].filter(Boolean).join(" ");
	const isPolysim = (location: string): boolean => locationIsPolysim(location, config);

	let targetIsPolysim: boolean;
	if (target === undefined) {
		targetIsPolysim =
			remotes === undefined || [...Object.values(remotes), ...Object.values(configured)].some(isPolysim);
	} else if (isUnresolvable(target) || SHELL_GLOB.test(target) || isPolysim(target)) {
		targetIsPolysim = true;
	} else if (known(target)) {
		targetIsPolysim = isPolysim(urlsOf(target));
	} else {
		// A URL or path that is not polysimulator. A bare name that is no configured
		// remote is refused by git itself, unless the remotes were unreadable.
		targetIsPolysim = !/[:/\\]/.test(target) && remotes === undefined;
	}
	if (context.opaque) {
		// Unreadable config may rewrite the destination: judge by where the command runs too.
		const scopeRemotes = remotes === undefined ? undefined : Object.values(remotes);
		if (targetIsPolysim || scopeRemotes === undefined || scopeRemotes.some(isPolysim)) return DENIAL;
		return undefined;
	}
	if (!targetIsPolysim) return undefined;
	if (pushesEveryBranch) return DENIAL;

	// `remote.<name>.push` refspecs apply to every push to that remote, with or
	// without refspecs on the command line.
	const configuredRefspecs = config
		.filter(([key]) => (target === undefined ? /^remote\..+\.push$/.test(key) : key === `remote.${target}.push`))
		.map(([, value]) => value);
	if (configuredRefspecs.some(refspecMayBeMain)) return DENIAL;

	const currentBranch = (): string | undefined =>
		context.cwd === undefined ? undefined : (options?.getCurrentBranch ?? getCurrentGitBranchSync)(context.cwd);

	if (refspecs.length === 0) {
		// `send-pack` without refs updates every branch both sides have.
		if (command !== "push") return DENIAL;
		if (configuredRefspecs.length > 0) return undefined;
		const mode = (lastConfigValue(config, "push.default") ?? "simple").toLowerCase();
		if (mode === "nothing") return undefined;
		if (mode === "matching") return DENIAL;
		// No refspec pushes the current branch; a detached or unreadable HEAD fails closed.
		const branch = currentBranch();
		if (isMainBranchName(branch)) return DENIAL;
		if (mode === "upstream" || mode === "tracking") {
			return isMainBranchName(lastConfigValue(config, `branch.${branch}.merge`)) ? DENIAL : undefined;
		}
		return undefined;
	}
	for (const ref of refspecs) {
		// A glob can include main, and a variable can be main.
		if (refspecMayBeMain(ref)) return DENIAL;
		const source = ref.replace(/^\+/, "").toLowerCase();
		if ((source === "head" || source === "@") && isMainBranchName(currentBranch())) return DENIAL;
	}
	return undefined;
}

/** `git subtree push -P <prefix> <repository> <ref>` pushes to `refs/heads/<ref>`. */
function checkSubtreePush(
	args: readonly string[],
	context: GitContext,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const word = args[index];
		if (SUBTREE_VALUE_OPTIONS[word] === true) index++;
		else if (!word.startsWith("-")) positional.push(word);
	}
	const [target, ref] = positional;
	if (target === undefined || ref === undefined) return undefined;
	const destination = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
	return checkPushArguments("push", [target, `HEAD:${destination}`], context, options);
}

/**
 * Checks a `git` invocation: global options, `-c` config, aliases, and the
 * commands that send refs (`push`, `send-pack`, `http-push`, `subtree push`).
 */
function checkGitInvocation(
	words: readonly string[],
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
	depth: number,
): PolysimDenialResult | undefined {
	let cwd = scope.cwd;
	const fromEnvironment = environmentConfig(scope.gitConfigEnv);
	const inline: Array<[string, string]> = [];
	let opaque = fromEnvironment.opaque;
	const addInline = (setting: string | undefined): void => {
		if (setting === undefined) return;
		const separator = setting.indexOf("=");
		const key = normalizeConfigKey(separator === -1 ? setting : setting.slice(0, separator));
		const value = separator === -1 ? "true" : setting.slice(separator + 1);
		if (isUnresolvable(key) || (isUnresolvable(value) && ROUTING_CONFIG_KEY.test(key))) opaque = true;
		else inline.push([key, value]);
	};

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
		if (word === "-c") {
			addInline(words[index + 1]);
			index += 2;
			continue;
		}
		if (word === "--config-env" || word.startsWith("--config-env=")) {
			// `--config-env=<key>=<ENVVAR>`: the value lives in a variable the guard does not see.
			const setting = word === "--config-env" ? words[index + 1] : word.slice("--config-env=".length);
			const key = normalizeConfigKey((setting ?? "").split("=")[0]);
			if (isUnresolvable(key) || ROUTING_CONFIG_KEY.test(key)) opaque = true;
			index += word === "--config-env" ? 2 : 1;
			continue;
		}
		if (GIT_GLOBAL_VALUE_OPTIONS[word] === true) {
			index += 2;
			continue;
		}
		if (!word.startsWith("-")) break;
		index++;
	}
	const command = words[index]?.toLowerCase();
	if (command === undefined) return undefined;

	let fileConfig: GitConfigEntries | undefined;
	const context: GitContext = {
		cwd,
		opaque,
		config: () => {
			fileConfig ??= (options?.readGitConfig ?? readGitConfigSync)(cwd);
			return [...fileConfig, ...fromEnvironment.entries, ...inline];
		},
	};
	const rest = words.slice(index + 1);
	const commandScope: CommandScope = { ...scope, cwd };

	// `git $CMD origin main` may be a push.
	if (GIT_PUSH_COMMANDS[command] === true || isUnresolvable(command)) {
		return checkPushArguments(isUnresolvable(command) ? "push" : command, rest, context, options);
	}
	if (command === "subtree") {
		return rest[0]?.toLowerCase() === "push" ? checkSubtreePush(rest.slice(1), context, options) : undefined;
	}
	if (GIT_BUILTINS[command] === true) return undefined;

	const alias = lastConfigValue(context.config(), `alias.${command}`);
	if (alias === undefined) {
		// Config the guard cannot read may define this command as an alias of push.
		return opaque && scopeIsPolysim(commandScope, options) ? DENIAL : undefined;
	}
	if (depth >= MAX_INTERPRETED_SHELL_DEPTH) return scopeIsPolysim(commandScope, options) ? DENIAL : undefined;
	if (alias.startsWith("!")) {
		return checkScript(
			[alias.slice(1), ...rest.map(word => `'${word.replaceAll("'", "'\\''")}'`)].join(" "),
			commandScope,
			options,
			depth + 1,
		);
	}
	const expansion = splitWords(alias)
		.map(word => word.text)
		.filter(Boolean);
	return checkGitInvocation(["git", ...words.slice(1, index), ...expansion, ...rest], scope, options, depth + 1);
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

/**
 * The refusal for merging pull request `pr`: none when its base is known and
 * not main, a retryable one when the base could not be looked up.
 */
function prMergeDenial(
	pr: string | undefined,
	repo: string | undefined,
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	if ((pr !== undefined && isUnresolvable(pr)) || (repo !== undefined && isUnresolvable(repo))) return DENIAL;
	const prIsUrl = pr !== undefined && /github\.com[/:]/i.test(pr);
	// Nowhere to ask `gh` from: the base cannot be learned, so it counts as main.
	if (!prIsUrl && repo === undefined && scope.cwd === undefined) return DENIAL;
	return baseDenialFor((options?.resolvePrBase ?? defaultResolvePrBase)(pr, repo, scope.cwd ?? process.cwd()));
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
		isTargetPolysim = /bavariance\/polysimulator\/pull\//i.test(pr ?? "");
	} else if (repo !== undefined) {
		isTargetPolysim = repoIsPolysim(repo, scope, options);
	} else {
		isTargetPolysim = scopeIsPolysim(scope, options);
	}
	if (!isTargetPolysim) return undefined;
	return prMergeDenial(pr, prIsUrl ? undefined : repo, scope, options);
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

/** One GitHub REST or GraphQL request, however it is sent. */
interface ApiRequest {
	readonly endpoint: string;
	/** The explicit method, upper-cased; `undefined` when the sender picks one. */
	readonly method: string | undefined;
	readonly fields: ReadonlyMap<string, string>;
	/** The body is a file, a variable, or JSON the guard does not parse. */
	readonly bodyIsOpaque: boolean;
	/** Everything the request carries, searched for GraphQL mutations. */
	readonly text: string;
	/** The repository `{owner}/{repo}` placeholders stand for (`-R`, `GH_REPO`). */
	readonly repo: string | undefined;
}

function normalizeEndpoint(endpoint: string): string {
	let text = endpoint.trim();
	try {
		text = decodeURIComponent(text);
	} catch {
		// Keep a malformed escape as written; GitHub would reject it.
	}
	return text
		.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
		.replace(/^[\w.-]*api\.github\.com\//i, "")
		.replace(/^api\/v3\//i, "")
		.replace(/[?#].*$/, "")
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
}

/**
 * Judges a GitHub API request: merging a pull request into main, moving the
 * main ref, merging into main, or committing file contents to main.
 */
function checkApiRequest(
	request: ApiRequest,
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	const method = request.method !== undefined && !isUnresolvable(request.method) ? request.method : undefined;
	const normalized = normalizeEndpoint(request.endpoint);
	const repoScopeIsPolysim = (): boolean =>
		request.repo !== undefined ? repoIsPolysim(request.repo, scope, options) : scopeIsPolysim(scope, options);

	if (normalized === "graphql") {
		// A GraphQL mutation names its pull request by node ID, so the repository
		// is whatever the call's context says it is.
		const merges = request.bodyIsOpaque || GRAPHQL_MAIN_MUTATIONS.test(request.text);
		if (!merges) return undefined;
		return /polysimulator/i.test(request.text) || repoScopeIsPolysim() ? DENIAL : undefined;
	}

	let relative = normalized;
	let resolverRepo = request.repo;
	const repoPath = /^repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(normalized);
	if (repoPath) {
		const [, owner, name, rest] = repoPath;
		if (REPO_PLACEHOLDER.test(owner) || REPO_PLACEHOLDER.test(name)) {
			if (!repoScopeIsPolysim()) return undefined;
		} else {
			const polysim =
				isUnresolvable(owner) ||
				isUnresolvable(name) ||
				`${owner}/${name.replace(/\.git$/, "")}` === POLYSIM_REPO_SLUG;
			if (!polysim) return undefined;
			resolverRepo = `${owner}/${name}`;
		}
		relative = rest;
	} else if (!repoScopeIsPolysim()) {
		return undefined;
	}

	// Without a method the sender uses GET, or POST once a field or body is
	// attached; a method held in a variable counts as a write.
	const effectiveMethod =
		request.method === undefined
			? request.fields.size > 0 || request.bodyIsOpaque
				? "POST"
				: "GET"
			: (method ?? "UNKNOWN");
	if (effectiveMethod === "GET") return undefined;
	const field = (key: string): string | undefined => (request.bodyIsOpaque ? undefined : request.fields.get(key));

	const merge = /^pulls\/([^/]+)\/merge$/.exec(relative);
	if (merge) return prMergeDenial(merge[1], resolverRepo, scope, options);
	if (relative === "git/refs/heads/main") return DENIAL;
	if (relative === "git/refs" && isMainRefspec(field("ref") ?? "")) return DENIAL;
	if (relative === "merges" && isMainBranchName(field("base"))) return DENIAL;
	// A contents write without `branch` commits to the default branch, main.
	if (relative.startsWith("contents/") && isMainBranchName(field("branch"))) return DENIAL;
	return undefined;
}

/**
 * Checks a `gh api` invocation.
 */
function checkGhApiInvocation(
	words: readonly string[],
	scope: CommandScope,
	options?: PolysimGuardOptions,
): PolysimDenialResult | undefined {
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
	return checkApiRequest(
		{
			endpoint,
			method,
			fields,
			bodyIsOpaque,
			text: [...fields.values()].join("\n"),
			repo: ghRepoFlag(words) ?? scope.ghRepo,
		},
		scope,
		options,
	);
}

const HTTP_CLIENTS: Record<string, true> = {
	curl: true,
	wget: true,
	http: true,
	https: true,
	xh: true,
	xhs: true,
	"invoke-restmethod": true,
	irm: true,
	"invoke-webrequest": true,
	iwr: true,
};
const HTTP_BODY_OPTION =
	/^(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--body-file|-body|-infile)(?:=|$)/i;
const GITHUB_API_URL = /(?:^|\/\/|\.)api\.github\.com\/|\/api\/v3\//i;

/**
 * Checks an HTTP client (`curl`, `wget`, httpie, `Invoke-RestMethod`) sent to
 * the GitHub API. The JSON body is not parsed, so a write it could aim at
 * main counts as one.
 */
function checkHttpClientInvocation(
	words: readonly string[],
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	const name = commandName(words[0]);
	let method: string | undefined;
	let hasBody = false;
	const urls: string[] = [];
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		const lower = word.toLowerCase();
		if (word === "-X" || lower === "--request" || lower === "--method" || lower === "-method") {
			method = words[index + 1]?.toUpperCase();
			index++;
		} else if (/^--(?:request|method)=/i.test(word)) {
			method = word.slice(word.indexOf("=") + 1).toUpperCase();
		} else if (/^-X./.test(word)) {
			method = word.slice(2).toUpperCase();
		} else if (word === "-G" || lower === "--get") {
			method = "GET";
		} else if (word === "-I" || lower === "--head") {
			method = "HEAD";
		} else if (HTTP_BODY_OPTION.test(word) || /^-d./.test(word)) {
			hasBody = true;
		} else if (GITHUB_API_URL.test(word)) {
			urls.push(word);
		} else if (
			index === 1 &&
			(name === "http" || name === "https" || name.startsWith("xh")) &&
			/^[A-Z]+$/.test(word)
		) {
			method = word;
		}
	}
	const text = words.join(" ");
	for (const url of urls) {
		const found = checkApiRequest(
			{ endpoint: url, method, fields: new Map(), bodyIsOpaque: hasBody, text, repo: undefined },
			scope,
			options,
		);
		if (found) return found;
	}
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
const CMD_SCRIPT_FLAG = /^\/[ck]$/i;
/** PowerShell options that take a value, by the prefixes PowerShell accepts for them. */
const POWERSHELL_VALUE_OPTIONS = [
	"-executionpolicy",
	"-ep",
	"-windowstyle",
	"-inputformat",
	"-outputformat",
	"-version",
	"-psconsolefile",
	"-configurationname",
	"-workingdirectory",
	"-wd",
	"-settingsfile",
	"-custompipename",
];

/** The script text a `pwsh`/`powershell` command line runs, decoding `-EncodedCommand`. */
function powershellScript(words: readonly string[], position: number, name: string): string | undefined {
	for (let index = position + 1; index < words.length; index++) {
		const lower = words[index].toLowerCase();
		if (!lower.startsWith("-")) {
			// Windows PowerShell runs a bare first argument as a command; pwsh runs it as a file.
			return name === "powershell" ? words.slice(index).join(" ") : undefined;
		}
		if (lower.length >= 2 && ("-encodedcommand".startsWith(lower) || lower === "-ec")) {
			const encoded = words[index + 1];
			return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf16le");
		}
		if (
			lower.length >= 2 &&
			("-command".startsWith(lower) || "-commandwithargs".startsWith(lower) || lower === "-cwa")
		) {
			return words.slice(index + 1).join(" ");
		}
		if (lower.length >= 2 && "-file".startsWith(lower)) return undefined;
		if (POWERSHELL_VALUE_OPTIONS.some(option => option.startsWith(lower) && lower.length >= 3)) index++;
	}
	return undefined;
}

/** The shell text a `sh -c`, `eval`, `pwsh -Command` or `cmd /c` at `position` runs. */
function interpretedScript(words: readonly string[], position: number, name: string): string | undefined {
	const shape = INTERPRETED_SCRIPT_COMMANDS.get(name);
	if (shape === "nextWord") return words[position + 1];
	if (shape === "afterScriptFlag") {
		const flag = words.findIndex((word, index) => index > position && SCRIPT_FLAG.test(word));
		return flag === -1 ? undefined : words[flag + 1];
	}
	if (POWERSHELL_COMMANDS[name] === true) return powershellScript(words, position, name);
	if (name !== "cmd") return undefined;
	const flag = words.findIndex((word, index) => index > position && CMD_SCRIPT_FLAG.test(word));
	// cmd drops a `^` escape before it runs the line: `g^it` is `git`.
	return flag === -1
		? undefined
		: words
				.slice(flag + 1)
				.join(" ")
				.replace(/\^(.)/g, "$1");
}

/** The inline code a `python -c`, `node -e`, `perl -e`, `ruby -e` or `php -r` at `position` runs. */
function inlineCode(words: readonly string[], position: number, name: string): string | undefined {
	let flag: RegExp | undefined;
	if (/^python(?:\d+(?:\.\d+)*)?w?$|^py$/.test(name)) flag = /^-[a-z]*c$/i;
	else if (name === "node" || name === "nodejs" || name === "bun") flag = /^(?:-e|--eval|-p|--print)$/;
	else if (name === "deno") flag = /^eval$/;
	else if (name === "perl" || name === "ruby" || name === "osascript") flag = /^-[a-z]*e$/i;
	else if (name === "php") flag = /^-r$/;
	if (flag === undefined) return undefined;
	const pattern = flag;
	const at = words.findIndex((word, index) => index > position && pattern.test(word));
	return at === -1 ? undefined : words[at + 1];
}

const CODE_DRIVES_GITHUB_WRITE =
	/\bgit\b[\s\S]*?\b(?:push|send-pack|subtree)\b|\bgh\b[\s\S]*?\b(?:merge|api)\b|pulls\/[^\s'"]+\/merge|mergePullRequest|git\/refs/i;

function checkInlineCode(
	code: string,
	name: string,
	scope: CommandScope,
	options: PolysimGuardOptions | undefined,
): PolysimDenialResult | undefined {
	if (!CODE_DRIVES_GITHUB_WRITE.test(code)) return undefined;
	if (!/polysimulator/i.test(code) && !scopeIsPolysim(scope, options)) return undefined;
	return {
		reason: `${POLYSIM_MAIN_DENIAL_MESSAGE}. This command drives git or gh from inline ${name} code the guard cannot read; run git or gh directly so the target branch can be checked.`,
		targetRepo: POLYSIM_REPO_SLUG,
	};
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

const MAX_BRACE_EXPANSIONS = 256;

function braceRange(from: string, to: string): string[] | undefined {
	const numeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
	if (!numeric && (from.length !== 1 || to.length !== 1)) return undefined;
	const start = numeric ? Number(from) : from.charCodeAt(0);
	const end = numeric ? Number(to) : to.charCodeAt(0);
	const step = start <= end ? 1 : -1;
	const values: string[] = [];
	for (let value = start; values.length < MAX_BRACE_EXPANSIONS; value += step) {
		values.push(numeric ? String(value) : String.fromCharCode(value));
		if (value === end) break;
	}
	return values;
}

/**
 * Bash brace expansion of an unquoted word: `HEAD:{main,x}` is the two words
 * `HEAD:main HEAD:x`. `${VAR}`, `@{u}` and `{owner}` are not expansions.
 */
function expandBraces(word: string): string[] {
	for (let open = 0; open < word.length; open++) {
		if (word[open] !== "{" || word[open - 1] === "$") continue;
		let depth = 0;
		let close = -1;
		const commas: number[] = [];
		for (let cursor = open; cursor < word.length; cursor++) {
			const character = word[cursor];
			if (character === "{") depth++;
			else if (character === "}" && --depth === 0) {
				close = cursor;
				break;
			} else if (character === "," && depth === 1) commas.push(cursor);
		}
		if (close === -1) return [word];
		let alternatives: string[] | undefined;
		if (commas.length > 0) {
			alternatives = [];
			let start = open + 1;
			for (const end of [...commas, close]) {
				alternatives.push(word.slice(start, end));
				start = end + 1;
			}
		} else {
			const range = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])$/.exec(word.slice(open + 1, close));
			if (range) alternatives = braceRange(range[1], range[2]);
		}
		if (alternatives === undefined) continue;
		const prefix = word.slice(0, open);
		const suffix = word.slice(close + 1);
		const expanded: string[] = [];
		for (const alternative of alternatives) {
			for (const result of expandBraces(`${prefix}${alternative}${suffix}`)) {
				expanded.push(result);
				if (expanded.length >= MAX_BRACE_EXPANSIONS) return expanded;
			}
		}
		return expanded;
	}
	return [word];
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
	const first = commandName(words[0]);
	if (CD_COMMANDS[first] === true) {
		applyCd(words, scope);
		return undefined;
	}
	if (first === "alias") {
		// `alias gp='git push origin main'` is refused where it is defined.
		for (const word of words.slice(1)) {
			const separator = word.indexOf("=");
			if (separator <= 0) continue;
			const found = checkScript(word.slice(separator + 1), { ...scope }, options, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	for (const word of words) {
		const assignment = SCOPE_VARIABLE.exec(word);
		if (assignment) applyScopeVariable(scope, assignment[1], assignment[2]);
	}
	for (let position = 0; position < words.length; position++) {
		const word = words[position];
		const name = commandName(word);
		let found: PolysimDenialResult | undefined;
		if (name === "git" || name === "hub") {
			found = checkGitInvocation(words.slice(position), scope, options, depth);
		} else if (name.startsWith("git-")) {
			// `git-push`, `git-send-pack`: the dashed binaries git itself runs.
			found = checkGitInvocation(["git", name.slice(4), ...words.slice(position + 1)], scope, options, depth);
		} else if (name === "gh") {
			found = checkGhInvocation(words.slice(position), scope, options);
		} else if (HTTP_CLIENTS[name] === true) {
			found = checkHttpClientInvocation(words.slice(position), scope, options);
		} else if (word.startsWith("$") || word.startsWith("`")) {
			// `$g push origin main`: a command named by a variable is read as git and as gh.
			const rest = words.slice(position + 1);
			found =
				checkGitInvocation(["git", ...rest], scope, options, depth) ??
				checkGhInvocation(["gh", ...rest], scope, options);
		} else {
			const script = interpretedScript(words, position, name);
			if (script !== undefined) {
				found = checkScript(script, { ...scope }, options, depth + 1);
			} else {
				const code = inlineCode(words, position, name);
				if (code !== undefined) found = checkInlineCode(code, name, scope, options);
			}
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
		// A word holding whitespace was quoted, and a quoted brace is literal.
		const words = splitWords(segment).flatMap(word => {
			const text = word.text.trim();
			if (text === "") return [];
			return word.literal || /\s/.test(text) ? [text] : expandBraces(text);
		});
		const found = checkWords(words, scope, options, depth);
		if (found) return found;
	}
	return undefined;
}

const INHERITED_SCOPE_VARIABLES = /^(?:GIT_WORK_TREE|GIT_DIR|GH_REPO|GIT_CONFIG(?:_[A-Z0-9_]+)?)$/;

function initialScope(
	cwd: string | undefined,
	env: NodeJS.ProcessEnv | Record<string, string> | undefined,
): CommandScope {
	const scope: CommandScope = { cwd, ghRepo: undefined, gitConfigEnv: {} };
	if (env) {
		// GIT_DIR after GIT_WORK_TREE: it decides where git reads remotes when both are set.
		const names = Object.keys(env)
			.filter(name => INHERITED_SCOPE_VARIABLES.test(name))
			.sort((a, b) => Number(a === "GIT_DIR") - Number(b === "GIT_DIR"));
		for (const name of names) {
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
	if (op !== "pr_merge" && op !== "pr_push") return undefined;

	const repo = typeof record.repo === "string" ? record.repo : undefined;
	const isTargetPolysim = repo
		? isPolysimulatorRepo(repo)
		: isCwdPolysimulatorRepo(cwd, options?.getRemotes ?? getGitRemoteUrlsSync);
	if (!isTargetPolysim) return undefined;

	if (op === "pr_push") {
		// The real destination is the PR head, checked at push time by
		// `checkPushTargetPolysimMainDenial`; a local `main` is refused up front.
		const branch = typeof record.branch === "string" ? record.branch : undefined;
		return branch !== undefined && isMainRefspec(branch) ? DENIAL : undefined;
	}

	const explicitBase = typeof record.base === "string" ? record.base.trim() : undefined;
	if (explicitBase) return isMainBranchName(explicitBase) ? DENIAL : undefined;

	// Base not specified: resolve it. Fail closed if base is main or unknown.
	const pr =
		typeof record.pr === "string" || typeof record.pr === "number"
			? record.pr
			: Array.isArray(record.pr) && record.pr.length > 0
				? (record.pr[0] as string | number)
				: undefined;
	return baseDenialFor((options?.resolvePrBase ?? defaultResolvePrBase)(pr, repo, cwd));
}
