/**
 * The on-disk store of completed daemon records, one file per project runtime directory.
 *
 * WHY THIS EXISTS. A finite daemon's end used to live only in the broker's memory and in the
 * per-daemon `meta.json`, both of which the next start of the same name overwrites: a completed
 * cooldown job disappeared from `launch list` with its exit code, its output tail and the reason
 * it ended. The broker now appends a {@link DaemonCompletionRecord} here on every terminal
 * transition, so a finished job stays queryable after it leaves the active list and after the
 * broker itself restarts.
 *
 * THE FILE IS A CONTRACT BETWEEN BROKER GENERATIONS. A broker that died mid-session is replaced
 * by a new process reading whatever the predecessor left, so the schema is versioned: a store
 * written by another version is REJECTED, never half-served. Rejection means the reader throws
 * and the writer discards and starts fresh; a stale record is never returned to a client.
 *
 * BOUNDS. Retention is the last {@link DAEMON_COMPLETIONS_LIMIT} records OR
 * {@link DAEMON_COMPLETIONS_MAX_AGE_MS}, whichever bites first, applied on every append. The
 * read side filters too, so a quiet project cannot serve expired records merely
 * because no later completion triggered an append.
 *
 * A NAME OUTLIVES ITS LIVE RECORD. The broker purges an exited daemon's live record after the
 * cleanup wait, and a broker restart drops the records of non-detached daemons. Each stored record
 * holds the final state and the launch spec, so `stop`, `describe`, `logs`, `wait`, `send` and
 * `restart` answer for the name from here until the record leaves the store.
 */
import { readFile } from "node:fs/promises";

import { atomicWriteFile, errorMessage, isEnoent, isRecord, logger } from "@veyyon/utils";
import { daemonCompletionsPath } from "./paths";
import { type DaemonCompletionRecord, type DaemonSpec, parseDaemonCompletionRecord, parseDaemonSpec } from "./protocol";

/**
 * Schema version of the completions file. Bump when the record or envelope shape changes.
 * Version 2 added `state` and `spec` to every record.
 */
export const DAEMON_COMPLETIONS_SCHEMA_VERSION = 2;
/** How many completed records are retained. */
export const DAEMON_COMPLETIONS_LIMIT = 100;
/** How long a completed record is retained, in milliseconds (24h). */
export const DAEMON_COMPLETIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A completion record as the store holds it: the record `list` returns, plus the state the
 * generation ended in and the spec it ran. `list` drops both before a record leaves the broker;
 * no list line renders them, and 100 specs would grow every list result.
 */
export interface RetainedDaemonCompletion extends DaemonCompletionRecord {
	state: "exited" | "failed";
	spec: DaemonSpec;
}

function parseRetainedDaemonCompletion(value: unknown): RetainedDaemonCompletion {
	if (!isRecord(value)) throw new Error("daemon completion must be an object");
	const { state } = value;
	if (state !== "exited" && state !== "failed") {
		throw new Error(`completion.state must be exited or failed, got ${String(state)}`);
	}
	return { ...parseDaemonCompletionRecord(value), state, spec: parseDaemonSpec(value.spec) };
}

/**
 * Decode the completions envelope, rejecting any other schema version.
 *
 * Throws on a missing or mismatched `version`, a non-array `records`, and on any record that
 * fails validation: a store this cannot read in full is not served at all, because serving the
 * prefix that parses would present a truncated history as complete.
 */
export function parseDaemonCompletionsFile(value: unknown): RetainedDaemonCompletion[] {
	if (!isRecord(value)) {
		throw new Error("daemon completions file must be an object");
	}
	if (!("version" in value) || value.version !== DAEMON_COMPLETIONS_SCHEMA_VERSION) {
		const version = "version" in value ? String(value.version) : "missing";
		throw new Error(
			`Unsupported daemon completions schema version: ${version} (expected ${DAEMON_COMPLETIONS_SCHEMA_VERSION})`,
		);
	}
	if (!("records" in value) || !Array.isArray(value.records)) {
		throw new Error("daemon completions records must be an array");
	}
	return value.records.map(parseRetainedDaemonCompletion);
}

/** Read the retained completion records, oldest first. Throws on an unreadable or stale store. */
export async function readDaemonCompletions(
	runtimeDir: string,
	now: number = Date.now(),
): Promise<RetainedDaemonCompletion[]> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(await readFile(daemonCompletionsPath(runtimeDir), "utf8"));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const cutoff = now - DAEMON_COMPLETIONS_MAX_AGE_MS;
	return parseDaemonCompletionsFile(decoded)
		.filter(entry => entry.exitedAt >= cutoff)
		.slice(-DAEMON_COMPLETIONS_LIMIT);
}

/**
 * Append one completion record, applying the retention bounds, and return what the store now
 * holds. A store that cannot be read (corrupt, or written by another schema version) is
 * discarded and rebuilt around the new record rather than merged or served.
 */
export async function appendDaemonCompletion(
	runtimeDir: string,
	record: RetainedDaemonCompletion,
	now: number = Date.now(),
): Promise<RetainedDaemonCompletion[]> {
	let existing: RetainedDaemonCompletion[] = [];
	try {
		existing = await readDaemonCompletions(runtimeDir, now);
	} catch (error) {
		logger.warn("Discarding unreadable daemon completion records", {
			path: daemonCompletionsPath(runtimeDir),
			error: errorMessage(error),
		});
	}
	const cutoff = now - DAEMON_COMPLETIONS_MAX_AGE_MS;
	const records = existing
		.concat([record])
		.filter(entry => entry.exitedAt >= cutoff)
		.slice(-DAEMON_COMPLETIONS_LIMIT);
	await atomicWriteFile(
		daemonCompletionsPath(runtimeDir),
		JSON.stringify({ version: DAEMON_COMPLETIONS_SCHEMA_VERSION, records }),
	);
	return records;
}
