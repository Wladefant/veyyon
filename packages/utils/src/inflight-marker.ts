/**
 * Liveness marker for the tool call a process is currently inside.
 *
 * A session that exits through JavaScript — normally, on a signal, or on a
 * fatal exception — writes a `session_exit` entry naming any tool call left
 * pending. A session terminated BELOW JavaScript writes nothing: no exit
 * record, no error line, no Windows Error Reporting entry. The log simply
 * stops, and the next launch has no way to say what the dead process was doing
 * (veyyon#73, where two of three deaths left no exit record at all).
 *
 * This module closes that gap with the one thing a dead process leaves behind:
 * a file. Each tool call owns a small marker naming itself; finishing the
 * call, and recording a session exit, remove it. A marker still on disk whose
 * process is gone therefore means exactly one thing — that process died inside
 * that tool call without reaching JavaScript exit — and {@link
 * reportAbandonedToolCalls} turns it into the `error` line the log never got.
 *
 * It carries no user content: the tool name, the call and session ids, the pid
 * and two timestamps. Arguments stay out deliberately, because this file sits
 * in the logs directory unencrypted and the redaction that guards the session
 * entry does not apply here.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { getLogsDir } from "./dirs";
import { isMissingPath } from "./fs-error";
import * as logger from "./logger";
import { getProcessStartIdentity, isToolCallProcessAlive } from "./process-liveness";
import { errorMessage } from "./type-guards";

/** What a marker records about the call a process is inside. */
export interface InFlightToolCall {
	/** Tool call id, as the session file and the resume warning spell it. */
	toolCallId: string;
	/** Tool name, e.g. `bash`. */
	toolName: string;
	/** Session the call belongs to, so the transcript can be found. */
	sessionId: string;
}

interface InFlightMarker extends InFlightToolCall {
	pid: number;
	/**
	 * Boot + start identity of the marking process, so a pid the operating
	 * system has since handed to somebody else is not mistaken for the session
	 * that wrote this. `null` on a platform that cannot prove incarnation, which
	 * {@link isToolCallProcessAlive} reads as live unless death is proven.
	 */
	startIdentity: string | null;
	startedAt: string;
}

/**
 * Markers live beside the logs rather than in them: the day's log is an append
 * stream a crashed process cannot retract a line from, and a marker's whole
 * point is that it disappears when the call completes.
 */
function markerDir(): string {
	return path.join(getLogsDir(), "inflight");
}

/** Bound Windows path length and exclude provider identifiers from path syntax. */
function markerPath(pid: number, sessionId: string, toolCallId: string): string {
	const key = createHash("sha256")
		.update(JSON.stringify([sessionId, toolCallId]))
		.digest("base64url");
	return path.join(markerDir(), `${pid}-${key}.json`);
}

const currentToolCallIds = new Map<string, Set<string>>();

/**
 * Record each concurrent call independently, so completing one cannot erase another.
 *
 * Best-effort and synchronous. Synchronous because the failure this exists for
 * gives no later turn of the event loop in which a queued write could land.
 */
export function markToolCallInFlight(call: InFlightToolCall): void {
	const marker: InFlightMarker = {
		...call,
		pid: process.pid,
		startIdentity: getProcessStartIdentity(process.pid),
		startedAt: new Date().toISOString(),
	};
	try {
		fs.mkdirSync(markerDir(), { recursive: true });
		atomicWriteFileSync(markerPath(process.pid, call.sessionId, call.toolCallId), `${JSON.stringify(marker)}\n`);
		let ids = currentToolCallIds.get(call.sessionId);
		if (!ids) {
			ids = new Set();
			currentToolCallIds.set(call.sessionId, ids);
		}
		ids.add(call.toolCallId);
	} catch (error) {
		// A marker that cannot be written costs a future postmortem its attribution and
		// nothing else. Failing the tool call over it would turn a diagnostic aid into a
		// new way to break the session.
		logger.debug("Could not write in-flight tool call marker", { error: errorMessage(error) });
	}
}

/**
 * Drop only the completed call's marker, or this session's calls on recorded exit.
 */
export function clearToolCallInFlight(sessionId: string, toolCallId?: string): void {
	const pending = currentToolCallIds.get(sessionId);
	if (!pending) return;
	const ids = toolCallId === undefined ? pending : [toolCallId];
	for (const id of ids) {
		try {
			fs.rmSync(markerPath(process.pid, sessionId, id), { force: true });
			pending.delete(id);
		} catch (error) {
			logger.debug("Could not clear in-flight tool call marker", { error: errorMessage(error) });
		}
	}
	if (pending.size === 0) currentToolCallIds.delete(sessionId);
}

function readMarker(file: string): InFlightMarker | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const marker = parsed as Partial<InFlightMarker>;
		if (
			typeof marker.pid !== "number" ||
			typeof marker.toolCallId !== "string" ||
			typeof marker.toolName !== "string" ||
			typeof marker.sessionId !== "string" ||
			typeof marker.startedAt !== "string"
		) {
			return undefined;
		}
		if (typeof marker.startIdentity !== "string") marker.startIdentity = null;
		return marker as InFlightMarker;
	} catch {
		// Invalid legacy markers cannot name a call; atomic publication prevents partial new markers.
		return undefined;
	}
}

/**
 * Log one `error` line per tool call a previous process died inside, then
 * remove its marker. Called once at session start, before any new marker is
 * written, so the report is of deaths and never of this process.
 *
 * Returns the reported calls, in file order, for callers that surface them.
 *
 * WHAT IT CANNOT SEE: a process whose incarnation cannot be proven — an
 * unreadable process record, or a platform {@link getProcessStartIdentity}
 * does not cover — and whose pid the operating system has since handed to
 * somebody else. Its marker reads as live and is left for the next launch
 * rather than reported. That direction is deliberate: a missed report costs
 * one line of evidence, whereas reporting a live session as dead would put a
 * false crash in the log on every pid collision.
 */
export function reportAbandonedToolCalls(): InFlightToolCall[] {
	let files: string[];
	try {
		files = fs.readdirSync(markerDir()).filter(name => name.endsWith(".json"));
	} catch {
		return [];
	}
	const abandoned: InFlightToolCall[] = [];
	for (const name of files) {
		const file = path.join(markerDir(), name);
		const marker = readMarker(file);
		if (marker && isToolCallProcessAlive(marker.pid, marker.startIdentity)) continue;
		if (marker) {
			try {
				logger.errorSync("Previous session died with a tool call in flight", {
					pid: marker.pid,
					toolName: marker.toolName,
					toolCallId: marker.toolCallId,
					sessionId: marker.sessionId,
					startedAt: marker.startedAt,
				});
			} catch (error) {
				logger.debug("Could not persist abandoned tool call report", { error: errorMessage(error) });
				continue;
			}
			abandoned.push({
				toolCallId: marker.toolCallId,
				toolName: marker.toolName,
				sessionId: marker.sessionId,
			});
		}
		try {
			fs.rmSync(file);
		} catch (error) {
			if (!isMissingPath(error)) {
				logger.debug("Could not remove in-flight tool call marker", { error: errorMessage(error) });
			}
		}
	}
	return abandoned;
}
