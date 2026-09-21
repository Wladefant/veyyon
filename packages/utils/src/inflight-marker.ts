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
 * a file. Each tool call overwrites a small marker naming itself; finishing the
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

import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "./dirs";
import { isMissingPath } from "./fs-error";
import * as logger from "./logger";
import { getProcessStartIdentity, isProcessInstanceAlive } from "./process-liveness";
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
	 * {@link isProcessInstanceAlive} reads as live.
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

/** The marker path for one process. One file per pid, overwritten per call. */
function markerPath(pid: number): string {
	return path.join(markerDir(), `${pid}.json`);
}

/** The call this process most recently marked, so clearing can match on it. */
let currentToolCallId: string | null = null;

/**
 * Record that this process has entered `call`. Overwrites any previous marker:
 * a process is inside at most one tool call at a time as far as a postmortem
 * cares, and the newest one is the one a native abort happened under.
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
		fs.writeFileSync(markerPath(process.pid), `${JSON.stringify(marker)}\n`, "utf8");
		currentToolCallId = call.toolCallId;
	} catch (error) {
		// A marker that cannot be written costs a future postmortem its attribution and
		// nothing else. Failing the tool call over it would turn a diagnostic aid into a
		// new way to break the session.
		logger.debug("Could not write in-flight tool call marker", { error: errorMessage(error) });
	}
}

/**
 * Drop this process's marker once `toolCallId` has finished.
 *
 * Scoped to the call that wrote the marker so an overlapping completion cannot
 * clear a newer call's marker and leave the process looking idle while it is
 * still inside one. Pass no id to clear unconditionally, which is what a
 * recorded session exit does.
 */
export function clearToolCallInFlight(toolCallId?: string): void {
	if (toolCallId !== undefined && toolCallId !== currentToolCallId) return;
	currentToolCallId = null;
	try {
		fs.rmSync(markerPath(process.pid));
	} catch (error) {
		if (!isMissingPath(error)) {
			logger.debug("Could not clear in-flight tool call marker", { error: errorMessage(error) });
		}
	}
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
		// A marker written by a process that died mid-write is truncated JSON. It
		// still proves a death, but it cannot name the call, so it is swept rather
		// than reported: a report with no tool name is noise a reader cannot act on.
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
		if (marker && isProcessInstanceAlive(marker.pid, marker.startIdentity)) continue;
		if (marker) {
			abandoned.push({
				toolCallId: marker.toolCallId,
				toolName: marker.toolName,
				sessionId: marker.sessionId,
			});
			logger.error("Previous session died with a tool call in flight", {
				pid: marker.pid,
				toolName: marker.toolName,
				toolCallId: marker.toolCallId,
				sessionId: marker.sessionId,
				startedAt: marker.startedAt,
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
