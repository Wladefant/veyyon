/**
 * The `session_stop` hook pass at a final stop: the event a top-level session's extension handlers
 * receive, and the continuation a handler returns, queued as a hidden message that starts the next
 * turn.
 *
 * This is a session collaborator. It holds the length of the current continuation chain and reaches
 * the session only through {@link SessionStopHookHost}. A chain ends when a pass returns no
 * continuation, after {@link SESSION_STOP_CONTINUATION_CAP} continuations in a row, when an abort
 * or dispose lands during a pass, and on {@link SessionStopHook.reset}.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { logger } from "@veyyon/utils";
import type { ExtensionRunner, SessionStopEventResult } from "../../extensibility/extensions";
import type { CustomMessage } from "../messages";
import { SESSION_STOP_CONTINUATION_CAP } from "../nudges";

/** What {@link SessionStopHook} needs from the session that holds it. */
export interface SessionStopHookHost {
	/** Whether an abort is running or the session is disposed: a pass emits nothing and ends the chain. */
	isHalted(): boolean;
	/** The runner that emits `session_stop`, or undefined when no handler runs for this session. */
	stopHookRunner(): Pick<ExtensionRunner, "emitSessionStop"> | undefined;
	/** Bumped by each abort: a handler result that arrives after a bump is dropped. */
	promptGeneration(): number;
	/** The index of the turn that ended. */
	turnId(): number;
	sessionId(): string;
	sessionFile(): string | undefined;
	/** Queue `message` hidden for the next turn and start that turn. */
	queueContinuation(message: CustomMessage): void;
}

/** The model-visible text a handler result continues the session with, if it continues it. */
function sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
	if (!result) return undefined;
	const additionalContext =
		typeof result.additionalContext === "string" && result.additionalContext.length > 0
			? result.additionalContext
			: undefined;
	const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
	if (result.continue === true) {
		return additionalContext ?? reason;
	}
	if (result.decision === "block") {
		return reason ?? additionalContext;
	}
	return undefined;
}

export class SessionStopHook {
	readonly #host: SessionStopHookHost;
	/** Continuations queued in a row since the chain last ended; nonzero is `stop_hook_active`. */
	#continuations = 0;

	constructor(host: SessionStopHookHost) {
		this.#host = host;
	}

	/** End the current chain: the next pass reports `stop_hook_active: false`. */
	reset(): void {
		this.#continuations = 0;
	}

	/** Emit `session_stop` for a final stop that ended on `lastAssistantMessage`, and queue the continuation a handler returns. */
	async run(messages: AgentMessage[], lastAssistantMessage: AssistantMessage): Promise<void> {
		const host = this.#host;
		if (host.isHalted()) {
			this.#continuations = 0;
			return;
		}
		const runner = host.stopHookRunner();
		if (!runner) return;
		const generation = host.promptGeneration();
		const result = await runner.emitSessionStop({
			messages,
			turn_id: host.turnId(),
			last_assistant_message: lastAssistantMessage,
			session_id: host.sessionId(),
			session_file: host.sessionFile(),
			stop_hook_active: this.#continuations > 0,
		});
		if (host.promptGeneration() !== generation || host.isHalted()) {
			this.#continuations = 0;
			return;
		}
		const additionalContext = sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#continuations = 0;
			return;
		}
		if (this.#continuations >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: host.sessionId(),
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#continuations = 0;
			return;
		}
		this.#continuations++;
		host.queueContinuation({
			role: "custom",
			customType: "session-stop-continuation",
			content: additionalContext,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}
}
