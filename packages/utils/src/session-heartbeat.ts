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
 * It carries no user content: pid, session id, a phase name, lane counts,
 * memory counters and timestamps.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { type MemoryLimits, readMemoryLimits } from "./commit-memory";
import { installConsoleCtrlHandler, removeConsoleCtrlHandler } from "@veyyon/natives";
import { getLogsDir } from "./dirs";
import { isMissingPath } from "./fs-error";
import * as logger from "./logger";
import { getProcessStartIdentity, isProcessAlive, isToolCallProcessAlive } from "./process-liveness";
import { errorMessage } from "./type-guards";

const startupSmol =
	process.execArgv.includes("--smol") ||
	process.argv.includes("--smol") ||
	process.env.BUN_OPTIONS?.includes("--smol") === true;
const startupForceRAMSize = process.env.BUN_JSC_forceRAMSize || undefined;

/** What a session is doing, from the outside. */
export type SessionPhase = "provider" | "tool" | "compaction" | "idle";

/**
 * Upper bound between rewrites while nothing changes phase. Half the ten
 * seconds veyyon#73 asked for, so a write that lands late still keeps the
 * on-disk heartbeat inside that bound.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** Maximum number of historical resource snapshots retained in the heartbeat. */
export const MAX_RESOURCE_SAMPLES = 12;

/**
 * A point-in-time snapshot of memory and handle resources for trend analysis.
 */
export interface HeartbeatResourceSample {
	/** When this sample was recorded (ISO-8601 string). */
	at: string;
	/** Resident set size in bytes. */
	rssBytes: number;
	/** Free physical memory on the host in bytes. */
	freeMemBytes?: number;
	/** Allocated JavaScript heap in bytes. */
	heapTotal?: number;
	/** Actively used JavaScript heap in bytes. */
	heapUsed?: number;
	/** Memory allocated outside JavaScript tracking in bytes. */
	external?: number;
	/** Windows: committed bytes across the system. */
	commitChargeBytes?: number;
	/** Windows: system commit limit in bytes. */
	commitLimitBytes?: number;
	/** Windows: private committed bytes of this process (`PrivateUsage`). */
	processCommitBytes?: number;
	/** Open handle count for this process. */
	handleCount?: number;
	/** Linux: cgroup current memory usage in bytes. */
	cgroupMemoryBytes?: number;
	/** Linux: cgroup memory limit in bytes. */
	cgroupMemoryMaxBytes?: number;
}
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
	/**
	 * Resident set size of the writing process when this file was written. A
	 * process the operating system kills for want of memory leaves no trace of
	 * why; the last reading beside `freeMemBytes` is what separates that from a
	 * console or terminal closing under it (veyyon#73). Absent in files an older
	 * build wrote.
	 */
	rssBytes?: number;
	/** Free physical memory on the host when this file was written. */
	freeMemBytes?: number;
	/**
	 * Total size of the allocated JavaScript heap in bytes when this file was written.
	 * What separates host memory pressure from a per-process JSC heap ceiling (D04 abort).
	 */
	heapTotal?: number;
	/**
	 * Memory actively used by JavaScript objects in bytes when this file was written.
	 */
	heapUsed?: number;
	/**
	 * Memory allocated outside JavaScript that the engine is tracking.
	 */
	external?: number;
	/** Whether `--smol` was active at startup. */
	smol?: boolean;
	/** Value of `BUN_JSC_forceRAMSize` at startup, if set. */
	forceRAMSize?: string;
	/**
	 * Windows: committed bytes across the system when this file was written. The
	 * resource that runs out there is commit, not physical memory; "Out of Virtual
	 * Memory" arrives with RAM free (veyyon#73, D06).
	 */
	commitChargeBytes?: number;
	/** Windows: the system commit limit, RAM plus pagefile; allocation fails at it. */
	commitLimitBytes?: number;
	/** Windows: private committed bytes of the writing process (`PrivateUsage`). */
	processCommitBytes?: number;
	/** Open handle count for the writing process when this file was written. */
	handleCount?: number;
	/** File path where console control events are logged, if installed. */
	consoleLogPath?: string;
	/** Status of console control handler installation. */
	consoleCtrlStatus?: string;
	/** Whether the native console control handler is currently installed. */
	consoleCtrlInstalled?: boolean;
	/** Bounded periodic memory and handle snapshots recording resource trends over time. */
	resourceHistory?: HeartbeatResourceSample[];
	/**
	 * Linux: `memory.current` of the cgroup closest to its `memory.max`, the
	 * limit the kernel kills a process at. Absent without cgroup v2.
	 */
	cgroupMemoryBytes?: number;
	/** Linux: the tightest `memory.max` from the process's cgroup up to the root. */
	cgroupMemoryMaxBytes?: number;
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
let flushPromise: Promise<void> | undefined;

const resourceHistory: HeartbeatResourceSample[] = [];

interface ConsoleCtrlState {
	installed: boolean;
	status: string;
	path?: string;
}

let consoleCtrlState: ConsoleCtrlState | undefined;
let consoleCtrlAttempted = false;

let nativeInstallConsoleCtrl: typeof installConsoleCtrlHandler = installConsoleCtrlHandler;
let nativeRemoveConsoleCtrl: typeof removeConsoleCtrlHandler = removeConsoleCtrlHandler;

function ensureConsoleCtrlHandler(): ConsoleCtrlState | undefined {
	if (consoleCtrlAttempted) return consoleCtrlState;
	consoleCtrlAttempted = true;
	try {
		const logPath = path.join(heartbeatDir(), `${process.pid}.console.log`);
		try {
			fs.mkdirSync(heartbeatDir(), { recursive: true });
		} catch {}
		const res = nativeInstallConsoleCtrl(logPath);
		if (res && typeof res === "object") {
			consoleCtrlState = {
				installed: Boolean(res.installed),
				status: typeof res.status === "string" ? res.status : "unknown",
				path: res.path ?? (res.installed ? logPath : undefined),
			};
		}
	} catch (error) {
		logger.debug("Could not install console control handler", { error: errorMessage(error) });
		consoleCtrlState = {
			installed: false,
			status: "unavailable",
		};
	}
	return consoleCtrlState;
}

function safeRemoveConsoleCtrlHandler(): void {
	if (!consoleCtrlState?.installed) {
		consoleCtrlState = undefined;
		consoleCtrlAttempted = false;
		return;
	}
	try {
		nativeRemoveConsoleCtrl();
	} catch (error) {
		logger.debug("Could not remove console control handler", { error: errorMessage(error) });
	} finally {
		consoleCtrlState = undefined;
		consoleCtrlAttempted = false;
	}
}
/** Directory where session heartbeat files are recorded. */
export function heartbeatDir(): string {
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

function snapshot(limits: MemoryLimits): SessionHeartbeat | undefined {
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
	const mem = process.memoryUsage();
	const freeMem = os.freemem();
	const now = new Date().toISOString();
	const nowMs = Date.parse(now);

	const sample: HeartbeatResourceSample = {
		at: now,
		rssBytes: mem.rss,
		freeMemBytes: freeMem,
		heapTotal: mem.heapTotal,
		heapUsed: mem.heapUsed,
		external: mem.external,
		...(limits.commitChargeBytes !== undefined ? { commitChargeBytes: limits.commitChargeBytes } : {}),
		...(limits.commitLimitBytes !== undefined ? { commitLimitBytes: limits.commitLimitBytes } : {}),
		...(limits.processCommitBytes !== undefined ? { processCommitBytes: limits.processCommitBytes } : {}),
		...(limits.handleCount !== undefined ? { handleCount: limits.handleCount } : {}),
		...(limits.cgroupMemoryBytes !== undefined ? { cgroupMemoryBytes: limits.cgroupMemoryBytes } : {}),
		...(limits.cgroupMemoryMaxBytes !== undefined ? { cgroupMemoryMaxBytes: limits.cgroupMemoryMaxBytes } : {}),
	};

	const lastSample = resourceHistory[resourceHistory.length - 1];
	if (!lastSample || nowMs - Date.parse(lastSample.at) >= HEARTBEAT_INTERVAL_MS) {
		resourceHistory.push(sample);
		if (resourceHistory.length > MAX_RESOURCE_SAMPLES) {
			resourceHistory.splice(0, resourceHistory.length - MAX_RESOURCE_SAMPLES);
		}
	} else {
		resourceHistory[resourceHistory.length - 1] = sample;
	}
	const historyCopy = [...resourceHistory];
	return {
		pid: process.pid,
		startIdentity,
		sessionId: head.source.sessionId(),
		phase: head.phase,
		startedAt: head.since,
		heartbeatAt: now,
		activeLanes,
		lanes,
		rssBytes: mem.rss,
		freeMemBytes: freeMem,
		heapTotal: mem.heapTotal,
		heapUsed: mem.heapUsed,
		external: mem.external,
		...(startupSmol ? { smol: true } : {}),
		...(startupForceRAMSize !== undefined ? { forceRAMSize: startupForceRAMSize } : {}),
		...limits,
		...(consoleCtrlState?.path ? { consoleLogPath: consoleCtrlState.path } : {}),
		...(consoleCtrlState?.status ? { consoleCtrlStatus: consoleCtrlState.status } : {}),
		...(consoleCtrlState?.installed !== undefined ? { consoleCtrlInstalled: consoleCtrlState.installed } : {}),
		resourceHistory: historyCopy,
	};
}

async function flush(): Promise<void> {
	writing = true;
	try {
		while (dirty) {
			dirty = false;
			const record = snapshot(await readMemoryLimits());
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
	if (!writing) {
		flushPromise = flush();
	}
}

/** Await completion of all pending heartbeat writes for test synchrony. */
export async function _flushHeartbeatForTest(): Promise<void> {
	while (dirty || writing) {
		if (flushPromise) {
			await flushPromise;
		} else if (dirty) {
			flushPromise = flush();
			await flushPromise;
		}
	}
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
		ensureConsoleCtrlHandler();
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
			} finally {
				safeRemoveConsoleCtrlHandler();
				resourceHistory.length = 0;
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
		if (typeof beat.rssBytes !== "number") delete beat.rssBytes;
		if (typeof beat.freeMemBytes !== "number") delete beat.freeMemBytes;
		if (typeof beat.heapTotal !== "number") delete beat.heapTotal;
		if (typeof beat.heapUsed !== "number") delete beat.heapUsed;
		if (typeof beat.external !== "number") delete beat.external;
		if (typeof beat.smol !== "boolean") delete beat.smol;
		if (typeof beat.forceRAMSize !== "string") delete beat.forceRAMSize;
		if (typeof beat.commitChargeBytes !== "number") delete beat.commitChargeBytes;
		if (typeof beat.commitLimitBytes !== "number") delete beat.commitLimitBytes;
		if (typeof beat.processCommitBytes !== "number") delete beat.processCommitBytes;
		if (typeof beat.handleCount !== "number") delete beat.handleCount;
		if (typeof beat.consoleLogPath !== "string") delete beat.consoleLogPath;
		if (typeof beat.consoleCtrlStatus !== "string") delete beat.consoleCtrlStatus;
		if (typeof beat.consoleCtrlInstalled !== "boolean") delete beat.consoleCtrlInstalled;

		const rawHistory = Array.isArray(beat.resourceHistory) ? beat.resourceHistory : undefined;

		if (rawHistory) {
			const sanitized: HeartbeatResourceSample[] = [];
			for (const item of rawHistory) {
				if (typeof item !== "object" || item === null) continue;
				const sample = item as Partial<HeartbeatResourceSample>;
				if (typeof sample.at !== "string" || typeof sample.rssBytes !== "number") continue;
				const clean: HeartbeatResourceSample = {
					at: sample.at,
					rssBytes: sample.rssBytes,
				};
				if (typeof sample.freeMemBytes === "number") clean.freeMemBytes = sample.freeMemBytes;
				if (typeof sample.heapTotal === "number") clean.heapTotal = sample.heapTotal;
				if (typeof sample.heapUsed === "number") clean.heapUsed = sample.heapUsed;
				if (typeof sample.external === "number") clean.external = sample.external;
				if (typeof sample.commitChargeBytes === "number") clean.commitChargeBytes = sample.commitChargeBytes;
				if (typeof sample.commitLimitBytes === "number") clean.commitLimitBytes = sample.commitLimitBytes;
				if (typeof sample.processCommitBytes === "number") clean.processCommitBytes = sample.processCommitBytes;
				if (typeof sample.handleCount === "number") clean.handleCount = sample.handleCount;
				if (typeof sample.cgroupMemoryBytes === "number") clean.cgroupMemoryBytes = sample.cgroupMemoryBytes;
				if (typeof sample.cgroupMemoryMaxBytes === "number") clean.cgroupMemoryMaxBytes = sample.cgroupMemoryMaxBytes;
				sanitized.push(clean);
			}
			beat.resourceHistory = sanitized;
		} else {
			delete beat.resourceHistory;
		}

		if (typeof beat.cgroupMemoryBytes !== "number") delete beat.cgroupMemoryBytes;
		if (typeof beat.cgroupMemoryMaxBytes !== "number") delete beat.cgroupMemoryMaxBytes;
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
					rssBytes: beat.rssBytes,
					freeMemBytes: beat.freeMemBytes,
					heapTotal: beat.heapTotal,
					heapUsed: beat.heapUsed,
					external: beat.external,
					smol: beat.smol,
					forceRAMSize: beat.forceRAMSize,
					commitChargeBytes: beat.commitChargeBytes,
					commitLimitBytes: beat.commitLimitBytes,
					processCommitBytes: beat.processCommitBytes,
					cgroupMemoryBytes: beat.cgroupMemoryBytes,
					cgroupMemoryMaxBytes: beat.cgroupMemoryMaxBytes,
					handleCount: beat.handleCount,
					consoleLogPath: beat.consoleLogPath,
					consoleCtrlStatus: beat.consoleCtrlStatus,
					consoleCtrlInstalled: beat.consoleCtrlInstalled,
					resourceHistory: beat.resourceHistory,
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

/** Override native console control functions for deterministic testing. */
export function _setConsoleCtrlHandlerForTest(
	installer: typeof installConsoleCtrlHandler = installConsoleCtrlHandler,
	remover: typeof removeConsoleCtrlHandler = removeConsoleCtrlHandler,
): void {
	nativeInstallConsoleCtrl = installer;
	nativeRemoveConsoleCtrl = remover;
}

/** Reset in-memory heartbeat state for test isolation. */
export function _resetHeartbeatStateForTest(): void {
	participants.clear();
	if (interval) {
		clearInterval(interval);
		interval = undefined;
	}
	resourceHistory.length = 0;
	dirty = false;
	flushPromise = undefined;
	startIdentity = undefined;
	consoleCtrlState = undefined;
	consoleCtrlAttempted = false;
	nativeInstallConsoleCtrl = installConsoleCtrlHandler;
	nativeRemoveConsoleCtrl = removeConsoleCtrlHandler;
}
