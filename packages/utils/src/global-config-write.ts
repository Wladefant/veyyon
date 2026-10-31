/**
 * Writes to the global config file `./global-config` reads.
 *
 * Every write is one serialized read-modify-write under the file lock ({@link mutateGlobalConfigKey}),
 * through the same file selection the readers use. The lock is why this is a module of its own:
 * `./file-lock` reports through the logger, the logger imports `./dirs`, and `./dirs` reads the global
 * config while it loads, so the readers must not reach the lock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { getGlobalConfigRootDir, normalizeProfileName } from "./config-root";
import { withFileLockSync } from "./file-lock";
import {
	AUTH_BROKER_SEGMENTS,
	GLOBAL_MACHINE_CONFIG_KEY,
	type GlobalResourceLimit,
	MAIN_CONFIG_FILENAMES,
	ONBOARDING_VERSION_CONFIG_KEY,
	PROFILE_SHARING_CONFIG_KEY,
	selectGlobalConfigFile,
} from "./global-config";
import { errorMessage, isRecord } from "./type-guards";
import { syncYamlTextToSettings } from "./yaml-sync";

/**
 * Serialized read-modify-write of a single GLOBAL config key, preserving every
 * other key. `mutate` receives the current record and returns the value to
 * store, or `undefined` to delete the key. Returns the file written. One writer
 * for every global key so the lock target, atomicity, and empty-file cleanup
 * live in exactly one place (see {@link writeGlobalDefaultProfile}, which is a
 * thin wrapper over this).
 */
function mutateGlobalConfigKey(key: string, mutate: (current: Record<string, unknown>) => unknown): string {
	const root = getGlobalConfigRootDir();
	fs.mkdirSync(root, { recursive: true });
	// The canonical config path is the stable lock target regardless of which
	// filename actually exists on disk, so every writer serializes on one lock.
	const canonicalPath = path.join(root, MAIN_CONFIG_FILENAMES[0]);
	return withFileLockSync(canonicalPath, () => {
		// The same selection the readers use, so a write can never land in a file
		// the next read ignores. It throws for a present-but-unreadable candidate,
		// which is the point: aborting leaves the user's other global keys intact,
		// where swallowing the error rewrote the file with only `key` in it.
		const { filePath, candidate } = selectGlobalConfigFile(`Fix or remove the file before changing ${key}.`);
		const existing = candidate.kind === "map" ? candidate.record : {};
		// The file's own bytes, so the write can EDIT it rather than re-serialize it: this
		// is a file people hand-edit, and a re-serialization discards their comments,
		// blank lines and key order (see syncYamlTextToSettings). A candidate that is not
		// a mapping has no keys, comments or order to keep, and splicing a key into a
		// scalar document would not even be valid YAML, so it is rewritten from empty.
		const existingText = candidate.kind === "map" ? candidate.text : "";
		const next = mutate(existing);
		if (next === undefined) delete existing[key];
		else existing[key] = next;
		if (Object.keys(existing).length === 0) {
			// Nothing left — remove the file rather than leaving an empty stub.
			//
			// If the unlink fails the removal still has to persist. Swallowing it left
			// the file holding its previous contents, so the key the caller just
			// deleted came back on the next read: a profile switch or a change to the
			// credential-sharing posture reported success and silently reverted. An
			// empty file is a worse-looking but honest end state, and the next write
			// cleans it up. A failure to write that is left to throw, because at that
			// point nothing can be persisted and saying so is the only correct move.
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					// process.emitWarning, which prints to stderr: the caller changed a key in a
					// file people edit by hand, and the log file is not where they look for it.
					process.emitWarning(
						`Could not remove the now-empty global config ${filePath} (${errorMessage(error)}); ` +
							`writing it empty instead so the removal of "${key}" persists.`,
						{ code: "VEYYON_CONFIG_UNLINK_FAILED" },
					);
					atomicWriteFileSync(filePath, "");
				}
			}
			return filePath;
		}
		// Atomic: an interrupted write here would corrupt cross-profile keys
		// (the pointer to the active profile, credential-sharing posture).
		atomicWriteFileSync(filePath, syncYamlTextToSettings(existingText, existing));
		return filePath;
	});
}

/**
 * Set or clear `defaultProfile` in the GLOBAL config file, preserving every
 * other key. Pass a profile name to set (validated; "default" clears, since
 * the default profile needs no override) or `undefined` to clear. Returns the
 * file written.
 */
export function writeGlobalDefaultProfile(profile: string | undefined): string {
	const normalized = normalizeProfileName(profile);
	// `normalizeProfileName` collapses the default profile to `undefined`, which
	// clears the key — the default needs no override.
	return mutateGlobalConfigKey("defaultProfile", () => normalized);
}

/** Set or clear (`undefined`/empty) one auth-broker leaf, preserving every
 * other key. Writes the nested form, deletes any legacy flat duplicate, and
 * prunes empty `broker`/`auth` records so a fully cleared config leaves no
 * stub behind. */
function writeGlobalAuthBrokerLeaf(leaf: "url" | "token", value: string | undefined): string {
	const [authKey, brokerKey] = AUTH_BROKER_SEGMENTS;
	return mutateGlobalConfigKey(authKey, existing => {
		// The legacy flat literal key would shadow-read forever; one home only.
		delete existing[`${authKey}.${brokerKey}.${leaf}`];
		const auth = isRecord(existing[authKey]) ? (existing[authKey] as Record<string, unknown>) : {};
		const broker = isRecord(auth[brokerKey]) ? (auth[brokerKey] as Record<string, unknown>) : {};
		const trimmed = value?.trim();
		if (trimmed) broker[leaf] = trimmed;
		else delete broker[leaf];
		if (Object.keys(broker).length > 0) auth[brokerKey] = broker;
		else delete auth[brokerKey];
		return Object.keys(auth).length > 0 ? auth : undefined;
	});
}

/** Set or clear the global auth-broker URL. Returns the file written. */
export function writeGlobalAuthBrokerUrl(url: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("url", url);
}

/** Set or clear the global auth-broker bearer token. Never logged, never read
 * back into any UI surface (see `readGlobalAuthBrokerSafe` in `./global-config`). Returns the
 * file written. */
export function writeGlobalAuthBrokerToken(token: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("token", token);
}

/**
 * Set the credential-sharing posture in the GLOBAL config, preserving every
 * other key. `true` shares credentials across profiles (deletes the key, since
 * shared is the default); `false` writes the explicit isolate flag. Returns the
 * file written.
 */
export function writeGlobalProfileSharing(shared: boolean): string {
	return mutateGlobalConfigKey(PROFILE_SHARING_CONFIG_KEY, () => (shared ? undefined : false));
}

/**
 * Set or lift one machine-wide limit, preserving every other key. `0` deletes
 * the leaf and an emptied `resources` mapping, so a fully lifted config leaves
 * no stub behind. Returns the file written.
 */
export function writeGlobalResourceLimit(limit: GlobalResourceLimit, value: number): string {
	return mutateGlobalConfigKey(GLOBAL_MACHINE_CONFIG_KEY, existing => {
		const resources = isRecord(existing[GLOBAL_MACHINE_CONFIG_KEY])
			? { ...(existing[GLOBAL_MACHINE_CONFIG_KEY] as Record<string, unknown>) }
			: {};
		if (Number.isFinite(value) && value > 0) resources[limit] = Math.floor(value);
		else delete resources[limit];
		return Object.keys(resources).length > 0 ? resources : undefined;
	});
}

/**
 * Record the onboarding generation in the GLOBAL config, preserving every other
 * key; `undefined` clears it. Returns the file written. Synchronous and atomic
 * under the shared lock, so the fact that a user completed onboarding is on disk
 * before the call returns rather than waiting on a debounced save that a closed
 * terminal would discard.
 */
export function writeGlobalOnboardingVersion(version: number | undefined): string {
	return mutateGlobalConfigKey(ONBOARDING_VERSION_CONFIG_KEY, () => version);
}
