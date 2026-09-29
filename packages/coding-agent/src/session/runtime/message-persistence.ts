/**
 * Message persistence: how a live message reaches the session log, in order and at most once.
 *
 * This is a session collaborator. It holds the `message_end` write queue, the in-flight write per
 * message, and the persistence-key index of the current branch, and reaches the session only
 * through {@link MessagePersistenceHost}.
 *
 * - **The write queue** ({@link openSlot}, {@link persistMessageEnd}) writes finished messages in
 *   the order their `message_end` events arrived, even when an earlier write is still awaiting its
 *   turn. {@link waitFor} lets a later pass wait until a message's entry exists.
 * - **The key index** answers "is this message already on the branch?" in O(1). It is memoized
 *   against a (session file, leaf id) anchor, so every branch mutation (rewind, branch switch, new
 *   session, custom-entry append) invalidates it without a call site having to remember to.
 * - **The write** ({@link persistIfMissing}) strips telemetry the instrumentation level does not
 *   allow, drops classifier refusals and empty error turns, stamps the assistant's context
 *   snapshot, and appends only when the branch does not already hold the same message.
 */
import type { AgentMessage, AgentTurnEndContext } from "@veyyon/agent-core";
import { calculatePromptTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, MessageAttribution, TextContent } from "@veyyon/ai";
import {
	assistantTurnMetricsForPersistence,
	assistantTurnRequestForPersistence,
	type InstrumentationLevel,
	instrumentationRank,
	sessionTelemetryDetail,
	toolCallMetricsForPersistence,
} from "@veyyon/ai/instrumentation";
import { getLatestCompactionEntry } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { logger } from "@veyyon/utils";
import { TOOL } from "../../tools/core/builtin-names";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../tools/shell/execution-messages";
import { isSameAssistantMessage } from "../agent-session-message-shapes";
import type { MessageEndPersistenceSlot, PendingContextSnapshot } from "../agent-session-types";
import { buildContextSnapshot, estimateContextSnapshotAttribution } from "../context-usage";
import { isClassifierRefusal } from "../failed-turn";
import {
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
} from "../messages";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "../turn-persistence";

/** A message the session log stores as a message entry. */
export type PersistableSessionMessage =
	| Message
	| CustomMessage
	| HookMessage
	| BashExecutionMessage
	| PythonExecutionMessage
	| FileMentionMessage;

/** The session log slice persistence reads and writes. `SessionManager` satisfies this. */
export interface MessagePersistenceStore {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getBranch(): SessionEntry[];
	appendMessage(message: PersistableSessionMessage): string;
	appendCustomMessageEntry(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: unknown,
		attribution?: MessageAttribution,
	): string;
	branch(branchFromId: string): void;
	resetLeaf(): void;
}

/** What {@link MessagePersistence} needs from the session that holds it. */
export interface MessagePersistenceHost {
	readonly sessionStore: MessagePersistenceStore;
	/** `session.instrumentation` as of now: a level written mid-session applies to the next write. */
	instrumentationLevel(): InstrumentationLevel;
	/** The prompt accounting of the run in flight, if one is. */
	pendingContextSnapshot(): PendingContextSnapshot | undefined;
	/** Tokens the prompt spends outside the message list: system prompt and tool schemas. */
	nonMessageTokens(): number;
	/** True once for a rewind tool result whose rewind already rewrote the branch. */
	consumeRewoundResult(toolCallId: string): boolean;
	/** A `ttsr-injection` custom message reached the log. */
	onTtsrInjectionPersisted(details: unknown): void;
}

/** The persistence-key index of one branch, valid while the anchor matches. */
interface PersistedKeyIndex {
	anchor: string;
	keys: Set<string>;
}

export class MessagePersistence {
	readonly #host: MessagePersistenceHost;
	#tail: Promise<void> = Promise.resolve();
	readonly #pending = new Map<string, Promise<void>>();
	#index: PersistedKeyIndex | undefined;

	constructor(host: MessagePersistenceHost) {
		this.#host = host;
	}

	/**
	 * Reserve a message's place in the write queue before its `message_end` display event runs, so
	 * a pass that waits on the message sees the write as pending. Returns `undefined` for a message
	 * with no persistence key: those write through {@link persistMessageEnd} without queueing.
	 */
	openSlot(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#tail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pending.get(key) === promise) {
				this.#pending.delete(key);
			}
		};
		this.#pending.set(key, promise);
		// `promise` is handed to the slot's caller and carries the failure; the tail only orders the
		// next message's write and must not inherit the rejection.
		this.#tail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	/** Resolves once the queued write of {@link message} finished, or at once when none is queued. */
	async waitFor(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pending.get(key);
	}

	/**
	 * Write a finished message to the session log, behind any earlier message still being written.
	 * Custom and hook messages become custom-message entries; bash, python, compaction and branch
	 * summaries are written elsewhere. The interrupted-thinking continuity message, when present,
	 * is appended after the message it continues.
	 */
	async persistMessageEnd(
		message: AgentMessage,
		slot: MessageEndPersistenceSlot | undefined,
		interruptedThinkingMessage: CustomMessage<InterruptedThinkingDetails> | undefined,
	): Promise<void> {
		const store = this.#host.sessionStore;
		const persist = () => {
			if (message.role === "hookMessage" || message.role === "custom") {
				store.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
					message.attribution ?? "agent",
				);
				if (message.role === "custom" && message.customType === "ttsr-injection") {
					this.#host.onTtsrInjectionPersisted(message.details);
				}
			} else {
				this.persistIfMissing(message);
			}
		};
		if (slot) {
			await slot.persist(persist);
		} else {
			persist();
		}
		if (interruptedThinkingMessage) {
			store.appendCustomMessageEntry(
				interruptedThinkingMessage.customType,
				interruptedThinkingMessage.content,
				interruptedThinkingMessage.display,
				interruptedThinkingMessage.details,
				interruptedThinkingMessage.attribution,
			);
		}
	}

	/**
	 * True when {@link message} is structurally identical to a message already on the current
	 * branch. The key index answers the common missing-key case; the branch is walked only to
	 * compare content when a key hit could be a collision.
	 */
	alreadyPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		if (!this.#keys().has(key)) return false;
		const branch = this.#host.sessionStore.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			if (sessionMessagePersistenceKey(entry.message) !== key) continue;
			if (sameMessageContent(entry.message, message)) return true;
		}
		return false;
	}

	/** Append a message entry, keeping a fresh key index fresh instead of letting it rebuild. */
	append(message: PersistableSessionMessage): string {
		const index = this.#index;
		const wasFresh = index !== undefined && index.anchor === this.#anchor();
		const entryId = this.#host.sessionStore.appendMessage(message);
		const key = sessionMessagePersistenceKey(message);
		if (wasFresh && index && key) {
			index.keys.add(key);
			index.anchor = this.#anchor();
		}
		return entryId;
	}

	/**
	 * Append {@link message} unless the branch already holds it. Only user, developer, assistant,
	 * tool result and file mention messages persist here. A rewind tool result whose rewind already
	 * rewrote the branch is not appended.
	 */
	persistIfMissing(message: AgentMessage): void {
		if (
			message.role !== "user" &&
			message.role !== "developer" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "fileMention"
		) {
			return;
		}
		let persistenceMessage = message;
		if (message.role === "toolResult" && message.metrics !== undefined) {
			const metrics = toolCallMetricsForPersistence(message.metrics, this.#host.instrumentationLevel());
			if (metrics === undefined) {
				const { metrics: _discardedMetrics, ...withoutMetrics } = message;
				persistenceMessage = withoutMetrics;
			} else {
				persistenceMessage = { ...message, metrics };
			}
		}
		if (message.role === "assistant") {
			const level = this.#host.instrumentationLevel();
			const turnMetrics = assistantTurnMetricsForPersistence(message.turnMetrics, level);
			const request = assistantTurnRequestForPersistence(message.request, level);
			const { turnMetrics: _discardedTurnMetrics, request: _discardedRequest, ...withoutStudyTelemetry } = message;
			persistenceMessage = {
				...withoutStudyTelemetry,
				...(turnMetrics === undefined ? {} : { turnMetrics }),
				...(request === undefined ? {} : { request }),
			};
		}
		if (this.alreadyPersisted(persistenceMessage)) return;
		if (message.role === "assistant") {
			const assistantMessage = persistenceMessage as AssistantMessage;
			if (isClassifierRefusal(assistantMessage)) return;
			if (isEmptyErrorTurn(assistantMessage)) return;
			this.#stampContextSnapshot(assistantMessage);
		}
		const skipPersistedRewindResult =
			message.role === "toolResult" &&
			message.toolName === TOOL.rewind &&
			this.#host.consumeRewoundResult(message.toolCallId);
		if (!skipPersistedRewindResult) {
			this.append(persistenceMessage);
		}
	}

	/**
	 * Make sure a finished turn is on the branch before mid-run compaction reads it. Waits for the
	 * turn's queued writes, then appends what is still missing. Returns false, and writes nothing,
	 * when the branch holds a later message of the turn but not an earlier one: compacting then
	 * would summarize a branch whose order differs from the live context.
	 *
	 * The ordering check uses key identity alone: a persisted display variant of a message (for
	 * example, redacted content) still counts as that message.
	 */
	async persistTurnForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const turnMessages = [context.message, ...context.toolResults];
		for (const message of turnMessages) {
			await this.waitFor(message);
		}
		const branchKeys = this.#keys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (const key of turnKeys) {
			if (key !== undefined && branchKeys.has(key)) persistedKeys.add(key);
		}
		const plan = planTurnPersistence(turnKeys, persistedKeys);
		if (plan.kind === "out-of-order") {
			const message = turnMessages[plan.messageIndex];
			logger.debug("Skipping mid-run compaction because turn persistence is out of order", {
				role: message.role,
				timestamp: message.timestamp,
			});
			return false;
		}
		for (const index of plan.toPersist) {
			this.persistIfMissing(turnMessages[index]);
		}
		return true;
	}

	/**
	 * True when the latest compaction entry on the current branch sits after
	 * {@link assistantMessage}'s own entry, i.e. the assistant was kept through that compaction and
	 * its `usage` describes the pre-rewrite prompt. A message that is not on the branch predates
	 * nothing.
	 */
	assistantPredatesLatestCompaction(assistantMessage: AssistantMessage): boolean {
		const key = sessionMessagePersistenceKey(assistantMessage);
		const branch = this.#host.sessionStore.getBranch();
		let compactionSeen = false;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "compaction") {
				compactionSeen = true;
				continue;
			}
			if (entry.type !== "message" || key === undefined) continue;
			if (sessionMessagePersistenceKey(entry.message) === key) return compactionSeen;
		}
		return false;
	}

	/**
	 * Move the branch leaf to the parent of {@link assistantMessage}'s latest entry, so the turn does
	 * not resurface on reload. No-op when the branch does not hold the message.
	 */
	dropAssistantFromBranch(assistantMessage: AssistantMessage): void {
		const store = this.#host.sessionStore;
		const branch = store.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (!isSameAssistantMessage(entry.message, assistantMessage)) continue;
			if (entry.parentId === null) {
				store.resetLeaf();
			} else {
				store.branch(entry.parentId);
			}
			return;
		}
	}

	#anchor(): string {
		const store = this.#host.sessionStore;
		return `${store.getSessionFile() ?? ""}\u0000${store.getLeafId() ?? ""}`;
	}

	#keys(): Set<string> {
		const anchor = this.#anchor();
		let index = this.#index;
		if (index === undefined || index.anchor !== anchor) {
			const keys = new Set<string>();
			for (const entry of this.#host.sessionStore.getBranch()) {
				if (entry.type !== "message") continue;
				const key = sessionMessagePersistenceKey(entry.message);
				if (key !== undefined) keys.add(key);
			}
			index = { anchor, keys };
			this.#index = index;
		}
		return index.keys;
	}

	/**
	 * Record on a completed assistant turn how many prompt tokens it spent and where they went.
	 * The detail is the lower of the level the run started at and the level now, so a level
	 * raised mid-run cannot claim attribution the run never measured.
	 */
	#stampContextSnapshot(message: AssistantMessage): void {
		if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) return;
		const pending = this.#host.pendingContextSnapshot();
		const nonMessageTokens = pending?.nonMessageTokens ?? this.#host.nonMessageTokens();
		const currentDetail = sessionTelemetryDetail(this.#host.instrumentationLevel(), "context-breakdown");
		const detail =
			!pending || pending.detail === "none" || currentDetail === "none"
				? "none"
				: instrumentationRank(pending.detail) < instrumentationRank(currentDetail)
					? pending.detail
					: currentDetail;
		if (detail !== "rich" && detail !== "ultra") {
			message.contextSnapshot = {
				promptTokens: calculatePromptTokens(message.usage),
				nonMessageTokens,
			};
			return;
		}
		const providerPromptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		const promptTokens = providerPromptTokens > 0 ? calculatePromptTokens(message.usage) : pending?.promptTokens;
		if (promptTokens === undefined) return;
		const compactionEntryId =
			pending?.compactionEntryId ??
			(detail === "ultra" ? getLatestCompactionEntry(this.#host.sessionStore.getBranch())?.id : undefined);
		message.contextSnapshot = buildContextSnapshot(
			promptTokens,
			nonMessageTokens,
			detail,
			estimateContextSnapshotAttribution(
				promptTokens,
				nonMessageTokens,
				pending?.tailTokens ?? 0,
				providerPromptTokens > 0 ? "provider" : "estimate",
				compactionEntryId,
			),
		);
	}
}
