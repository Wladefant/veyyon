/**
 * What the transcript records so a later reader learns how the session ended: a marker for every
 * tool execution as it starts, and one `session_exit` entry naming why the session ended, how (a
 * normal close, a fatal error, a process exit or a signal) and the tool calls it left without a
 * result.
 *
 * This is a session collaborator. A signal, a fatal error or a process exit runs the process
 * cleanup callbacks and may never reach `dispose()`, so the record registers its own callback with
 * `postmortem` when it is built; {@link ExitRecord.close} writes the record for a dispose and
 * withdraws that callback. The entry is written once, by whichever path reaches it first. It
 * reaches the session only through {@link ExitRecordHost}.
 */
import type { AgentEvent } from "@veyyon/agent-core";
import {
	assistantRecordsToolCall,
	collectPendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	sessionExitLogLevel,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@veyyon/kernel/session/exit-diagnostics";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger, postmortem } from "@veyyon/utils";

/** The transcript the markers and the exit entry are read from and written to. */
export type ExitRecordStore = Pick<
	SessionManager,
	| "appendCustomEntry"
	| "flushSync"
	| "getBranch"
	| "getEntries"
	| "getEntry"
	| "getLeafEntry"
	| "getSessionFile"
	| "getSessionId"
>;

/** What {@link ExitRecord} needs from the session that holds it. */
export interface ExitRecordHost {
	sessionStore: ExitRecordStore;
	/** `text` with every secret replaced by its placeholder, as the provider is sent it. */
	redact(text: string): string;
}

/** Why a session ended: the process teardown that ran, or a `dispose()` that named none. */
export type SessionExitReason = postmortem.Reason | "dispose";

export class ExitRecord {
	readonly #host: ExitRecordHost;
	#written = false;
	#withdrawProcessCallback: (() => void) | undefined;

	constructor(host: ExitRecordHost) {
		this.#host = host;
		this.#withdrawProcessCallback = postmortem.register(
			`agent-session:${host.sessionStore.getSessionId()}`,
			reason => {
				this.#write(reason);
			},
		);
	}

	/**
	 * Record the start of a tool execution in the session file.
	 *
	 * The arguments and intent are REDACTED, because `event.args` and the intent are post-expansion.
	 * The assistant message holds the placeholder the model wrote; this event holds what the tool was
	 * handed, which for `#GITHUB_TOKEN#` is the credential itself. The session file must never contain
	 * it: the vault is encrypted at rest and this entry sits beside it in the same directory, and it
	 * travels through `/share` and exports. The intent goes through the same redactor because the
	 * model can quote an argument back into it.
	 */
	recordToolStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		const store = this.#host.sessionStore;
		// The entry's timestamp is the start time, so the marker includes none of its own.
		const data: ToolExecutionStartData = { toolCallId: event.toolCallId, toolName: event.toolName };
		const redact = (text: string): string => this.#host.redact(text);
		// The command/path projection the resume warning renders, written only when no assistant
		// message on the branch records the call yet: a Cursor server-side call, or a crash before the
		// assistant message reached the file. Otherwise the warning reads that message's arguments.
		const recorded = assistantRecordsToolCall(store.getLeafEntry(), id => store.getEntry(id), event.toolCallId);
		const args = recorded ? undefined : summarizeToolArguments(event.args, redact);
		if (args) data.args = args;
		if (event.intent) data.intent = redact(event.intent);
		store.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
	}

	/**
	 * Write the exit entry for a dispose and withdraw the process callback, so a later teardown of
	 * the process neither writes a second entry nor keeps the closed session reachable.
	 */
	close(reason: SessionExitReason): void {
		this.#write(reason);
		this.#withdrawProcessCallback?.();
		this.#withdrawProcessCallback = undefined;
	}

	#write(reason: SessionExitReason): void {
		if (this.#written) return;
		this.#written = true;
		const store = this.#host.sessionStore;
		const pendingToolCalls = collectPendingToolCalls(store.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!store.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			store.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			store.flushSync();
			// Looked up on `logger` at call time, not captured in a table: the level is the
			// method name, and a captured function would also detach the spy a test installs.
			logger[sessionExitLogLevel(kind, pendingToolCalls.length)]("Session exit recorded", {
				sessionId: store.getSessionId(),
				sessionFile: store.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: store.getSessionId(),
				sessionFile: store.getSessionFile(),
				reason,
				error: errorMessage(error),
			});
		}
	}
}
