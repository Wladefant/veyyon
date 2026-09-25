/**
 * Phase heartbeat: what a process was doing, kept on disk while it does it.
 *
 * The in-flight marker ({@link ./inflight-marker}) names the tool call a
 * process died inside, and nothing else. veyyon#73's fourth silent death had no
 * tool call in flight: Main was inside a provider turn, straight after a
 * mid-run compaction, with eight lanes streaming, and the next launch had
 * nothing to say about it. This module covers the rest of a session's life.
 *
 * One file per process, `logs/heartbeat/<pid>.json`, naming the phase the
 * primary session is in (`provider`, `tool`, `compaction` or `idle`), when that
 * phase began, when the file was last rewritten, and how many spawned lanes in
 * the same process were busy. It is rewritten on every phase change and at
 * least every {@link HEARTBEAT_INTERVAL_MS}, and removed when the last session
 * in the process records its exit. A heartbeat still on disk whose process is
 * gone therefore means that process ended without reaching JavaScript exit,
 * and {@link reportSilentDeaths} turns it into the `error` line the log never
 * got.
 *
 * Writes are asynchronous and coalesced. This runs on the thread that also
 * paints the terminal, and a rewrite every few seconds for the life of the
 * session must not be a synchronous filesystem call on it. The cost is that the
 * phase on disk trails the phase in memory by one write; the tool-call marker,
 * which is synchronous, remains the exact account of a death inside a call.
 *
 * It carries no user content: pid, session id, a phase name, lane counts and
 * timestamps.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { getLogsDir } from "./dirs";
import { isMissingPath } from "./fs-error";
import * as logger from "./logger";
import { getProcessStartIdentity, isProcessAlive, isToolCallProcessAlive } from "./process-liveness";
import { errorMessage } from "./type-guards";

/** What a session is doing, from the outside. */
export type SessionPhase = "provider" | "tool" | "compaction" | "idle";

/**
 * Upper bound between rewrites while nothing changes phase. Half the ten
 * seconds veyyon#73 asked for, so a write that lands late still keeps the
 * on-disk heartbeat inside that bound.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** A session taking part in its process's heartbeat. */
export interface HeartbeatParticipant {
	/** Current session id; read at write time because a session can change it. */
	sessionId(): string;
	/** Current phase; read on {@link HeartbeatHandle.update} and on every tick. */
	phase(): SessionPhase;
	/**
	 * Whether another session in this process spawned this one. Spawned sessions
	 * are lanes: they are counted, and name the file only when no top-level
	 * session is left.
	 */
	spawned: boolean;
}

export interface HeartbeatHandle {
	/** Re-read the participant's phase; rewrites the heartbeat when it changed. */
	update(): void;
	/**
	 * Leave the heartbeat. The last participant out removes the file, so a
	 * process that ends through JavaScript leaves nothing to report.
	 */
	leave(): void;
}

/** What the file on disk holds. */
export interface SessionHeartbeat {
	pid: number;
	/**
	 * Boot + start identity of the writing process, so a pid the operating
	 * system has since reused is not mistaken for it. `null` where it cannot be
	 * read; see {@link isToolCallProcessAlive}.
	 */
	startIdentity: string | null;
	sessionId: string;
	phase: SessionPhase;
	/** When the primary session entered `phase`. */
	startedAt: string;
	/** When this file was last written; the process was alive then. */
	heartbeatAt: string;
	/** Spawned sessions in this process that were not idle. */
	activeLanes: number;
	/** Spawned sessions in this process. */
	lanes: number;
}

interface Participant {
	source: HeartbeatParticipant;
	phase: SessionPhase;
	since: string;
}

const participants = new Set<Participant>();
let startIdentity: string | null | undefined;
let interval: NodeJS.Timeout | undefined;
let writing = false;
let dirty = false;

function heartbeatDir(): string {
	return path.join(getLogsDir(), "heartbeat");
}

/**
 * `json` is the heartbeat. `exited` is the tombstone a session that left during
 * an in-flight rewrite puts beside it: that rewrite's rename can land after the
 * removal, and nothing asynchronous is promised a later turn on the way out, so
 * the tombstone is what tells the next launch the exit was recorded.
 */
function heartbeatPath(pid: number, kind: "json" | "exited" = "json"): string {
	return path.join(heartbeatDir(), `${pid}.${kind}`);
}

/** The top-level session names the file; a lane does only when it is all that is left. */
function primary(): Participant | undefined {
	let fallback: Participant | undefined;
	for (const participant of participants) {
		if (!participant.source.spawned) return participant;
		fallback ??= participant;
	}
	return fallback;
}

function snapshot(): SessionHeartbeat | undefined {
	const head = primary();
	if (!head) return undefined;
	let lanes = 0;
	let activeLanes = 0;
	for (const participant of participants) {
		if (participant === head || !participant.source.spawned) continue;
		lanes++;
		if (participant.phase !== "idle") activeLanes++;
	}
	startIdentity ??= getProcessStartIdentity(process.pid);
	return {
		pid: process.pid,
		startIdentity,
		sessionId: head.source.sessionId(),
		phase: head.phase,
		startedAt: head.since,
		heartbeatAt: new Date().toISOString(),
		activeLanes,
		lanes,
	};
}

async function flush(): Promise<void> {
	writing = true;
	try {
		while (dirty) {
			dirty = false;
			const record = snapshot();
			if (!record) break;
			try {
				await atomicWriteFile(heartbeatPath(process.pid), `${JSON.stringify(record)}\n`, { fsync: false });
			} catch (error) {
				// A heartbeat that cannot be written costs a future postmortem its phase
				// and nothing else; it must never become a way to break the session.
				logger.debug("Could not write session heartbeat", { error: errorMessage(error) });
			}
		}
		// The last session left while this write was on its way. Its removal ran
		// before the rename landed, so the file is back; take it away again, and
		// the tombstone after it, which only had to outlive the heartbeat.
		if (participants.size === 0) {
			await fsp.rm(heartbeatPath(process.pid), { force: true });
			await fsp.rm(heartbeatPath(process.pid, "exited"), { force: true });
		}
	} catch (error) {
		logger.debug("Could not remove session heartbeat", { error: errorMessage(error) });
	} finally {
		writing = false;
		// A session joined while the removal above was awaited.
		if (dirty && participants.size > 0) void flush();
	}
}

function scheduleWrite(): void {
	dirty = true;
	if (!writing) void flush();
}

function refresh(participant: Participant): boolean {
	const phase = participant.source.phase();
	if (phase === participant.phase) return false;
	participant.phase = phase;
	participant.since = new Date().toISOString();
	return true;
}

function tick(): void {
	for (const participant of participants) refresh(participant);
	scheduleWrite();
}

/**
 * Join this process's heartbeat. The first participant starts it, the last one
 * to {@link HeartbeatHandle.leave} removes it.
 */
export function joinHeartbeat(source: HeartbeatParticipant): HeartbeatHandle {
	const participant: Participant = { source, phase: source.phase(), since: new Date().toISOString() };
	if (participants.size === 0) {
		// A tombstone from an earlier session of this process would excuse a
		// silent death of this one.
		try {
			fs.rmSync(heartbeatPath(process.pid, "exited"), { force: true });
		} catch (error) {
			logger.debug("Could not remove session heartbeat tombstone", { error: errorMessage(error) });
		}
	}
	participants.add(participant);
	if (!interval) {
		interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);
		// A diagnostic must never be the reason a process stays alive.
		interval.unref();
	}
	scheduleWrite();
	let left = false;
	return {
		update() {
			if (left || !refresh(participant)) return;
			scheduleWrite();
		},
		leave() {
			if (left) return;
			left = true;
			participants.delete(participant);
			if (participants.size > 0) {
				scheduleWrite();
				return;
			}
			clearInterval(interval);
			interval = undefined;
			// Synchronous: this runs on the way out, where no later turn of the event
			// loop is promised to an asynchronous removal.
			try {
				if (writing) {
					fs.mkdirSync(heartbeatDir(), { recursive: true });
					fs.writeFileSync(heartbeatPath(process.pid, "exited"), "");
				}
				fs.rmSync(heartbeatPath(process.pid), { force: true });
			} catch (error) {
				logger.debug("Could not remove session heartbeat", { error: errorMessage(error) });
			}
		},
	};
}

function readHeartbeat(file: string): SessionHeartbeat | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const beat = parsed as Partial<SessionHeartbeat>;
		if (
			typeof beat.pid !== "number" ||
			typeof beat.sessionId !== "string" ||
			typeof beat.phase !== "string" ||
			typeof beat.startedAt !== "string" ||
			typeof beat.heartbeatAt !== "string"
		) {
			return undefined;
		}
		if (typeof beat.startIdentity !== "string") beat.startIdentity = null;
		if (typeof beat.activeLanes !== "number") beat.activeLanes = 0;
		if (typeof beat.lanes !== "number") beat.lanes = 0;
		return beat as SessionHeartbeat;
	} catch {
		// Atomic publication means a torn file is not ours to explain.
		return undefined;
	}
}

/**
 * Log one `error` line per process that left a heartbeat and is gone, then
 * remove the heartbeat. Called at session start, before this process writes
 * its own, so a live process is never reported.
 *
 * Returns the reported heartbeats, in file order.
 *
 * WHAT IT CANNOT SEE: a death whose pid was reused by a process whose
 * incarnation cannot be proven reads as alive and is left for a later launch,
 * the same deliberate direction as {@link reportAbandonedToolCalls}. A death in
 * the instant between a rewrite and its rename leaves the previous phase, at
 * most {@link HEARTBEAT_INTERVAL_MS} old, which `heartbeatAt` states. A heartbeat
 * beside its process's `exited` tombstone is a recorded exit whose last rewrite
 * landed late, and is removed without a report.
 */
export function reportSilentDeaths(): SessionHeartbeat[] {
	let names: string[];
	try {
		names = fs.readdirSync(heartbeatDir());
	} catch {
		return [];
	}
	const tombstones = new Set(
		names.filter(name => name.endsWith(".exited")).map(name => name.slice(0, -".exited".length)),
	);
	const dead: SessionHeartbeat[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const stem = name.slice(0, -".json".length);
		const file = path.join(heartbeatDir(), name);
		const beat = readHeartbeat(file);
		if (beat && isToolCallProcessAlive(beat.pid, beat.startIdentity)) continue;
		if (beat && !tombstones.has(stem)) {
			try {
				logger.errorSync("Previous session died silently", {
					pid: beat.pid,
					sessionId: beat.sessionId,
					phase: beat.phase,
					startedAt: beat.startedAt,
					heartbeatAt: beat.heartbeatAt,
					activeLanes: beat.activeLanes,
					lanes: beat.lanes,
				});
			} catch (error) {
				// Keep the evidence for a launch that can log it.
				logger.debug("Could not persist silent death report", { error: errorMessage(error) });
				continue;
			}
			dead.push(beat);
		}
		for (const leftover of [file, path.join(heartbeatDir(), `${stem}.exited`)]) {
			try {
				fs.rmSync(leftover, { force: true });
			} catch (error) {
				if (!isMissingPath(error)) {
					logger.debug("Could not remove session heartbeat", { error: errorMessage(error) });
				}
			}
		}
		tombstones.delete(stem);
	}
	// A tombstone whose heartbeat is already gone, left by a process that ended
	// between the two removals. Nothing to report; drop it once its pid is free.
	for (const stem of tombstones) {
		if (isProcessAlive(Number(stem))) continue;
		try {
			fs.rmSync(path.join(heartbeatDir(), `${stem}.exited`), { force: true });
		} catch (error) {
			logger.debug("Could not remove session heartbeat tombstone", { error: errorMessage(error) });
		}
	}
	return dead;
}
