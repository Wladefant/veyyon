/**
 * The session's event stream: the subscribers that receive each event, the extension forwarding every
 * session event passes through first, and the wire-level `agent_end` held back while a prompt is
 * still unwinding.
 *
 * This is a session collaborator. It holds the subscriber list, the extension forwarder and the held
 * `agent_end`, and reads the session only through {@link SessionEventsHost}.
 */
import { isPromise } from "node:util/types";
import { errorMessage, logger } from "@veyyon/utils";
import type { ExtensionRunner } from "../../extensibility/extensions";
import type { AgentSessionEvent, AgentSessionEventListener } from "../agent-session-types";
import { ExtensionEventForwarder } from "./extension-event-forwarder";

export interface SessionEventsHost {
	/** Whether a prompt is still unwinding; while one is, the wire-level `agent_end` is held. */
	promptInFlight(): boolean;
}

export class SessionEvents {
	/** The extension hooks every session event is forwarded to, and the turn index they count. */
	readonly extensions: ExtensionEventForwarder;
	readonly #host: SessionEventsHost;
	#listeners: AgentSessionEventListener[] = [];
	/**
	 * The wire-level `agent_end`, held until no prompt is in flight. Subscribers (rpc-mode stdout, the
	 * ACP bridge, Cursor exec, TUI listeners) treat `agent_end` as the idle signal, so emitting it
	 * while a prompt is unwinding lets a client send its next prompt into a session that still
	 * reports `isStreaming`. Extension hooks and the session's own settle work are not held. A later
	 * `agent_end` (an auto-compaction turn that starts before the first prompt unwinds) replaces the
	 * held one, since subscribers read only the final settle.
	 */
	#heldAgentEnd: AgentSessionEvent | undefined;

	constructor(runner: ExtensionRunner | undefined, host: SessionEventsHost) {
		this.extensions = new ExtensionEventForwarder(runner);
		this.#host = host;
	}

	/** Add a subscriber. Returns the function that removes this subscriber. */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index !== -1) this.#listeners.splice(index, 1);
		};
	}

	/**
	 * Deliver `event` to every subscriber and to no extension. A subscriber that throws or rejects is
	 * logged and the rest still receive the event.
	 */
	emit(event: AgentSessionEvent): void {
		// A copy, since a subscriber may unsubscribe while it runs.
		for (const listener of this.#listeners.slice()) {
			try {
				const result = listener(event) as unknown;
				// The returned promise of an async subscriber is not awaited, so its rejection is caught
				// here rather than surfacing as an unhandled rejection.
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", { error: errorMessage(err) });
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", { error: errorMessage(err) });
			}
		}
	}

	/**
	 * Forward `event` to the extension hooks, then deliver it to the subscribers. A `message_update`
	 * reaches the subscribers first and joins the extension queue that keeps stream deltas in order;
	 * an `agent_end` is held while a prompt is in flight (see {@link releaseHeldAgentEnd}).
	 */
	async send(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.emit(event);
			void this.extensions.enqueue(event);
			return;
		}
		await this.extensions.forward(event);
		if (event.type === "agent_end" && this.#host.promptInFlight()) {
			this.#heldAgentEnd = event;
			return;
		}
		this.emit(event);
	}

	/**
	 * {@link send} without waiting, for a caller that cannot wait on extension hooks: the TTSR paths,
	 * whose abort must happen at once. An extension that throws stops the event reaching the
	 * subscribers, so the failure is logged with `context` rather than lost.
	 */
	sendDetached(event: AgentSessionEvent, context: string): void {
		void this.send(event).catch((error: unknown) => {
			logger.warn("session event emit failed", { context, event: event.type, error: errorMessage(error) });
		});
	}

	/** Deliver the held `agent_end`, if one is held. The session calls this once no prompt is in flight. */
	releaseHeldAgentEnd(): void {
		const held = this.#heldAgentEnd;
		if (!held) return;
		this.#heldAgentEnd = undefined;
		this.emit(held);
	}

	/** Drop every subscriber. Dispose is the only caller. */
	clear(): void {
		this.#listeners = [];
	}
}
