/**
 * Path helpers for the directories under the veyyon config root: profiles, the agent directory, and
 * the data, state and cache bases.
 *
 * The config root itself (`VEYYON_CONFIG_DIR`, default `~/.veyyon`) is resolved in `./config-root`,
 * and the global `config.yml` at its root is read in `./global-config`. VEYYON_CODING_AGENT_DIR
 * overrides the agent directory. That override applies in default-profile mode only: a named
 * profile derives its own `~/.veyyon/profiles/<name>/agent` and ignores the variable.
 *
 * On Linux and macOS, when XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME are
 * set AND the corresponding `$XDG_*_HOME/veyyon` directory already exists, paths
 * are redirected there. The existence check is the migration signal: setting the
 * variable alone changes nothing until `veyyon config init-xdg` has created and
 * populated that directory. Named profiles key the same check on the
 * profile-specific path, so a profile's location is fixed at first activation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };
import { APP_DIRECTORY_SLUG } from "./app-identity";
// FIRST, for its side effect: the environment scrub and `$HOME/.env`. Every path this module caches at
// load is decided by `VEYYON_CODING_AGENT_DIR` and the `XDG_*` variables, so a user who sets one of those
// in `$HOME/.env` has to be heard before the first `DirResolver` is built. `./dotenv-home` imports nothing
// that can reach this file, which is why the `.env` layers needing a resolved directory stay in `./env`.
import "./dotenv-home";
import {
	CONFIG_DIR_NAME,
	DEFAULT_PROFILE_DIR_NAME,
	getConfigDirName,
	getGlobalConfigRootDir,
	getSharedAuthDir,
	normalizeProfileName,
	PROFILES_DIR_NAME,
	SUBAGENTS_DIR_NAME,
} from "./config-root";
import { AGENT_DIR_ENV_KEYS, PROFILE_ENV_KEYS, pickProcessEnv } from "./dir-env-keys";
import { isMissingPath } from "./fs-error";
import {
	MAIN_CONFIG_FILENAMES,
	readGlobalDefaultProfileSafe,
	readGlobalProfileSharingSafe,
	resolveGlobalDefaultProfile,
} from "./global-config";
import { logFileName } from "./log-file";
import { isUuid } from "./regex";
import { bareVersion } from "./semver";
import { errorMessage } from "./type-guards";

/**
 * The lowercase slug used in filesystem paths.
 *
 * Read from `app-identity.ts`, which also owns the capitalized `APP_DISPLAY_NAME` a person reads. The two used
 * to share this name across packages, and a slug in a notification title or a capitalized name in a path is
 * the kind of mistake nothing reports.
 */
export const APP_NAME: string = APP_DIRECTORY_SLUG;

/**
 * The short launch alias installed next to the binary. Both installers create it
 * (`ALIAS_NAME` in scripts/install.sh and scripts/install.ps1) and the shell
 * completion generator registers completions under it, so every consumer must
 * read this constant rather than re-hardcoding the string.
 * `scripts/installer-alias-parity.test.ts` fails if the shell scripts drift.
 */
export const APP_ALIAS: string = "vey";

/** Canonical marketing/docs site. Single owner — import, never re-hardcode. */
export const SITE_URL: string = "https://veyyon.dev";

/** Public changelog/releases page. Where `/changelog` and the update notice point. */
export const CHANGELOG_URL: string = "https://veyyon.dev/changelog";

/**
 * The changelog page, scrolled to one version's entry.
 *
 * Three surfaces want to link a specific version: the post-update hint ("here is
 * what changed"), the rollback picker (per row, "what am I giving up"), and any
 * release tooling that names a version. They must agree, so the anchor format
 * lives here rather than being rebuilt at each call site.
 *
 * The format is the one `apps/site/tools/gen-changelog.mjs` emits: it writes
 * `<h2 id="v1-2-3">` for version `1.2.3`, replacing every dot with a dash
 * because a dot in a fragment id is legal but awkward to select in CSS. A
 * leading `v` in the argument is tolerated, since callers hold versions both
 * ways (`ReleaseInfo.tag` is `v1.2.3`, `ReleaseInfo.version` is `1.2.3`), and
 * silently producing `#vv1-2-3` would land the reader at the top of the page
 * with no indication that the link missed.
 */
export function changelogUrlForVersion(version: string): string {
	const bare = bareVersion(version);
	return `${CHANGELOG_URL}#v${bare.replace(/\./g, "-")}`;
}

/** Basename of the per-install UUID file at the config root (see {@link getInstallId}). */
const INSTALL_ID_FILE = "install-id";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

/**
 * Resolve the active profile from the `VEYYON_PROFILE` env var. An
 * explicitly-empty value selects the default profile. Delegates
 * validation/normalization to {@link normalizeProfileName} (which throws on a
 * syntactically invalid value).
 */
export function resolveProfileEnv(value: string | undefined): string | undefined {
	return normalizeProfileName(value);
}

// The list has one owner, `./dir-env-keys`, because `./dotenv-home` needs it too and cannot import this
// module (this module imports IT). Re-exported here because callers have always taken it from `dirs`.
export { DIR_OVERRIDE_ENV_KEYS } from "./dir-env-keys";

/** One owner for reading the agent-dir override from the environment. */
function readAgentDirEnv(): string | undefined {
	return pickProcessEnv(...AGENT_DIR_ENV_KEYS);
}

/**
 * One owner for writing the agent-dir override so child processes reading the
 * key see the same value; `undefined` clears it.
 */
function writeAgentDirEnv(dir: string | undefined): void {
	for (const key of AGENT_DIR_ENV_KEYS) {
		if (dir === undefined) delete process.env[key];
		else process.env[key] = dir;
	}
}

/** Resolve the active profile from `VEYYON_PROFILE`. */
export function resolveProfileFromEnv(): string | undefined {
	for (const key of PROFILE_ENV_KEYS) {
		const value = process.env[key];
		if (value === undefined) continue;
		try {
			return normalizeProfileName(value);
		} catch (error) {
			// Name which env var carried the bad value — the operator set it out-of-band.
			throw new Error(`Invalid ${key}: ${errorMessage(error)}`);
		}
	}
	return undefined;
}

/**
 * Module-load profile resolution. Unlike {@link resolveStartupProfile}, an
 * invalid VEYYON_PROFILE value or broken global config
 * does NOT throw here — a bad value must not crash a bare `import` of this
 * module with an uncaught stack trace before the CLI's error handling is in
 * scope. The default profile is used instead; the CLI re-validates (see
 * `runCli` in coding-agent/src/cli.ts) so the user still gets a clean error.
 */
function readProfileFromEnvSafe(): string | undefined {
	try {
		return resolveProfileFromEnv();
	} catch {
		return undefined;
	}
}

/** Module-load-safe {@link resolveStartupProfile}: env (safe) first, then the global defaultProfile (safe). */
function resolveStartupProfileSafe(): string | undefined {
	if (profileEnvIsSet()) return readProfileFromEnvSafe();
	return readGlobalDefaultProfileSafe();
}

/**
 * Whether an `XDG_*_HOME` value may be used as a base directory.
 *
 * The XDG base-directory spec is explicit that these variables must hold
 * ABSOLUTE paths and that a relative one is invalid and must be ignored. That
 * matters here beyond spec compliance: a relative value would be joined and then
 * `existsSync`-tested against the CURRENT WORKING DIRECTORY, so the same session
 * would resolve its cache, state, and data roots differently after any `cd`, and
 * veyyon would scatter directories through whatever tree the user happened to be
 * standing in.
 *
 * Ignoring is the spec's remedy, but ignoring in silence is not: the user set the
 * variable and would otherwise get the default root with no indication their
 * configuration was discarded. So the value is dropped AND announced. This uses
 * `process.emitWarning` rather than the logger for the reason given elsewhere in
 * this file: the logger imports this module for its own paths, so importing it
 * back would close a cycle in the module that resolves every path.
 */
function isUsableXdgBase(envVar: string, value: string): boolean {
	if (path.isAbsolute(value)) return true;
	process.emitWarning(
		`${envVar} is set to the relative path "${value}"; the XDG base-directory spec requires an absolute path, ` +
			`so it is being ignored and veyyon is using its default location instead. ` +
			`Set ${envVar} to an absolute path (for example "${path.join(os.homedir(), value)}") to use it.`,
		{ code: "VEYYON_XDG_RELATIVE_PATH" },
	);
	return false;
}

/**
 * Every profile — including the default — lives under `profiles/<name>`.
 * The bare config root holds only global, cross-profile state (the global
 * `config.yml`, `install-id`, and `profiles/` itself); see
 * {@link migrateLegacyDefaultProfileLayout} for the one-time move off the
 * legacy bare-root layout.
 */
function getProfileConfigRoot(profile: string | undefined): string {
	return path.join(getGlobalConfigRootDir(), PROFILES_DIR_NAME, profile ?? DEFAULT_PROFILE_DIR_NAME);
}

/**
 * Whether any profile env var is present in the environment — including an
 * explicitly EMPTY `VEYYON_PROFILE=`, which deliberately forces the default
 * profile past the global `defaultProfile` setting.
 */
export function profileEnvIsSet(): boolean {
	return PROFILE_ENV_KEYS.some(key => process.env[key] !== undefined);
}

/**
 * Startup profile resolution shared by module load (safe) and the CLI
 * (strict): an env var — even empty — wins; otherwise the global
 * `defaultProfile`; otherwise the default profile.
 */
export function resolveStartupProfile(): string | undefined {
	if (profileEnvIsSet()) return resolveProfileFromEnv();
	return resolveGlobalDefaultProfile();
}

/**
 * Whether `agentDirEnv` is some profile's derived agent dir
 * (`<configRoot>/profiles/<name>/agent`), which `setProfile` exports to
 * children. Any profile counts, not only the one being resolved: a child
 * relaunched into the default profile (`/profile default`, `/resume` of a
 * default-profile session) inherits the parent profile's value, and honoring it
 * would run the default profile inside the parent's agent dir. An unresolvable
 * home leaves the value honored, as before, so module load stays non-throwing.
 */
function isProfileDerivedAgentDir(agentDirEnv: string | undefined): boolean {
	if (agentDirEnv === undefined || path.basename(agentDirEnv) !== "agent") return false;
	let profilesRoot: string;
	try {
		profilesRoot = path.join(getGlobalConfigRootDir(), PROFILES_DIR_NAME);
	} catch {
		return false;
	}
	return path.dirname(path.dirname(path.resolve(agentDirEnv))) === path.resolve(profilesRoot);
}
// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/**
 * Move the project directory, and the process working directory with it.
 *
 * This is the only place either of those changes. They are one thing wearing two
 * hats: `getProjectDir` answers project-relative lookups (settings discovery,
 * AGENTS.md, git detection) and `process.cwd()` answers everything a child
 * process or a relative path resolves against. If they drift apart, half the
 * program is looking at a directory the user never chose, and nothing says so.
 *
 * The `chdir` therefore runs first and the global is assigned only once it has
 * succeeded. Assigning first meant a directory that had been deleted or turned
 * unreadable between resolving it and entering it left `getProjectDir` naming a
 * path the process could not reach, which is exactly the drift this function
 * exists to prevent. Throws when the directory cannot be entered; there is no
 * usable state to fall back to.
 */
export function setProjectDir(dir: string): void {
	const resolved = standardizeMacOSPath(path.resolve(dir));
	try {
		process.chdir(resolved);
	} catch (error) {
		throw new Error(
			`Cannot enter the project directory: ${resolved}\n` +
				`  ${errorMessage(error)}\n` +
				`Check that the directory still exists and that you have permission to read it.`,
			{ cause: error },
		);
	}
	projectDir = resolved;
}

/**
 * Whether `dir` resolves to an existing directory. Any stat failure — a deleted
 * path (ENOENT), permission error, or a non-directory — returns `false`, so
 * callers can decide whether a directory is safe to `chdir` into or adopt as a
 * working directory before {@link setProjectDir} throws on it.
 */
export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Get the config agent directory name relative to home (e.g. ".veyyon/profiles/default/agent"). */
export function getConfigAgentDirName(): string {
	return path.join(getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "agent");
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * `$<envVar>/veyyon`, or a named profile's directory under it, when the variable holds a usable base
 * and that directory exists.
 */
function existingXdgRoot(envVar: string, profile: string | undefined): string | undefined {
	const value = process.env[envVar];
	if (!value || !isUsableXdgBase(envVar, value)) return undefined;
	try {
		const appRoot = path.join(value, APP_NAME);
		const root = profile ? path.join(appRoot, PROFILES_DIR_NAME, profile) : appRoot;
		return fs.existsSync(root) ? root : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves and caches all veyyon directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/veyyon/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/veyyon/.
	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(options: { agentDirOverride?: string; profile?: string } = {}) {
		const profile = normalizeProfileName(options.profile);
		this.configRoot = getProfileConfigRoot(profile);

		const defaultAgent = path.join(this.configRoot, "agent");
		const agentDirOverride = profile ? undefined : options.agentDirOverride;
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		// XDG is a Linux convention. On supported platforms, default profile state
		// resolves under $XDG_*_HOME/veyyon once `veyyon config init-xdg` has migrated
		// the user's data. Named profiles follow a stricter rule: the XDG choice
		// is keyed on the profile-specific XDG path, never the base app root.
		//
		// Why: if we consulted the base app root for named profiles too, the same
		// profile could resolve to `~/.veyyon/profiles/<name>` on first activation
		// (when no $XDG_*_HOME/veyyon exists yet) and then silently move to
		// `$XDG_*_HOME/veyyon/profiles/<name>` the moment the base appeared, orphaning
		// the earlier state. Pinning on the profile path means a profile's location
		// is decided at first activation and stays put until the user explicitly
		// migrates it (e.g. by mkdir'ing the XDG profile dir).
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			xdgData = existingXdgRoot("XDG_DATA_HOME", profile);
			xdgState = existingXdgRoot("XDG_STATE_HOME", profile);
			xdgCache = existingXdgRoot("XDG_CACHE_HOME", profile);
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		// XDG flattens the profile+agent prefix: ~/.veyyon/profiles/default/agent/sessions → $XDG_DATA_HOME/veyyon/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const key = cacheKey(subdir, xdg);
		const cached = this.#rootCache.get(key);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(key, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const key = cacheKey(subdir, xdg);
			const cached = this.#agentCache.get(key);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(key, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

/**
 * Cache key for a resolved subdirectory.
 *
 * The category is part of the key because it is part of the answer. Under XDG
 * the three categories are three different roots (`~/.local/share/veyyon`,
 * `~/.local/state/veyyon`, `~/.cache/veyyon`), so keying on the name alone
 * meant the first caller to ask for a given name decided the root for every
 * later caller, whatever category they asked for. Nothing collides today, and
 * that is exactly why it needed fixing before something did: the symptom would
 * be data written under one root and read back from another, on XDG machines
 * only, with no error anywhere.
 */
function cacheKey(subdir: string, xdg?: XdgCategory): string {
	return `${xdg ?? ""}\0${subdir}`;
}

/**
 * Decide which `VEYYON_CODING_AGENT_DIR` value to capture as the pre-profile
 * baseline. A value equal to any profile's derived agent dir is profile-derived
 * (propagated by a parent's `setProfile`), so it must NOT be snapshotted as the
 * default-mode baseline — otherwise default mode would resolve to that profile's
 * agent dir. Returns `undefined` in that case so reset falls back to the
 * default profile's agent dir.
 */
function resolvePreProfileAgentDir(): string | undefined {
	const agentDirEnv = readAgentDirEnv();
	return isProfileDerivedAgentDir(agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = resolveStartupProfileSafe();

/**
 * Resolve the agent-dir override for the current `activeProfile` from the live
 * environment. A named profile derives its own agent dir (no override); default
 * mode honors a non-profile `VEYYON_CODING_AGENT_DIR` (see
 * {@link resolvePreProfileAgentDir}). Shared by the module-load resolver and
 * {@link refreshDirsFromEnv} so both apply identical logic.
 */
function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile ? undefined : resolvePreProfileAgentDir();
}

// Non-CLI entry points (SDK/library imports) never pass through the CLI's
// migrateLegacyDefaultProfileLayout() call. Reading the new layout while the
// user's data still sits in the legacy bare root would silently resolve to an
// empty tree, so surface it loudly here. Import must stay non-throwing; the
// CLI migrates (or fails closed) right after startup profile resolution.
try {
	if (activeProfile === undefined && fs.existsSync(path.join(getGlobalConfigRootDir(), "agent"))) {
		process.emitWarning(
			`Legacy veyyon layout detected at ${path.join(getGlobalConfigRootDir(), "agent")} — the default profile now lives at ` +
				`${getProfileConfigRoot(undefined)}. Run the veyyon CLI once to migrate (it moves the legacy tree, or names ` +
				`the conflict if both layouts exist).`,
			{ code: "VEYYON_LEGACY_LAYOUT" },
		);
	}
} catch {}

let dirs = new DirResolver({
	agentDirOverride: resolveActiveAgentDirOverride(),
	profile: activeProfile,
});
/**
 * Snapshot of `VEYYON_CODING_AGENT_DIR` from before the first named-profile
 * activation. Reset paths restore this value (or its absence) instead of
 * unconditionally deleting the env var. Without the snapshot, a process started
 * with `VEYYON_CODING_AGENT_DIR=/custom` then `setProfile("work")` then
 * `setProfile(undefined)` would silently lose `/custom` and fall back to
 * `~/.veyyon/agent`. Captured at module load — ignoring a profile-derived value
 * inherited from a parent's `setProfile` (see {@link resolvePreProfileAgentDir})
 * — and refreshed on `setAgentDir`, since that call is the user explicitly
 * redefining the baseline.
 */
let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir();
// Anchor home for the resolver. Captured at module load to stay stable across
// test mocks of `os.homedir()`. `getPluginsDir(home)` compares against this so
// production callers (`home === RESOLVER_HOME`) hit the XDG-aware resolver while
// tests passing a temp HOME short-circuit to a deterministic path.
const RESOLVER_HOME = os.homedir();

/**
 * Rebuild the dirs resolver from the current environment, reusing the profile
 * resolved at module load. Directory-affecting keys (XDG_*_HOME and, in default
 * mode, `VEYYON_CODING_AGENT_DIR`) loaded from a profile/agent `.env` only reach
 * `process.env` *after* this module froze the resolver at import time, so
 * `env.ts` calls this once after applying its `.env` files. The agent `.env`
 * location derives from the profile name + home before this runs, so the
 * rebuild re-reads only the directory vars, never the profile selection. The
 * `preProfileAgentDirEnv` snapshot is intentionally left untouched.
 */
export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

// =============================================================================
// Root directories
// =============================================================================

/** Get the active profile's config root (~/.veyyon/profiles/<name>). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/**
 * The process-global dir overrides: `VEYYON_CODING_AGENT_DIR`, `VEYYON_PROFILE`, and the
 * in-memory active profile. Captured together so they can be put back exactly.
 *
 * Neither {@link setAgentDir} nor {@link setProfile} is its own inverse, which is why
 * this exists rather than a "call it again with the old value" idiom:
 *
 * - `setAgentDir` always WRITES the environment variable, so it cannot express "the
 *   variable was absent", and it CLEARS the active profile, so a suite that ran under
 *   `work` hands the next file the default profile.
 * - `setProfile` always WRITES `VEYYON_PROFILE`, so restoring a profile through it
 *   leaves that variable exported even when it started out absent — which then wins for
 *   every child process the next suite spawns.
 *
 * Suites that restored either way leaked the developer's real agent dir, or an
 * unexpected profile, into every file that ran after them; `scripts/test-sandbox/find-test-leaks.ts`
 * found roughly thirty of them.
 */
export interface DirOverridesSnapshot {
	agentDirEnv: string | undefined;
	profileEnv: string | undefined;
	profile: string | undefined;
	/**
	 * The pre-profile agent-dir baseline (see the field's own docs). It is module state
	 * that `setAgentDir` OVERWRITES, and it cannot always be re-derived from the
	 * environment: a process started with `VEYYON_CODING_AGENT_DIR=/custom` whose suite
	 * then activated a profile leaves the environment pointing at the profile's dir, so a
	 * re-derivation from that environment discards `/custom` and the next
	 * `setProfile(undefined)` anywhere in the process resolves to the wrong place.
	 */
	preProfileAgentDir: string | undefined;
}

/**
 * Capture the dir overrides so {@link restoreDirOverrides} can undo a `setAgentDir` or
 * `setProfile` call completely.
 *
 * For suites outside `packages/coding-agent`. Inside it, prefer
 * `beginSettingsTest()` / `restoreSettingsTestState()`, which capture this along
 * with the Settings singleton, the keybindings singleton, the project dir and the
 * whole environment.
 */
export function captureDirOverrides(): DirOverridesSnapshot {
	return {
		agentDirEnv: process.env[AGENT_DIR_ENV_KEYS[0]],
		profileEnv: process.env.VEYYON_PROFILE,
		profile: activeProfile,
		preProfileAgentDir: preProfileAgentDirEnv,
	};
}

/**
 * Put the environment and the active profile back, then rebuild the resolver from
 * them.
 *
 * The profile is recovered with `__resetDirsFromEnvForTests`, not
 * `refreshDirsFromEnv`: the latter rebuilds paths AROUND the current in-memory
 * profile, so a profile `setAgentDir` cleared would stay cleared and every later
 * path would resolve under `profiles/default/` with the environment looking
 * correct. `refreshDirsFromEnv` is then called LAST, once every input is back, so
 * the resolver reflects the snapshot rather than the intermediate states the
 * recovery passes through.
 *
 * Every step is a pure function of `snapshot`. That is the property to preserve:
 * a restore that reads live module state can hand back a resolver the snapshot
 * never described, and the resulting failure lands in whichever suite runs next.
 * `dir-overrides-restore-is-pure.test.ts` pins it across both branches, with the
 * global `defaultProfile` set and unset, since which branch runs depends on it.
 */
export function restoreDirOverrides(snapshot: DirOverridesSnapshot): void {
	writeSnapshotEnv(snapshot);
	// The reset's `__resetProfileSnapshotForTests` re-derives the pre-profile baseline from
	// the environment written on the line above, which is why the profile switch below can
	// safely build the resolver from that baseline: by then it is the snapshot's value and
	// not whatever the test being undone left behind. Moving the env write after the reset
	// would break that and resolve every path under the undone test's directory, with the
	// environment and the module state both reading back correct.
	__resetDirsFromEnvForTests();
	// The environment does not always pin the profile: an active profile that was
	// selected in-process (no `VEYYON_PROFILE`) is only in module state, so it is
	// re-applied explicitly rather than inferred.
	if (activeProfile !== snapshot.profile) setProfile(snapshot.profile);
	// `setProfile` EXPORTS the profile's agent dir (so child processes inherit it), which
	// is right in production and wrong here: it would leave a variable behind that the
	// snapshot says was absent. The profile outranks the variable anyway, so re-pinning
	// the environment after the switch restores the variables without moving any path.
	writeSnapshotEnv(snapshot);
	// Re-assigned because `setProfile`'s first activation overwrites the baseline from the
	// live environment.
	preProfileAgentDirEnv = snapshot.preProfileAgentDir;
	// LAST, and deliberately unconditional: which of the steps above last touched `dirs`
	// depends on whether the profile switch ran, and that depends on the machine's global
	// `defaultProfile`. One rebuild from the now fully-restored inputs makes the resolver
	// match the snapshot by construction instead of by every branch happening to leave it
	// right, which is the difference between a bug here and a bug in whichever suite runs
	// next.
	refreshDirsFromEnv();
}

/** Test-only: read the pre-profile agent-dir baseline, so a leak tracer can watch it. */
export function __preProfileAgentDirForTests(): string | undefined {
	return preProfileAgentDirEnv;
}

function writeSnapshotEnv(snapshot: DirOverridesSnapshot): void {
	if (snapshot.agentDirEnv === undefined) delete process.env[AGENT_DIR_ENV_KEYS[0]];
	else process.env[AGENT_DIR_ENV_KEYS[0]] = snapshot.agentDirEnv;
	if (snapshot.profileEnv === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = snapshot.profileEnv;
}

/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir: string): void {
	activeProfile = undefined;
	dirs = new DirResolver({ agentDirOverride: dir });
	writeAgentDirEnv(dir);
	preProfileAgentDirEnv = dir;
	for (const key of PROFILE_ENV_KEYS) {
		delete process.env[key];
	}
}

/**
 * Test-only: reset the pre-profile `VEYYON_CODING_AGENT_DIR` snapshot to whatever
 * the current environment looks like. Cross-suite test pollution can otherwise
 * leak a stale snapshot through `setAgentDir` and corrupt `setProfile(undefined)`
 * restore semantics. Production code MUST NOT call this — the snapshot's
 * lifecycle is owned by `setAgentDir` / `setProfile` and a runtime caller has
 * no business clearing it.
 */
export function __resetProfileSnapshotForTests(): void {
	preProfileAgentDirEnv = resolvePreProfileAgentDir();
}

/**
 * Test-only: rebuild profile + directory state from the current process env.
 * Production code keeps the module-load profile stable; tests that mutate
 * `setAgentDir`/`setProfile` need an exact restore point after they put env vars
 * back.
 */
export function __resetDirsFromEnvForTests(): void {
	activeProfile = resolveStartupProfileSafe();
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
}

/** Activate a named profile. Passing undefined or "default" returns to the default profile. */
export function setProfile(profile: string | undefined): void {
	const next = normalizeProfileName(profile);
	if (next && !activeProfile) {
		// First activation of a named profile in this process: snapshot the
		// current VEYYON_CODING_AGENT_DIR so a later reset can restore the user's
		// explicit override. Subsequent profile switches keep the original
		// snapshot — the "pre-profile" baseline is the state before profiles
		// entered the picture, not the state between two activations.
		preProfileAgentDirEnv = resolvePreProfileAgentDir();
	}
	activeProfile = next;
	if (activeProfile) {
		dirs = new DirResolver({ profile: activeProfile });
		process.env.VEYYON_PROFILE = activeProfile;
		writeAgentDirEnv(dirs.agentDir);
	} else {
		for (const key of PROFILE_ENV_KEYS) {
			delete process.env[key];
		}
		writeAgentDirEnv(preProfileAgentDirEnv);
		dirs = new DirResolver({ agentDirOverride: preProfileAgentDirEnv });
	}
}

/** Get the active named profile. Undefined means the default profile. */
export function getActiveProfile(): string | undefined {
	return activeProfile;
}

/**
 * The active profile's directory name, resolving the undefined (default) case to
 * {@link DEFAULT_PROFILE_DIR_NAME}. One owner for the "active profile, or default"
 * idiom so the fallback can never drift between path builders.
 */
export function getActiveProfileOrDefault(): string {
	return getActiveProfile() ?? DEFAULT_PROFILE_DIR_NAME;
}

/** Resolve the config root that backs a profile without activating it. */
export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}

/**
 * Fail-closed guard for recursive profile-directory removal. A profile
 * lifecycle operation may delete ONLY a direct child of the current profiles
 * root — `<configRoot>/profiles/<child>` — whether that child is a named
 * profile (`profiles/work`) or a staging sibling (`profiles/.work.<pid>.tmp`).
 *
 * It throws for anything else: the profiles root itself, the config root
 * (`~/.veyyon`), the home directory, or any ancestor of them, and any path
 * outside the profiles tree. This is defense in depth against the class of bug
 * that deleted a user's entire `~/.veyyon/profiles` during a bench run
 * (BACKLOG FINDING-HOST-PROFILE-DIR-DELETED-DURING-BENCH): a mis-computed target
 * (empty profile name, a bad join, a harness pointing at the wrong root) is
 * refused rather than silently wiping the whole profiles tree.
 *
 * It does not special-case "sandbox mode": a named profile dir is removable
 * under whatever config root is active (the real HOME or a VEYYON_CONFIG_DIR
 * override), and the roots themselves are never removable through a profile
 * operation under either. A sandbox teardown that legitimately wants to erase
 * everything removes its own temp root directly, not through this guard.
 *
 * Call this immediately before handing any path to a recursive remove in the
 * profile lifecycle. Returns the resolved absolute path so callers can remove
 * exactly what was validated (no TOCTOU gap between check and use).
 */
export function assertRemovableProfileDir(target: string): string {
	const resolved = path.resolve(target);
	const profilesRoot = path.resolve(path.join(getGlobalConfigRootDir(), PROFILES_DIR_NAME));
	const parent = path.dirname(resolved);
	const base = path.basename(resolved);
	if (parent !== profilesRoot || base === "" || base === "." || base === "..") {
		throw new Error(
			`Refusing to recursively remove ${resolved}: a profile operation may only delete a direct child of ${profilesRoot} ` +
				`(a named profile or its staging sibling), never the profiles root, the config root, the home directory, or a path outside the profiles tree. ` +
				`This is a fail-closed guard against wiping the whole profiles tree.`,
		);
	}
	return resolved;
}

/** Resolved profile entry for lifecycle listing (`default` is the implicit home profile). */
export interface ProfileInfo {
	name: string;
	rootDir: string;
	agentDir: string;
}

/** Enumerate the default profile plus every named profile under `profiles/`. */
export function listProfiles(): ProfileInfo[] {
	const defaultRoot = getProfileConfigRoot(undefined);
	const profiles: ProfileInfo[] = [
		{
			name: DEFAULT_PROFILE_DIR_NAME,
			rootDir: defaultRoot,
			agentDir: path.join(defaultRoot, "agent"),
		},
	];

	const profilesDir = path.join(getGlobalConfigRootDir(), PROFILES_DIR_NAME);
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(profilesDir, { withFileTypes: true });
	} catch {
		return profiles;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			// `default` normalizes to undefined — already covered by the fixed
			// first entry above, so skip its directory to avoid a duplicate row.
			if (normalizeProfileName(entry.name) === undefined) continue;
		} catch {
			continue;
		}
		const rootDir = path.join(profilesDir, entry.name);
		profiles.push({
			name: entry.name,
			rootDir,
			agentDir: path.join(rootDir, "agent"),
		});
	}

	profiles.sort((left, right) => left.name.localeCompare(right.name));
	return profiles;
}

/**
 * Existing legacy per-profile `shared-auth` directories, one per profile that
 * has one on disk.
 *
 * Early builds resolved {@link getSharedAuthDir} under each profile's own root
 * (`profiles/<name>/shared-auth`). When the shared store moved to the machine-
 * global `~/.veyyon/shared-auth` (so every profile reads one set of logins),
 * credentials already written to those per-profile locations were left behind:
 * the global store starts empty and the first-run promotion only looked at the
 * per-profile *agent* dir, not this old shared-auth dir. Returning these lets
 * the shared-store seed find and promote orphaned logins so a user who updates
 * across that move is not silently logged out. Only directories that exist are
 * returned; the caller decides which to promote.
 */
export function getLegacyPerProfileSharedAuthDirs(): string[] {
	const dirsOut: string[] = [];
	for (const profile of listProfiles()) {
		const dir = path.join(profile.rootDir, "shared-auth");
		if (fs.existsSync(dir)) dirsOut.push(dir);
	}
	return dirsOut;
}

/** Whether a profile root exists on disk (`default` checks `~/.veyyon/profiles/default/agent`). */
export function profileExists(profile: string | undefined): boolean {
	const normalized = normalizeProfileName(profile);
	if (!normalized) {
		return fs.existsSync(path.join(getProfileConfigRoot(undefined), "agent"));
	}
	return fs.existsSync(getProfileConfigRoot(normalized));
}

// =============================================================================
// Legacy bare-root layout migration
// =============================================================================

/**
 * Root entries that stay GLOBAL (cross-profile) under the new layout. Every
 * other entry in the config root belongs to the legacy default profile and is
 * moved into `profiles/default/` by {@link migrateLegacyDefaultProfileLayout}.
 *
 * The literals name state this module does not own but the config root holds:
 * `shared-auth/` ({@link getSharedAuthDir}), the cross-profile `AGENTS.md` the
 * native guidance provider reads, and the global vault pair the secrets runtime
 * addresses through {@link getGlobalConfigRootDir}. Moving one of them into a
 * single profile takes it away from every other profile, and the vault key
 * takes every sealed credential with it, so the move never sees them.
 *
 * {@link SUBAGENTS_DIR_NAME} is here for the same reason and is the one entry
 * whose omission would be silent: a moved `subagents/` still resolves for the
 * default profile, so the definitions would keep working for whoever ran the
 * migration and vanish for every other profile.
 */
const GLOBAL_ROOT_ENTRIES: Record<string, true> = {
	[PROFILES_DIR_NAME]: true,
	[SUBAGENTS_DIR_NAME]: true,
	[INSTALL_ID_FILE]: true,
	"shared-auth": true,
	"AGENTS.md": true,
	"vault.json": true,
	"vault.key": true,
	...Object.fromEntries(MAIN_CONFIG_FILENAMES.map(name => [name, true])),
};

export interface LegacyLayoutMigrationResult {
	migrated: boolean;
	/** Entries moved into `profiles/default/` (empty when nothing to migrate). */
	movedEntries: string[];
	targetDir: string;
}

/**
 * Marker written inside `profiles/default/` while a legacy-layout migration is
 * moving entries, removed once every entry has landed. Its presence is how a
 * resumed migration tells an INTERRUPTED move (finish it) apart from a genuine
 * both-layouts conflict (fail closed).
 */
const LEGACY_MIGRATION_MARKER = ".migration-in-progress";

/**
 * One-time move of the legacy bare-root default profile
 * (`~/.veyyon/agent`, `~/.veyyon/logs`, …) into `~/.veyyon/profiles/default/`.
 *
 * - Nothing to do when no legacy `agent/` dir exists and no migration is in
 *   progress (fresh install, or already migrated).
 * - RESUMES an interrupted migration: if a prior run moved some entries and was
 *   killed mid-loop, a marker file inside `profiles/default/` survives, so the
 *   next run finishes moving the remaining root entries instead of leaving them
 *   silently orphaned outside the profile. The move is a set of independent
 *   same-filesystem renames, so replaying it is safe — an already-moved entry
 *   is simply no longer at the root.
 * - FAILS CLOSED when a FINISHED `profiles/default/` (no marker) and the legacy
 *   `agent/` dir both exist: two candidate default profiles is a state we must
 *   never guess about, so the error names both directories and how to reconcile.
 * - Reports what moved so the caller can print one loud notice.
 *
 * Must run before anything reads or writes profile paths (the CLI calls it
 * right after startup profile resolution, before `.env` loading).
 */
export function migrateLegacyDefaultProfileLayout(): LegacyLayoutMigrationResult {
	const root = getGlobalConfigRootDir();
	const legacyAgentDir = path.join(root, "agent");
	const targetDir = path.join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
	const markerPath = path.join(targetDir, LEGACY_MIGRATION_MARKER);
	const resuming = fs.existsSync(markerPath);

	if (!fs.existsSync(legacyAgentDir) && !resuming) {
		// No legacy layout to move and no half-done migration to finish.
		return { migrated: false, movedEntries: [], targetDir };
	}
	if (fs.existsSync(targetDir) && !resuming) {
		// An EMPTY `agent/` is not a second candidate profile. It holds no data to
		// merge, so the refusal below would hand the operator an instruction ("move
		// the contents") with no contents, and no choice that resolves it — a
		// directory recreated after a migration, or left behind by one, would stop
		// every launch until they deleted it by hand. Drop it and carry on.
		if (fs.readdirSync(legacyAgentDir).length === 0) {
			fs.rmSync(legacyAgentDir, { recursive: true, force: true });
			return { migrated: false, movedEntries: [], targetDir };
		}
		// A completed new-layout dir (no marker) next to a legacy one WITH data:
		// genuine conflict, never a mid-migration state. Refuse rather than guess.
		throw new Error(
			`Both the legacy default-profile layout (${legacyAgentDir}) and the new one (${targetDir}) exist. ` +
				`Veyyon cannot guess which is current. Merge or remove one — typically: move the contents of ` +
				`${legacyAgentDir} (and sibling state dirs like logs/, plugins/, cache/) into ${targetDir}, ` +
				`then delete the legacy copies — and relaunch.`,
		);
	}
	// Claim the migration by planting the marker BEFORE any move, so an
	// interruption at any point leaves a resumable state, never a silent orphan.
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(markerPath, "");
	const movedEntries: string[] = [];
	for (const entry of fs.readdirSync(root)) {
		if (GLOBAL_ROOT_ENTRIES[entry]) continue;
		fs.renameSync(path.join(root, entry), path.join(targetDir, entry));
		movedEntries.push(entry);
	}
	// All entries landed — drop the marker so the migration reads as complete.
	fs.rmSync(markerPath, { force: true });
	movedEntries.sort((a, b) => a.localeCompare(b));
	return { migrated: true, movedEntries, targetDir };
}
/** Get the active profile's agent config directory (~/.veyyon/profiles/<name>/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.veyyon). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Profile-root subdirectories (~/.veyyon/profiles/<name>/*)
// =============================================================================

/** Get the reports directory (~/.veyyon/profiles/<name>/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.veyyon/profiles/<name>/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.veyyon/profiles/<name>/logs/veyyon.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), logFileName(date));
}

/**
 * Get the plugins directory for the active profile
 * (`~/.veyyon/profiles/<name>/plugins`, or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter is for test
 * isolation: when it differs from `os.homedir()` it short-circuits the resolver
 * and returns `<home>/<configDir>/profiles/<profile>/plugins`. Passing
 * `os.homedir()` explicitly is identical to the no-arg form — XDG semantics are
 * preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where plugin packages are installed (profile plugins dir / node_modules). */
export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

/** Plugin package.json under the profile plugins dir. */
export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

/** Plugin lock file under the profile plugins dir. */
export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), "veyyon-plugins.lock.json");
}

/** Get the remote mount directory (~/.veyyon/profiles/<name>/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/**
 * Expand a leading `~` and require an absolute result. Returns `undefined` for
 * empty/whitespace input or a path that is still relative after expansion.
 *
 * A worktree base is process-global and consumed by both creation
 * (PR checkout, task isolation) and cleanup (`veyyon worktree`). A relative value
 * would resolve against whatever cwd happened to launch `veyyon`, so checkout and
 * cleanup could disagree — we refuse it rather than silently bind it to cwd.
 */
function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let p = trimmed;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = os.homedir() + p.slice(1);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

let worktreesDirOverride: string | undefined;

/**
 * Relocate the base directory for agent-managed worktrees (PR checkouts, task
 * isolation, and `veyyon worktree` cleanup all read the same base). Driven by the
 * `worktree.base` setting in coding-agent; pass `undefined`/empty to clear and
 * fall back to `VEYYON_WORKTREE_DIR` or the profile `wt/` default.
 *
 * `~` is expanded and a relative path is rejected (see {@link resolveWorktreeBase}).
 * Returns the absolute path that took effect, or `undefined` if the input was
 * cleared or rejected — callers can warn on a non-empty input that returns
 * `undefined`.
 */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/**
 * Get the agent-managed worktrees directory. Resolution order: the
 * `VEYYON_WORKTREE_DIR` env var, then the {@link setWorktreesDir} override (the
 * `worktree.base` setting), then the profile `wt/` default. The env var and the
 * override are both `~`-expanded and must be absolute; a relative value is
 * ignored and resolution falls through.
 */
export function getWorktreesDir(): string {
	return (
		resolveWorktreeBase(pickProcessEnv("VEYYON_WORKTREE_DIR")) ??
		worktreesDirOverride ??
		dirs.rootSubdir("wt", "data")
	);
}

/** Get the SSH control socket directory (~/.veyyon/profiles/<name>/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (profile `remote-host/`). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.veyyon/profiles/<name>/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (profile `agent/python-gateway`; XDG default: $XDG_STATE_HOME/veyyon/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (profile `puppeteer/`). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get the persistent browser profiles directory (profile `agent/browser-profiles`; XDG default: $XDG_DATA_HOME/veyyon/browser-profiles). */
export function getBrowserProfilesDir(): string {
	return dirs.agentSubdir(undefined, "browser-profiles", "data");
}

/** Get the docs.rs web cache directory (profile `webcache/`). */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/** Get the AutoQA database directory (profile `autoqa.db`). */
export function getAutoQaDbDir(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}
/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under profile `wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (profile `wt/<segment>`). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (profile `gpu_cache.json`). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the launch facts path (profile `cache/launch-facts.json`).
 *
 * Holds what the last launch of a project knew about it at rest — the model's
 * display name, whether the working tree was dirty, and what the context gauge
 * read — so the launch card can state those instead of placeholders in the half
 * second before the session finishes booting.
 */
export function getLaunchFactsCachePath(): string {
	return dirs.rootSubdir(path.join("cache", "launch-facts.json"), "cache");
}

/**
 * Get the tool wire-schema cache path (profile `cache/tool-wire-schemas.json`).
 *
 * Holds the JSON Schema of each built-in tool's parameters as a compiled build produced it, keyed by
 * that build's id, so a later launch of the same build sends its first request without evaluating
 * arktype.
 */
export function getToolWireSchemaCachePath(): string {
	return dirs.rootSubdir(path.join("cache", "tool-wire-schemas.json"), "cache");
}

/** A profile `cache/<file>` path, or the value of `envVar` when it is set so a test or operator can relocate it. */
function cacheFilePath(envVar: string, file: string): string {
	return pickProcessEnv(envVar) || dirs.rootSubdir(path.join("cache", file), "cache");
}

/** Get the GitHub view cache database path (profile `cache/github-cache.db`, `VEYYON_GITHUB_CACHE_DB` overrides). */
export function getGithubCacheDbPath(): string {
	return cacheFilePath("VEYYON_GITHUB_CACHE_DB", "github-cache.db");
}

/**
 * Get the encrypted auth-broker snapshot cache path (profile `cache/auth-broker-snapshot.enc`,
 * `VEYYON_AUTH_BROKER_SNAPSHOT_CACHE` overrides).
 */
export function getAuthBrokerSnapshotCachePath(): string {
	return cacheFilePath("VEYYON_AUTH_BROKER_SNAPSHOT_CACHE", "auth-broker-snapshot.enc");
}

/** Get the local FastEmbed model cache directory (profile `cache/fastembed`). */
export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

/** Get the on-demand fastembed runtime install root (profile `cache/fastembed-runtime`). */
export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

/** Get the natives directory (profile `natives/`). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/**
 * Get the argot shorthand cache directory (profile `cache/argot`). Each project
 * keeps its generated `AGENTS.dict` in a per-id subdirectory here; the cache is
 * a local decode aid that never enters the repository, so it lives under the
 * config root, not the working tree.
 */
export function getArgotCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "argot"), "cache");
}

/**
 * Get the directory an eval kernel caches its runner script in (profile `cache/<language>-runner`).
 * `language` is the lowercase interpreter name (`python`, `ruby`, `julia`). The directory is under the
 * user's own config or cache root: another account on the host can create or replace a file in the
 * shared temp directory, and the kernel runs the script at this path.
 */
export function getKernelRunnerDir(language: string): string {
	return dirs.rootSubdir(path.join("cache", `${language}-runner`), "cache");
}

/** Get the stats database path (profile `stats.db`). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (profile `autoresearch/`). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (profile `autoresearch/<encoded-project>`). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (profile `autoresearch/<encoded-project>.db`). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

// =============================================================================
// Agent subdirectories (~/.veyyon/profiles/<name>/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/**
 * The credential-store agent directory when profile-sharing redirects it to the
 * machine-wide shared store, or `undefined` when each profile keeps its own
 * store (sharing off).
 *
 * This is the ONE owner of the "sharing on → shared store" decision. Both the
 * store opener (`discoverAuthStorage`, which passes this as `storeAgentDir`) and
 * every "where do my logins live" message ({@link getActiveAuthDbPath}) resolve
 * through it, so they can never point at different files. Before this existed,
 * the store opened the shared `~/.veyyon/shared-auth/agent.db` while the login
 * messages printed the per-profile `agent.db` computed straight from
 * `getAgentDbPath()` — a sibling that is empty under sharing — so a user with
 * working, shared credentials was told they lived in an empty file and it read
 * as corruption.
 */
export function getSharedAuthStoreDirIfEnabled(): string | undefined {
	return readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
}

/**
 * The `agent.db` that actually holds credentials for the current profile right
 * now: the machine-wide shared store when profile-sharing is on (the default),
 * otherwise this profile's own store. Use this for any user-facing "credentials
 * saved to …" message so it always names the exact file the store opens, never a
 * sibling that may be empty.
 */
export function getActiveAuthDbPath(agentDir?: string): string {
	return getAgentDbPath(getSharedAuthStoreDirIfEnabled() ?? agentDir ?? getAgentDir());
}

/** Get the last-seen-changelog-version marker file (agent `last-changelog-version`). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/**
 * Get the automatic-update state file (agent `auto-update-state.json`).
 *
 * Holds the record of the last failed background update so a launch that cannot
 * install does not retry and re-report the same failure every time you start.
 * It doubles as the lock target that keeps concurrent launches from installing
 * at once.
 */
export function getAutoUpdateStatePath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "auto-update-state.json", "state");
}

/**
 * Get the version-move history file (agent `update-history.json`).
 *
 * Records each deliberate move between versions (from, to, when) so the rollback
 * picker can annotate a row with "you were here before" and so a support
 * question about "it worked last week" has an answer on disk.
 *
 * It is ANNOTATION ONLY and is never the source of the version list: that comes
 * from the release source every time. A history file is trivially incomplete —
 * it knows nothing about installs that happened through the shell installer, a
 * package manager, or another machine — so treating it as the catalog would
 * quietly hide most versions from the picker.
 */
export function getUpdateHistoryPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "update-history.json", "state");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny title model cache directory (agent `cache/tiny-models`). */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory (agent `cache/document-conversions`; XDG default: $XDG_CACHE_HOME/veyyon/cache/document-conversions). */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

/** Get the sessions directory (agent `sessions/`). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/**
 * The sessions directory of the named profile (`undefined` or `"default"` for the default one),
 * resolved as a process running that profile resolves {@link getSessionsDir}: under the profile's
 * `$XDG_DATA_HOME` directory once it exists, else `<agentDir>/sessions`.
 */
export function getProfileSessionsDir(profile: string | undefined): string {
	return new DirResolver({ profile }).agentSubdir(undefined, "sessions", "data");
}

/** Get the content-addressed blob store directory (agent `blobs/`). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (agent `themes/`). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (agent `tools/`). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the prompts directory (agent `prompts/`). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the memories directory (agent `memories/`). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (agent `terminal-sessions/`). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the debug log path (agent `veyyon-debug.log`). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.veyyon/*)
// =============================================================================

/** Get the project-level prompts directory (.veyyon/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.veyyon/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/**
 * Get the primary MCP config file path (first candidate).
 *
 * `agentDir` names WHICH profile owns the user-scope file. It defaults to the
 * process-active profile, so every existing caller is unchanged; a caller
 * loading on behalf of another profile passes that profile's agent dir so the
 * server list and the disable/force-enable lists come out of the same file.
 */
export function getMCPConfigPath(
	scope: "user" | "project",
	cwd: string = getProjectDir(),
	agentDir: string = getAgentDir(),
): string {
	if (scope === "user") {
		return path.join(agentDir, "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/**
 * Path to the SSH host config for one profile.
 *
 * There is no project scope. A repository is untrusted input, so a checked-in
 * `ssh.json` must never name a machine the ssh tool will connect to, and a
 * writer that offered a project scope would be writing a file nothing reads.
 *
 * `agentDir` names WHICH profile, defaulting to the process-active one. It used
 * to be absent, so this always resolved the booted profile and a caller loading
 * for another profile silently got the wrong host list.
 */
export function getSSHConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "ssh.json");
}

// =============================================================================
// Install identity
// =============================================================================

let cachedInstallId: string | null = null;

/**
 * Persistent per-install UUID stored at `~/.veyyon/install-id`.
 *
 * Generated lazily on first call and persisted with `O_CREAT|O_EXCL` so
 * concurrent first-call races don't clobber each other (loser re-reads the
 * winner's id). Survives independently of agent state: deleting
 * `~/.veyyon/agent/` does not regenerate it. Server-side dedup for grievance
 * pushes (and similar telemetry) keys on this id.
 *
 * Anchored to the base config root (`~/.veyyon/install-id`) regardless of the
 * active profile: install identity is per-install, not per-profile, so every
 * profile shares one id and the global cache stays correct no matter the
 * profile / `getInstallId` call order.
 */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getGlobalConfigRootDir(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (isUuid(existing)) {
			cachedInstallId = existing;
			return existing;
		}
		// File present and not an id — fall through and overwrite below. This is set for an
		// EMPTY file too, which is what a crash between the create and the write leaves
		// behind. It used to be `existing.length > 0`, so a zero-length file was never
		// unlinked, the `O_EXCL` create below then failed with EEXIST forever, and the
		// install generated a brand new id on every single launch with nothing to fix.
		observedInvalid = true;
		if (existing.length > 0) {
			// Replacing this file changes the install's identity, which is what server-side
			// dedup keys on: the same machine starts counting as a new one. Doing that in
			// silence leaves nobody able to explain the discontinuity later.
			process.emitWarning(
				`${filePath} does not contain a UUID (${existing.length} bytes), so it is being replaced with a new ` +
					`install id. Anything that identified this install by the old value will see it as a new install.`,
				{ code: "VEYYON_INSTALL_ID_INVALID" },
			);
		}
	} catch (err) {
		// A missing file is the first run and says nothing. Anything else means the id IS
		// on disk and unreadable, so a fresh one is generated below and the write almost
		// certainly fails the same way, leaving a per-process identity (see `persistInstallId`).
		// Announce the cause here while the errno is still in hand.
		if (!isMissingPath(err)) {
			process.emitWarning(
				`${filePath} exists but could not be read (${errorMessage(err)}), so this install's identity could not be ` +
					`recovered. A new id is being used; fix the file's permissions to keep one stable identity.`,
				{ code: "VEYYON_INSTALL_ID_UNREADABLE" },
			);
		}
	}

	cachedInstallId = persistInstallId(filePath, observedInvalid);
	return cachedInstallId;
}

/**
 * Create the install id file with `O_EXCL` and return the id this process uses: the one it wrote,
 * the one a concurrent first run wrote, or, after a warning, one that was not persisted.
 */
function persistInstallId(filePath: string, replaceInvalid: boolean): string {
	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
		if (replaceInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {
				// Losing this race is fine and expected: another process replaced the same
				// garbage, and the O_EXCL open below then fails with EEXIST and re-reads its
				// id. The unlink failing for any other reason surfaces as the persist warning
				// at the end of this function, which is where it matters.
			}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Lost the create race — re-read whatever the winner wrote.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (isUuid(existing)) return existing;
			} catch {
				// The winner's file cannot be read back. Falls through to the warning below,
				// which is the right report: this process ends up with an id of its own.
			}
		}
		// Keep the generated id in-memory so the rest of this process has a stable value.
		// It is stable for THIS process only: nothing was persisted, so the next launch
		// generates another one, and every run of veyyon on this machine looks like a
		// different install. Server-side dedup keyed on the id then never dedups anything.
		// That is a permanent, invisible degradation, so it is announced (Law 10).
		process.emitWarning(
			`Could not persist an install id to ${filePath} (${errorMessage(err)}). This run is using a temporary id, and ` +
				`every future run will generate another one until the path is writable.`,
			{ code: "VEYYON_INSTALL_ID_NOT_PERSISTED" },
		);
	}

	return next;
}

/** Test-only: clear cached install id. Never call from production code. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
