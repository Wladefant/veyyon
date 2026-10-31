/**
 * The global config file: `config.yml` (or `config.yaml`) at the config home, holding the cross-profile
 * keys every profile reads: `defaultProfile`, `profileSharing`, the auth broker, the machine-wide limits
 * and the onboarding generation.
 *
 * This module reads it, and imports no lock and no logger. `./dirs` calls it while loading to resolve the
 * startup profile, and the logger imports `./dirs` for its log directory, so a reader that reached the
 * logger would close a cycle: with this module as the first one a process imports, `./dirs` would run
 * before this module's bindings exist, and the safe reader it calls would swallow the `ReferenceError`
 * and report no default profile. Writes take the file lock, which logs, so they are in
 * `./global-config-write`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalConfigRootDir, normalizeProfileName, PROFILES_DIR_NAME } from "./config-root";
import { isMissingPath } from "./fs-error";
import { sleepSync } from "./sleep";
import { errorMessage, isRecord } from "./type-guards";
import { parseYaml } from "./yaml-sync";

/** Ordered main settings filenames: canonical write target first, legacy-compatible YAML fallback second. */
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/**
 * Bounded retry for a PRESENT-but-momentarily-unreadable global config (EMFILE /
 * EBUSY / transient IO), so a rebuild's fd pressure cannot flip the credential
 * posture. Small and fixed: this runs on the startup path, and the failure it
 * covers clears in milliseconds or not at all.
 */
const GLOBAL_CONFIG_READ_RETRY_ATTEMPTS = 3;
const GLOBAL_CONFIG_READ_RETRY_DELAY_MS = 5;

/**
 * How one candidate config file turned out.
 *
 * These three states must stay distinct because two of them used to collapse
 * into one. `readGlobalConfigRecord` returned `{}` both for "no file exists" and
 * for "a file exists but holds no YAML mapping", so a ZERO-BYTE `config.yml` was
 * indistinguishable from a fresh install: the onboarding gate read "no
 * onboardingVersion", concluded nobody had ever run setup, and walked a
 * long-onboarded user back through the wizard. That empty file is not exotic
 * either. `mutateGlobalConfigKey` in `./global-config-write` writes one DELIBERATELY when it cannot
 * unlink a config it has just emptied, so this is a state the code reaches by
 * itself and not something the user broke.
 */
export type MainConfigCandidate =
	/** Nothing at this path. The ONLY state that means "no config here". */
	| { kind: "absent" }
	/** Present, valid YAML, and a mapping: the one usable shape. */
	| { kind: "map"; record: Record<string, unknown>; text: string }
	/** Present and valid YAML but not a mapping: zero bytes, a scalar, a sequence. */
	| { kind: "not-a-map" };

/** How to name a config file in an error the user has to act on. */
interface ConfigFileKind {
	/** Opens the message: "Global config /home/u/.veyyon/config.yml could not be read...". */
	subject: string;
	/** What the user can safely do about a broken file, appended after the cause. */
	repairHint: string;
}

const GLOBAL_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Global config",
	repairHint: "Fix or remove the file (it holds only cross-profile keys like defaultProfile).",
};

/** The retired per-profile config, read only by {@link readLegacyProfileSetupVersion}. */
const PROFILE_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Profile config",
	repairHint: "Fix or remove the file.",
};

/**
 * Read one candidate's bytes, or `undefined` when the path is not there.
 *
 * ONE owner for the absent-versus-unreadable split and its bounded retry,
 * because the reader and the writer each had their own answer and the writer's
 * was destructive. `mutateGlobalConfigKey` did `catch { continue; }`, so a single
 * non-absence error (EMFILE under fd pressure while several rebuilt processes
 * start at once, EACCES, EIO, an NFS blip) made a populated config look empty and
 * the read-modify-write then emitted a file holding ONLY the key being mutated:
 * `defaultProfile`, `profileSharing`, `onboardingVersion` and the auth-broker
 * token all gone, with no error anywhere. A present-but-unreadable file has to
 * ABORT the mutation; it must never shrink it.
 *
 * ENOENT is the obvious absence and ENOTDIR is the same fact reached differently,
 * so absence is {@link isMissingPath} rather than a local ENOENT check that could
 * drift from the rest of the tree. Every other code means the file IS there:
 * treating those as "no config" is what would silently default `profileSharing`
 * and relocate the credential store to the empty shared dir, logging a
 * `profileSharing:false` user out this run and back in the next.
 */
function readConfigFileText(filePath: string, fileKind: ConfigFileKind): string | undefined {
	for (let attempt = 0; ; attempt++) {
		try {
			return fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			// Present but momentarily unreadable, which is transient by nature: retry
			// briefly so only a persistent failure surfaces, and never as a silent
			// posture flip.
			if (attempt < GLOBAL_CONFIG_READ_RETRY_ATTEMPTS) {
				sleepSync(GLOBAL_CONFIG_READ_RETRY_DELAY_MS);
				continue;
			}
			throw new Error(
				`${fileKind.subject} ${filePath} could not be read: ${errorMessage(error)}. ` +
					`Nothing was changed; restore the file's readability and retry.`,
			);
		}
	}
}

/** Classify one candidate path. Throws only for a file that is present and whose YAML does not parse. */
function classifyConfigCandidate(filePath: string, fileKind: ConfigFileKind): MainConfigCandidate {
	const text = readConfigFileText(filePath, fileKind);
	if (text === undefined) return { kind: "absent" };
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new Error(
			`${fileKind.subject} ${filePath} is not valid YAML: ${errorMessage(error)}. ${fileKind.repairHint}`,
		);
	}
	if (isRecord(parsed)) return { kind: "map", record: parsed as Record<string, unknown>, text };
	return { kind: "not-a-map" };
}

/** The candidate chosen out of {@link MAIN_CONFIG_FILENAMES} for one directory, and what it holds. */
export interface MainConfigSelection {
	/** The file every reader and the writer use for this root. */
	filePath: string;
	candidate: MainConfigCandidate;
}

/**
 * Apply {@link MAIN_CONFIG_FILENAMES} precedence to one directory.
 *
 * The first name still wins OUTRIGHT when it is usable and the files are never
 * merged, because merging two files that disagree makes the effective config
 * depend on a rule nobody can see. What changed is what "usable" means. A
 * candidate that exists but holds no YAML mapping carries no keys at all, so
 * letting it win bought nothing and cost everything: an empty `config.yml` buried
 * a fully populated `config.yaml` permanently, with no error, no effect, and no
 * way for the user to see why the file they edited was dead. So a usable map now
 * beats a present-but-unusable earlier name, and the loser is still reported by
 * {@link findShadowedGlobalConfigFiles} so the shadowing never goes silent.
 *
 * When NOTHING parses to a map, the first PRESENT candidate is selected and
 * carries `not-a-map`. That is what keeps "present but unusable" tellable from
 * "absent" one level up, and it is also the file the writer has to rewrite.
 */
function selectMainConfigFile(root: string, fileKind: ConfigFileKind): MainConfigSelection {
	let firstPresent: MainConfigSelection | undefined;
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const filePath = path.join(root, filename);
		const candidate = classifyConfigCandidate(filePath, fileKind);
		if (candidate.kind === "map") return { filePath, candidate };
		if (candidate.kind === "not-a-map") firstPresent ??= { filePath, candidate };
	}
	return firstPresent ?? { filePath: path.join(root, MAIN_CONFIG_FILENAMES[0]), candidate: { kind: "absent" } };
}

/**
 * {@link selectMainConfigFile} for the GLOBAL config, which is the selection every reader here and every
 * writer in `./global-config-write` makes, so a write never lands in a file the next read ignores.
 * `repairHint` replaces the advice in a read or parse error, so a writer can name the key it was about to
 * change.
 */
export function selectGlobalConfigFile(repairHint: string = GLOBAL_CONFIG_FILE_KIND.repairHint): MainConfigSelection {
	return selectMainConfigFile(getGlobalConfigRootDir(), { subject: GLOBAL_CONFIG_FILE_KIND.subject, repairHint });
}

/** The GLOBAL config as a parsed record, the file it came from, and whether that file is present but unusable. */
interface GlobalConfigRead {
	/** The parsed mapping, or `{}` when no file exists or the one that does holds no mapping. */
	record: Record<string, unknown>;
	/**
	 * The file the record came from, or the canonical path when none exists. Lets
	 * each caller name the offending file in its own value-validation errors.
	 */
	filePath: string;
	/**
	 * A file exists at `filePath` but holds no YAML mapping, so `record` is empty
	 * because of THAT rather than because the machine is new. Readers whose default
	 * is safe either way (`defaultProfile`, `profileSharing`) deliberately ignore
	 * this and keep their default; the onboarding reader must not, because there
	 * "absent" means run the setup wizard.
	 */
	presentButUnusable: boolean;
}

/**
 * Read the whole GLOBAL config file. One reader for every global key so callers
 * do not each re-implement the filename precedence. Throws on unreadable or
 * unparseable YAML, naming the file.
 */
function readGlobalConfigRecord(): GlobalConfigRead {
	const { filePath, candidate } = selectGlobalConfigFile();
	return {
		record: candidate.kind === "map" ? candidate.record : {},
		filePath,
		presentButUnusable: candidate.kind === "not-a-map",
	};
}

/**
 * The GLOBAL config file that reads and writes actually use: the first name in
 * {@link MAIN_CONFIG_FILENAMES} that parses to a YAML mapping, else the first one
 * that merely exists, else the canonical `config.yml` that a first write creates.
 *
 * Never throws. Its whole job is to let a user-facing message name the file, and
 * a notification that a save FAILED must not itself fail because the file it
 * wants to name is the unreadable one.
 */
export function getGlobalConfigFilePath(): string {
	const root = getGlobalConfigRootDir();
	try {
		return selectMainConfigFile(root, GLOBAL_CONFIG_FILE_KIND).filePath;
	} catch {
		// A candidate that cannot even be classified (unreadable, unparseable) is
		// exactly the file the caller wants to talk about, and it is reached before any
		// later name, so the canonical path is the right thing to name.
		return path.join(root, MAIN_CONFIG_FILENAMES[0]);
	}
}

/** A config file that exists but is ignored because a higher-precedence one does too. */
export interface ShadowedConfigFile {
	/** The file that is being ignored. */
	ignored: string;
	/** The file being used instead. */
	using: string;
}

/**
 * Config files in `root` that exist but are ignored because another name in
 * {@link MAIN_CONFIG_FILENAMES} is the one being read.
 *
 * The precedence itself is deliberate and must not change: one file wins outright
 * and the others are NOT merged, because merging two files that disagree would
 * make the effective config depend on a rule nobody can see. But leaving the
 * loser silent is its own trap. Someone who edits `config.yaml` while `config.yml`
 * exists gets no error, no effect and no clue: their file is simply dead, and
 * every symptom points at the setting they changed rather than at the file they
 * changed it in.
 *
 * The winner reported here is the one {@link selectMainConfigFile} picks, not
 * blindly the first present name. Comparing against the first name would name the
 * wrong file in exactly the case that hurts most: an empty `config.yml` beside a
 * populated `config.yaml` would send the user to edit the empty file, which is no
 * longer the file being read.
 *
 * This returns the finding instead of logging it because this module sits below
 * the logger (see the module doc). The settings layer, which
 * has both a logger and a user-visible surface, reports it. Precedence still has
 * exactly one owner: the constant and this function live here.
 */
export function findShadowedGlobalConfigFiles(root: string = getGlobalConfigRootDir()): ShadowedConfigFile[] {
	// existsSync, not the classifier, decides PRESENCE: a directory named
	// `config.yml` is not readable as a file yet really does sit where a config
	// would, and the user still needs to be told it is not being read.
	const present = MAIN_CONFIG_FILENAMES.filter(filename => fs.existsSync(path.join(root, filename)));
	const usable = present.find(filename => {
		try {
			return classifyConfigCandidate(path.join(root, filename), GLOBAL_CONFIG_FILE_KIND).kind === "map";
		} catch {
			// Unreadable or unparseable is exactly "not usable", and this function only
			// ever feeds a warning: throwing here would turn a diagnostic about a dead
			// file into a crash.
			return false;
		}
	});
	const winner = usable ?? present[0];
	if (winner === undefined) return [];
	return present
		.filter(filename => filename !== winner)
		.map(filename => ({
			ignored: path.join(root, filename),
			using: path.join(root, winner),
		}));
}

/**
 * Read `defaultProfile` from the GLOBAL config file (`~/.veyyon/config.yml` /
 * `config.yaml` at the config root — distinct from any profile's own settings
 * file under `profiles/<name>/agent/`). Returns `undefined` when no global
 * config exists or the key is unset; throws on unreadable YAML or an invalid
 * profile name so the CLI can surface a clean error naming the file.
 */
export function resolveGlobalDefaultProfile(): string | undefined {
	const { record, filePath } = readGlobalConfigRecord();
	const value = record.defaultProfile;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`Global config ${filePath}: defaultProfile must be a string profile name.`);
	}
	try {
		return normalizeProfileName(value);
	} catch (error) {
		throw new Error(`Global config ${filePath}: ${errorMessage(error)}`);
	}
}

/** Module-load-safe variant of {@link resolveGlobalDefaultProfile}: a broken global config must not crash a bare import; the CLI re-validates loudly. */
export function readGlobalDefaultProfileSafe(): string | undefined {
	try {
		return resolveGlobalDefaultProfile();
	} catch {
		// Undefined means "no global default", so the caller uses the built-in default profile. Quiet on
		// purpose and only here: this runs at module load, where there is no logger to report to yet, and
		// the CLI re-reads the same config through the validating path that DOES report it.
		return undefined;
	}
}

/**
 * The auth-broker keys in the GLOBAL config. Stored NESTED
 * (`auth: { broker: { url, token } }`); the reader also accepts the legacy
 * flat literal keys (`"auth.broker.url"`), matching the discovery precedence
 * in `packages/ai/src/auth-broker/discover.ts` (nested wins). The writers
 * always persist the nested form and remove any legacy flat duplicate so the
 * value has exactly one home after the first write.
 */
export const AUTH_BROKER_SEGMENTS = ["auth", "broker"] as const;

/** The global auth-broker configuration, read without ever exposing the token. */
export interface GlobalAuthBroker {
	url: string | undefined;
	/** Whether a token is stored. The plaintext is deliberately not returned:
	 * settings surfaces render presence, never the secret. */
	tokenSet: boolean;
}

function readAuthBrokerValue(record: Record<string, unknown>, leaf: "url" | "token"): string | undefined {
	// Nested form wins over the legacy flat literal-dot key.
	const auth = record[AUTH_BROKER_SEGMENTS[0]];
	if (isRecord(auth)) {
		const broker = auth[AUTH_BROKER_SEGMENTS[1]];
		if (isRecord(broker) && typeof broker[leaf] === "string" && (broker[leaf] as string).length > 0) {
			return broker[leaf] as string;
		}
	}
	const flat = record[`${AUTH_BROKER_SEGMENTS.join(".")}.${leaf}`];
	return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

/**
 * Read the auth-broker url and token PRESENCE from the GLOBAL config. Safe:
 * a broken global config must never crash a bare import or the settings UI;
 * discovery re-validates loudly on the auth path itself.
 */
export function readGlobalAuthBrokerSafe(): GlobalAuthBroker {
	try {
		const { record } = readGlobalConfigRecord();
		return {
			url: readAuthBrokerValue(record, "url"),
			tokenSet: readAuthBrokerValue(record, "token") !== undefined,
		};
	} catch {
		return { url: undefined, tokenSet: false };
	}
}

/**
 * The global-config key controlling whether provider credentials are shared
 * across profiles. Absent or `true` means shared (the default posture); `false`
 * isolates each profile to its own credential store. One owner for the literal
 * so the reader, writer, and any settings-domain binding agree.
 */
export const PROFILE_SHARING_CONFIG_KEY = "profileSharing";

/**
 * Whether provider credentials are shared across profiles (the "shared by
 * default" posture). Reads `profileSharing` from the GLOBAL config: absent →
 * shared (`true`); an explicit boolean is honored. A non-boolean value throws
 * naming the file, matching {@link resolveGlobalDefaultProfile}'s strictness so
 * a typo cannot silently flip the credential posture.
 */
export function resolveGlobalProfileSharing(): boolean {
	const { record, filePath } = readGlobalConfigRecord();
	const value = record[PROFILE_SHARING_CONFIG_KEY];
	if (value === undefined || value === null) return true;
	if (typeof value !== "boolean") {
		throw new Error(
			`Global config ${filePath}: ${PROFILE_SHARING_CONFIG_KEY} must be a boolean ` +
				`(true = share credentials across profiles, false = isolate). Got ${typeof value}.`,
		);
	}
	return value;
}

/** Module-load-safe variant of {@link resolveGlobalProfileSharing}: a broken/invalid global config must never crash a bare import; the CLI re-validates loudly. Defaults to shared. */
export function readGlobalProfileSharingSafe(): boolean {
	try {
		return resolveGlobalProfileSharing();
	} catch {
		return true;
	}
}

/**
 * The GLOBAL config key holding machine-wide resource limits.
 *
 * These are machine-wide rather than per-profile because they bound VEYYON,
 * not one session and not one profile. Two profiles running at once share one
 * CPU and one disk, so a cap held per profile is not the cap it names: each
 * copy reads its own file, and the machine gets the sum. Grouped under one
 * mapping so a hand-edited config keeps them together instead of scattering
 * four numbers across the top level.
 *
 * The key is also the settings-path prefix (`machine.cpuLimitCores` is stored
 * at `machine.cpuLimitCores`), so the panel, the generated reference and the
 * file a person opens all spell the value the same way.
 */
export const GLOBAL_MACHINE_CONFIG_KEY = "machine";

/**
 * Every machine-wide limit, by leaf name under {@link GLOBAL_MACHINE_CONFIG_KEY}.
 * The leaf names match the per-session setting they bound, so the two tiers of
 * one resource are recognisably the same knob at two scopes.
 *
 * Enumerated here rather than at each call site: the settings domain, the
 * bindings map and the budget placement all derive from this list, so adding a
 * resource is one edit and cannot reach three of the four places.
 */
export const GLOBAL_RESOURCE_LIMITS = ["cpuLimitCores", "memoryLimitGb", "writeBudgetGb", "maxProcesses"] as const;

export type GlobalResourceLimit = (typeof GLOBAL_RESOURCE_LIMITS)[number];

/**
 * One machine-wide limit from the GLOBAL config. `0` means no limit, which is
 * also what an absent key means, so an unconfigured machine and an explicitly
 * lifted one behave identically.
 *
 * Throws on a value that is present but not a non-negative finite number,
 * naming the file and the key: a limit is a safety control, and a typo that
 * silently read as "no limit" is the failure this must not have.
 */
export function resolveGlobalResourceLimit(limit: GlobalResourceLimit): number {
	const { record, filePath } = readGlobalConfigRecord();
	const resources = record[GLOBAL_MACHINE_CONFIG_KEY];
	if (!isRecord(resources)) return 0;
	const value = resources[limit];
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(
			`Global config ${filePath}: ${GLOBAL_MACHINE_CONFIG_KEY}.${limit} must be a non-negative number ` +
				`(0 = no limit). Got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/**
 * Module-load-safe variant of {@link resolveGlobalResourceLimit}. A broken
 * global config must never crash a bare import or the settings panel.
 *
 * It reports NO limit rather than some limit, because the alternative is worse:
 * a config the reader cannot parse would otherwise cap a machine at a number
 * nobody chose, with no way to see where it came from. The budget placement
 * surfaces the parse failure through {@link resolveGlobalResourceLimit} on the
 * path that actually applies limits, so the error is reported rather than lost.
 */
export function readGlobalResourceLimitSafe(limit: GlobalResourceLimit): number {
	try {
		return resolveGlobalResourceLimit(limit);
	} catch {
		return 0;
	}
}

/**
 * The onboarding-generation key in the GLOBAL config.
 *
 * Onboarding is something a HUMAN does once per machine, so its marker belongs
 * beside `defaultProfile` rather than inside one profile's settings file. Held
 * per profile it made `--profile <name>` look like a brand-new install: the new
 * profile's `agent/config.yml` has no onboarding key, the gate read the schema
 * default, and a user who had onboarded years ago was walked through the setup
 * wizard again. One owner for the literal so the reader, the writer, and the
 * settings-domain binding agree.
 */
export const ONBOARDING_VERSION_CONFIG_KEY = "onboardingVersion";

/** The machine-wide onboarding generation, and whether it could be read at all. */
export interface GlobalOnboardingVersion {
	/** The stored generation, or `undefined` when the key is absent. */
	version: number | undefined;
	/**
	 * True when the global config is present but could not be read or parsed, so
	 * `version` is absent because of that failure rather than because the machine
	 * is new. A caller deciding whether to onboard MUST NOT read this case as a
	 * first install: that is how a corrupt config re-ran the setup wizard.
	 */
	unreadable: boolean;
}

/**
 * The onboarding generation this machine has completed, from the GLOBAL config.
 * `undefined` means the key is absent (never onboarded). Throws on unreadable
 * YAML, on a config file that exists but holds no mapping, or on a non-numeric
 * value, naming the file, matching {@link resolveGlobalDefaultProfile}'s
 * strictness so a typo cannot silently decide whether a user is onboarded.
 */
export function resolveGlobalOnboardingVersion(): number | undefined {
	const { record, filePath, presentButUnusable } = readGlobalConfigRecord();
	if (presentButUnusable) {
		// The one reader that must NOT fold this into its default. A config file that
		// exists but holds no mapping (zero bytes is the common one) carries no
		// onboarding record, and reading that as "never onboarded" is precisely how a
		// machine set up years ago got marched through the setup wizard again. The
		// sibling readers keep their default here because sharing credentials or using
		// the default profile is safe either way; re-onboarding is not.
		throw new Error(
			`Global config ${filePath} exists but holds no settings mapping (it is empty, or not a YAML map), ` +
				`so whether this machine has already completed setup cannot be read. ` +
				`Restore or delete the file; setup was NOT treated as unfinished.`,
		);
	}
	const value = record[ONBOARDING_VERSION_CONFIG_KEY];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(
			`Global config ${filePath}: ${ONBOARDING_VERSION_CONFIG_KEY} must be a finite number ` +
				`(the setup generation already completed on this machine). Got ${typeof value}.`,
		);
	}
	return value;
}

/**
 * Never-throwing variant of {@link resolveGlobalOnboardingVersion} that reports
 * WHY the value is missing.
 *
 * The distinction is the whole point: the sibling `*Safe` readers can fold a
 * failure into their default because sharing credentials or using the default
 * profile is a safe posture either way. Onboarding is not symmetric. "Absent"
 * means run the wizard and "unreadable" means do not, so a reader that returned
 * one number for both would re-onboard every launch a config file was corrupt.
 */
export function readGlobalOnboardingVersionSafe(): GlobalOnboardingVersion {
	try {
		return { version: resolveGlobalOnboardingVersion(), unreadable: false };
	} catch {
		return { version: undefined, unreadable: true };
	}
}

/**
 * The RETIRED per-profile onboarding key. Never written any more; read only so a
 * machine onboarded before the key moved to the global config is still recognised.
 */
const LEGACY_PROFILE_SETUP_VERSION_KEY = "setupVersion";

/** The highest retired per-profile `setupVersion` on this machine, and whether any profile hid one. */
export interface LegacyProfileSetupVersion {
	/** The maximum recorded generation across every profile, or `undefined` when none records one. */
	version: number | undefined;
	/**
	 * A profile config exists but could not be read, parsed, or understood, so
	 * `version` may be too low or missing entirely. A caller deciding whether to
	 * onboard MUST treat this as "cannot tell", never as "never onboarded".
	 */
	unreadable: boolean;
}

/**
 * The highest retired `setupVersion` recorded by ANY profile under `profiles/`.
 *
 * Onboarding is something a human does once per MACHINE, so evidence that it
 * happened has to be read machine-wide. The promotion that fills in the global
 * `onboardingVersion` used to fall back to the retired key through the settings
 * layer, which resolves the ACTIVE profile only. On the reporting user's disk the
 * record lived in `profiles/work/agent/config.yml` while `profiles/oss-work` had
 * no config file at all, so launching `--profile oss-work` first looked in one
 * profile, found nothing, and declared a fresh install on a machine that had been
 * onboarded for years: the full four-step wizard, from the top.
 *
 * Absence contributes nothing, because a profile that never stored the key is the
 * normal case. Anything else that stops a profile from answering sets `unreadable`
 * instead of vanishing: a file that will not read or parse, a file that holds no
 * mapping, and a `setupVersion` that is present but not a finite number. All three
 * mean the profile has something to say about onboarding that could not be
 * understood, and silently skipping them is the same "declare a fresh install"
 * bug one level down.
 */
export function readLegacyProfileSetupVersion(): LegacyProfileSetupVersion {
	const profilesRoot = path.join(getGlobalConfigRootDir(), PROFILES_DIR_NAME);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
	} catch (error) {
		// No `profiles/` at all is a genuinely fresh install and contributes nothing.
		// Any other failure HID profiles that may well record a version, so it must
		// not read as "never onboarded".
		return { version: undefined, unreadable: !isMissingPath(error) };
	}
	let version: number | undefined;
	let unreadable = false;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const value = readProfileSetupVersion(path.join(profilesRoot, entry.name, "agent"));
		if (value === "unreadable") unreadable = true;
		else if (value !== undefined) version = version === undefined ? value : Math.max(version, value);
	}
	return { version, unreadable };
}

/** One profile's `setupVersion`: `undefined` when it records none, `"unreadable"` when its config or the value cannot be understood. */
function readProfileSetupVersion(agentDir: string): number | "unreadable" | undefined {
	let candidate: MainConfigCandidate;
	try {
		// Same filename precedence and same read-with-retry as the global config,
		// so a profile's `config.yml`/`config.yaml` cannot be resolved two ways.
		candidate = selectMainConfigFile(agentDir, PROFILE_CONFIG_FILE_KIND).candidate;
	} catch {
		return "unreadable";
	}
	if (candidate.kind === "absent") return undefined;
	if (candidate.kind === "not-a-map") return "unreadable";
	const value = candidate.record[LEGACY_PROFILE_SETUP_VERSION_KEY];
	if (value === undefined || value === null) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : "unreadable";
}
