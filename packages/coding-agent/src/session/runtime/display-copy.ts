/**
 * Display copy: the form of the session's content a person reads, with secrets deobfuscated and Argot
 * handles expanded, composed in that order.
 *
 * This is a session collaborator. It holds the Argot decoder of the assistant message streaming now
 * and reaches the session through {@link DisplayCopyHost}.
 *
 * Stored messages keep the obfuscated placeholders and the cheap handles: that is the token saving
 * and the persistence contract. Every surface that shows content to a person reads it through here,
 * so an operator never sees a raw `#HASH#` secret token or a bare `§handle`:
 * - **A finished assistant message** ({@link DisplayCopy.assistantContent}): the `message_end`
 *   display event, the interactive fan-out and `--print`.
 * - **A tool call's intent** ({@link DisplayCopy.toolIntent}), which travels outside the arguments.
 * - **A streamed delta** ({@link DisplayCopy.streamUpdate}), decoded between
 *   {@link DisplayCopy.startStream} and {@link DisplayCopy.endStream}.
 * - **A rebuilt transcript** ({@link DisplayCopy.sessionContext}, {@link DisplayCopy.transcriptContext})
 *   and entries a viewer parsed off disk ({@link DisplayCopy.expandEntries}).
 *
 * Every method is on a display or render path: each degrades per string and never throws.
 */
import type { AgentEvent } from "@veyyon/agent-core";
import type { SessionMessageEntry } from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";
import type { BuildSessionContextOptions, SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ArgotSession } from "argot";
import {
	ArgotStreamDisplayDecoder,
	expandAssistantContent,
	expandSessionContext,
	expandSessionMessageEntries,
} from "../../argot-wire";
import { mapAssistantContentStrings } from "../../secrets/obfuscator";
import type { SessionSecrets } from "./session-secrets";

type MessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;

/** What display copy reads from the session. */
export interface DisplayCopyHost {
	/** The session's Argot codec, or `undefined` when the feature is off. */
	readonly argot: ArgotSession | undefined;
	readonly secrets: Pick<
		SessionSecrets,
		"displayExpander" | "expandForDisplay" | "deobfuscateSessionContextForDisplay"
	>;
	/** The transcript the display contexts are rebuilt from. */
	readonly sessionStore: Pick<SessionManager, "buildSessionContext">;
}

export class DisplayCopy {
	readonly #host: DisplayCopyHost;
	/** The decoder of the assistant message streaming now; a handle can split across deltas. */
	#streamDecoder: ArgotStreamDisplayDecoder | undefined;

	constructor(host: DisplayCopyHost) {
		this.#host = host;
	}

	/** Assistant message content in display form; the same reference when neither transform applies. */
	assistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		const expand = this.#host.secrets.displayExpander();
		let out =
			expand === undefined ? content : mapAssistantContentStrings(content, expand, { includeToolMetadata: true });
		const argot = this.#host.argot;
		if (argot?.loaded) {
			out = expandAssistantContent(argot, out);
		}
		return out;
	}

	/**
	 * A tool call's intent in display form, through the same two transforms as its content.
	 *
	 * The intent is a sentence the MODEL wrote about what it is doing, and the interactive working
	 * line puts it on screen the moment the call starts: a person reads "Reading src/db.ts to check
	 * the schema", never "Reading §db …". It needs its own pass because it is lifted out of the
	 * arguments before the argument transform runs, and the `tool_execution_start` event carries it
	 * verbatim.
	 */
	toolIntent(intent: string | undefined): string | undefined {
		if (intent === undefined || intent === "") return intent;
		let out = this.#host.secrets.expandForDisplay(intent);
		const argot = this.#host.argot;
		if (argot?.loaded) {
			out = argot.expand(out);
		}
		return out;
	}

	/**
	 * Start decoding an assistant message's stream. The live preview re-renders the accumulated
	 * partial, and a handle can split across deltas, so text and thinking blocks render only text
	 * the decoder has proved.
	 */
	startStream(): void {
		this.#streamDecoder = new ArgotStreamDisplayDecoder(this.#host.argot);
	}

	/** The message finished and expands wholesale; drop the stream state. */
	endStream(): void {
		this.#streamDecoder?.flush();
		this.#streamDecoder = undefined;
	}

	/**
	 * The display copy of a streamed assistant delta. The whole stream event is decoded, not only the
	 * accumulated content: a machine consumer that reconstructs text from the delta stream alone
	 * (print `--mode json`) must never see a raw §handle, and neither must one reading the event's
	 * own `partial`, `content` or `toolCall` payload. The decoded increments sum to the same decoded
	 * content `decodeContent` exposes, so every view agrees and reconciles with the wholesale-expanded
	 * `message_end` message.
	 */
	streamUpdate(event: MessageUpdateEvent): MessageUpdateEvent {
		const decoder = this.#streamDecoder;
		if (decoder === undefined || event.message.role !== "assistant") return event;
		const streamEvent = event.assistantMessageEvent;
		const assistantMessageEvent = decoder.decodeStreamEvent(streamEvent);
		const streamedContent = decoder.decodeContent(event.message.content);
		const contentChanged = streamedContent !== event.message.content;
		if (!contentChanged && assistantMessageEvent === streamEvent) return event;
		return {
			...event,
			message: contentChanged ? { ...event.message, content: streamedContent } : event.message,
			assistantMessageEvent,
		};
	}

	/**
	 * The session context for display. Also the agent-state rebuild after a compaction, a history
	 * rewrite or a session switch, so a throw here would fail the session, not one render.
	 */
	sessionContext(): SessionContext {
		return this.#expandArgot(
			this.#host.secrets.deobfuscateSessionContextForDisplay(this.#host.sessionStore.buildSessionContext()),
		);
	}

	/**
	 * The transcript for TUI display, run on every repaint. Display only: never feed the result to
	 * `agent.replaceMessages` or a provider.
	 */
	transcriptContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return this.#expandArgot(
			this.#host.secrets.deobfuscateSessionContextForDisplay(
				this.#host.sessionStore.buildSessionContext({
					transcript: true,
					collapseCompactedHistory: options?.collapseCompactedHistory,
					keepDanglingToolCalls: options?.keepDanglingToolCalls,
				}),
			),
		);
	}

	/** Argot handles expanded across transcript entries a viewer parsed off disk. */
	expandEntries(entries: SessionMessageEntry[]): SessionMessageEntry[] {
		const argot = this.#host.argot;
		return argot?.loaded ? expandSessionMessageEntries(argot, entries) : entries;
	}

	/** Argot handles expanded across a rebuilt transcript, after secret deobfuscation. */
	#expandArgot(context: SessionContext): SessionContext {
		const argot = this.#host.argot;
		return argot?.loaded ? expandSessionContext(argot, context) : context;
	}
}
