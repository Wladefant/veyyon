/**
 * Where veyyon's global config home is, and the names joined under it.
 *
 * The config home (`~/.veyyon`, or the directory `VEYYON_CONFIG_DIR` names) holds the global `config.yml`,
 * `install-id`, the cross-profile stores and `profiles/<name>/` for every profile. This module resolves it
 * and validates the names joined onto it. `./dirs` builds every per-profile path on top of it, and
 * `./global-config` reads the file at its root.
 */

import * as os from "node:os";
import * as path from "node:path";
// FIRST, for its side effect: `VEYYON_CONFIG_DIR` may be set in `$HOME/.env`, and it decides the root
// resolved here, so the file is applied before a caller of this module can resolve anything.
import "./dotenv-home";
import { CONFIG_DIR_ENV_KEYS, pickProcessEnv, SANDBOX_MARKER_ENV_KEY } from "./dir-env-keys";

/** Config directory name (e.g. ".veyyon") */
export const CONFIG_DIR_NAME: string = ".veyyon";

/** The default profile's directory name under `profiles/`. */
export const DEFAULT_PROFILE_DIR_NAME = "default";

/**
 * The single directory under the config root that holds all profiles
 * (`<configRoot>/profiles/<name>`). One owner for the segment name so a rename
 * or layout change touches exactly one place; every profile-path builder joins
 * this rather than repeating the literal.
 */
export const PROFILES_DIR_NAME = "profiles";

/**
 * Basename of the cross-profile directory holding user-authored agent
 * definitions ({@link getGlobalSubagentsDir}).
 *
 * `subagents`, not `agents`: the config root already holds `profiles/`, whose
 * every entry carries an `agent/` dir, so an `agent/agents/` path named two
 * unrelated things one segment apart. `<extension>/agents/` keeps its own name
 * — that is the published plugin-authoring convention, not this directory.
 */
export const SUBAGENTS_DIR_NAME = "subagents";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Names Windows treats as reserved device aliases. Matches the basename
 * itself as well as any `BASENAME.<anything>` form, because Windows reserves
 * `CON.foo`/`PRN.txt`/etc. too — using them as a profile name would let
 * `setProfile` accept the input only for directory creation to fail later
 * with a confusing `ENOENT`/`EINVAL`. Case-insensitive: NTFS treats `CON`
 * and `con` identically.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name. Returns `undefined` for the implicit
 * default (empty string, whitespace, or the explicit "default" sentinel) and
 * throws for syntactically invalid or platform-reserved names.
 *
 * Exported so consumers of `@veyyon/utils/config-root` (CLI bootstrap, tests,
 * downstream tools) can validate user input without re-deriving the rules.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}

/**
 * The user's home directory, refused rather than guessed when it is unusable.
 *
 * Every path veyyon owns hangs off this one value, so a bad answer here is not a bad path, it is
 * every path. Two answers are bad without announcing themselves:
 *
 *  - Empty (`HOME=` with no usable passwd entry, common in a stripped container or an `env -i`
 *    invocation). `path.join("", ".veyyon")` is `.veyyon`, a relative path, so config, sessions and
 *    credentials are created in whatever directory the process started in, and a second run from a
 *    different directory sees a different, empty veyyon.
 *  - The filesystem root (`HOME=/`). Every write lands in `/.veyyon`, outside the user's control
 *    and usually not writable; where it is writable, it litters the root of the filesystem.
 *
 * Both are configuration faults with a one-line fix, so this throws and states the fix rather than
 * proceeding somewhere arbitrary. Exported so the refusal can be tested directly: `os.homedir()` is
 * resolved once per process, so a test cannot reach the empty case by assigning `HOME`.
 */
export function resolveHomeDirOrThrow(): string {
	const home = os.homedir();
	if (!home || !path.isAbsolute(home)) {
		throw new Error(
			`Cannot determine your home directory: HOME is unset or empty (os.homedir() returned ${JSON.stringify(home)}). ` +
				`Every veyyon path is resolved from it, and without it settings and credentials would be written to a ` +
				`relative path that changes with the working directory. Set HOME to an absolute path, or set ` +
				`VEYYON_CONFIG_DIR to place the config root explicitly.`,
		);
	}
	if (path.parse(home).root === home) {
		throw new Error(
			`HOME is set to the filesystem root (${home}), so veyyon would create ${path.join(home, CONFIG_DIR_NAME)} ` +
				`at the top of the filesystem. Set HOME to a real home directory, or set VEYYON_CONFIG_DIR to an ` +
				`absolute path that places the config root explicitly.`,
		);
	}
	return home;
}

/**
 * A `VEYYON_CONFIG_DIR` value written as an absolute path, on either platform.
 *
 * `path.isAbsolute` only knows the platform it runs on, and a value written for the
 * other one means the same thing: `C:\veyyon` on Linux is not "absolute" to `path`, so
 * resolving it against the home would produce a directory whose NAME contains a
 * backslash. Both forms are recognised so the value is read as the path its author
 * meant wherever it was written.
 */
function looksAbsolute(value: string): boolean {
	return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** True when `candidate` is `root` or sits underneath it. */
function isUnderPath(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * The config root named by `VEYYON_CONFIG_DIR`, or `undefined` when it is unset.
 *
 * The value is a path, not a name: absolute is taken as written, relative is resolved against the
 * home. It is then checked against the one thing it must never be, somewhere inside the operator's
 * home. A joined name instead makes `~/.veyyon-<anything>` reachable from one environment variable,
 * and a suite setting one in the belief that it has isolated itself writes into the real home,
 * because assigning `process.env.HOME` does not move `os.homedir()` under Bun, which resolves it
 * once at process start.
 *
 * The default root `~/.veyyon` is unaffected: that is what an unset variable gives, and this
 * function is not consulted for it.
 *
 * Inside the test sandbox the home is a tmpfs the guest owns, with the operator's real home absent
 * from the filesystem view, so {@link SANDBOX_MARKER_ENV_KEY} lifts the refusal. It is trusted in
 * this one direction only; the strong half of the pair is the reachability proof in
 * `packages/utils/test/helpers/sandbox-gate.ts`, which refuses to let the process start when a real
 * home is in reach.
 *
 * `packages/utils/test/sandbox-gate-contracts.test.ts` fails when this regresses to a joined name.
 */
export function getConfigRootOverride(): string | undefined {
	const override = pickProcessEnv(...CONFIG_DIR_ENV_KEYS);
	if (override === undefined || override === "") return undefined;
	const key = CONFIG_DIR_ENV_KEYS[0];
	if (override.trim() === "") {
		throw new Error(
			`${key} is set to whitespace (${JSON.stringify(override)}). It names the directory veyyon keeps its ` +
				`configuration in, so this would create a directory whose name you cannot see. Set it to an absolute ` +
				`path such as "/srv/veyyon", or unset it to use the default (${path.join("~", CONFIG_DIR_NAME)}).`,
		);
	}
	// A value written for the OTHER platform is still refused, and this is the one refusal
	// that survived the inversion above. `C:\veyyon` is not absolute to POSIX `path`, so it
	// would be resolved as a relative name and create a directory whose name contains a
	// backslash -- a thing no listing shows sensibly and no user asked for. There is no
	// reading of it that is worth guessing at.
	if (!path.isAbsolute(override) && looksAbsolute(override)) {
		throw new Error(
			`${key} is set to "${override}", which is written as an absolute path for another platform and cannot ` +
				`be one here, so it would be resolved as a relative name and create a directory whose name contains ` +
				`a path separator. Set it to an absolute path in this platform's form, such as "/srv/veyyon".`,
		);
	}
	const home = resolveHomeDirOrThrow();
	// One `resolve`, because it already does both jobs: an absolute `override` replaces
	// `home` outright, and a relative one is resolved against it.
	const resolved = path.resolve(home, override);
	if (isUnderPath(resolved, home) && !process.env[SANDBOX_MARKER_ENV_KEY]) {
		throw new Error(
			`${key} resolves to "${resolved}", which is inside your home directory ("${home}").\n` +
				`It is a PATH to the config root, not a name hung off your home, and a value that lands back in your ` +
				`home is how 136 stray ${CONFIG_DIR_NAME}* directories were created in one: a bare name such as ` +
				`"${CONFIG_DIR_NAME}-mysuite" reads like isolation and is a directory in the real home.\n` +
				`Set it to an absolute path OUTSIDE your home (for example "/srv/veyyon", or a temp directory), or ` +
				`unset it to use the default (${path.join(home, CONFIG_DIR_NAME)}).`,
		);
	}
	return resolved;
}

/**
 * The GLOBAL config home (~/.veyyon): the cross-profile root holding the global `config.yml`,
 * `install-id`, and `profiles/`. Distinct from `getConfigRootDir` in `./dirs`, which is the active
 * profile's own root.
 *
 * `CONFIG_DIR_NAME` rather than `getConfigDirName()` on the default branch, deliberately:
 * the name is only ever a name in the default case, and asking the override for its
 * basename here would let a `/srv/veyyon-work` override answer `~/veyyon-work`, which is
 * the doubled-path defect the override exists to remove.
 */
export function getGlobalConfigRootDir(): string {
	return getConfigRootOverride() ?? path.join(resolveHomeDirOrThrow(), CONFIG_DIR_NAME);
}

/**
 * The config root expressed RELATIVE TO THE HOME, for the callers that hold a home and
 * join a name onto it -- `getConfigAgentDirName` in `./dirs`, and through it
 * `USER_CONFIG_BASES` in `packages/coding-agent/src/config.ts`.
 *
 * `path.relative`, not `path.basename`, and the difference is a wrong answer rather than
 * an ugly one. Every caller does `path.join(home, thisValue)`, so the value has to be the
 * one that reconstructs the root: a basename turns an override of `../shared` into
 * `~/shared` and `/srv/veyyon-work` into `~/veyyon-work`, which is the doubled-path defect
 * the override exists to remove, reintroduced one layer up. The `..`-relative form is not
 * pretty, but `path.join(home, "../../srv/veyyon")` is `/srv/veyyon`, which is the root the
 * user asked for.
 *
 * Derived from the resolved root rather than the raw environment value, so it cannot answer
 * anything {@link getConfigRootOverride} refuses: one validator, consulted by both.
 */
export function getConfigDirName(): string {
	const override = getConfigRootOverride();
	return override === undefined ? CONFIG_DIR_NAME : path.relative(resolveHomeDirOrThrow(), override);
}

/**
 * Directory whose `agent.db` holds the machine-wide SHARED credential store read
 * by every profile when `resolveGlobalProfileSharing` in `./global-config` is on. Lives beside
 * the global `config.yml` at the base config root, under a dedicated name so it
 * never collides with the legacy `~/.veyyon/agent` layout (which triggers the
 * legacy-migration path) or with `profiles/`. Not XDG-redirected: the shared
 * store is intentionally one fixed machine-wide location.
 */
export function getSharedAuthDir(): string {
	return path.join(getGlobalConfigRootDir(), "shared-auth");
}

/**
 * Directory holding user-authored agent definitions (`<name>.md`, YAML
 * frontmatter + prompt body), read by every profile.
 *
 * DISCOVERY IS GLOBAL, ENABLING IS PER-PROFILE. A definition is authored
 * content, so it lives once at the base config root beside the global
 * `config.yml`; whether a profile may spawn it is that profile's
 * `agent.agents.<name>.enabled`. Keeping the file inside a profile's agent
 * dir meant re-authoring the same agent for every profile, and it read as
 * profile state rather than as something the operator wrote.
 *
 * Not XDG-redirected, for the reason {@link getSharedAuthDir} is not: one fixed
 * machine-wide location is the whole point.
 */
export function getGlobalSubagentsDir(): string {
	return path.join(getGlobalConfigRootDir(), SUBAGENTS_DIR_NAME);
}
