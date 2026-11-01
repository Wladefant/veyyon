import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, type TelegramDeliveryTraceData } from "@veyyon/utils";

const ENTRY_TYPE = "terminal:operator-answer";
const ANSWER_MARKER = /^\[operator-answer question=([^\s\]]{1,256}) event=[^\s\]]{1,256}\](?:\s|$)/;
type DeliveryMode = "auto" | "steer" | "followUp";
// In-process FIFO by durable session identity: reconnect may reopen the same file with a different manager.
// Idle chains are removed; this is not a cross-process lease.
const journalOperationChains = new Map<string, Promise<void>>();
interface PendingAnswer {
	version: 1;
	sessionId: string;
	questionId: string;
	inputId: string;
	text: string;
	mode: DeliveryMode;
}

export function operatorAnswerQuestionId(text: string): string | undefined {
	return ANSWER_MARKER.exec(text)?.[1];
}

/**
 * The answer's own user-message entry commits consumption. The pending entry never does.
 *
 * `journal` is read on every call, never held: /new, /resume and handoff replace the session's manager, and an answer
 * is journaled in the session that receives it. `isQueued` says whether the runtime still holds the answer for a
 * question in its queue; a queue the operator cleared drops the answer, and a retry must then deliver it again.
 */
export class OperatorAnswerInbox {
	readonly #journal: () => SessionManager;
	readonly #dispatch: (
		text: string,
		mode: DeliveryMode,
		options?: { telegramTrace?: TelegramDeliveryTraceData },
	) => Promise<string>;
	readonly #isQueued: (questionId: string) => boolean;
	readonly #queued = new Set<string>();
	#chain: Promise<void> = Promise.resolve();

	constructor(
		journal: () => SessionManager,
		dispatch: (
			text: string,
			mode: DeliveryMode,
			options?: { telegramTrace?: TelegramDeliveryTraceData },
		) => Promise<string>,
		isQueued: (questionId: string) => boolean,
	) {
		this.#journal = journal;
		this.#dispatch = dispatch;
		this.#isQueued = isQueued;
	}

	#scan(journal: SessionManager): { pending: Map<string, PendingAnswer>; consumed: Set<string> } {
		const pending = new Map<string, PendingAnswer>();
		const consumed = new Set<string>();
		const sessionId = journal.getSessionId();
		for (const entry of journal.getEntries()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
				const questionId = operatorAnswerQuestionId(text);
				if (questionId) consumed.add(questionId);
			}
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const answer = entry.data as Partial<PendingAnswer> | null | undefined;
			if (typeof answer !== "object" || answer === null) {
				logger.warn("Skipping unreadable operator-answer journal record", { entryId: entry.id });
				continue;
			}
			if (answer.sessionId !== sessionId) continue;
			// A record this build cannot read (another version, a damaged field) is not pending. It must never stop
			// the session from opening or a later answer from being accepted.
			if (answer.version !== 1 || typeof answer.text !== "string" || typeof answer.questionId !== "string" ||
				answer.inputId !== `operator-answer:${answer.questionId}` || operatorAnswerQuestionId(answer.text) !== answer.questionId ||
				!(["auto", "steer", "followUp"] as unknown[]).includes(answer.mode)) {
				logger.warn("Skipping unreadable operator-answer journal record", { entryId: entry.id });
				continue;
			}
			pending.set(answer.questionId, answer as PendingAnswer);
		}
		return { pending, consumed };
	}

	#serialize<T>(operation: (journal: SessionManager) => Promise<T>): Promise<T> {
		const run = this.#chain.then(() => {
			const journal = this.#journal();
			// Reconnect can replace an inbox while the old instance is still accepting a sender retry.
			// Serialize both instances against their shared durable journal, not only each inbox's chain.
			const sessionId = journal.getSessionId();
			const previous = journalOperationChains.get(sessionId) ?? Promise.resolve();
			const queued = previous.then(() => operation(journal));
			const settled = queued.then(() => {}, () => {});
			journalOperationChains.set(sessionId, settled);
			void settled.then(() => {
				if (journalOperationChains.get(sessionId) === settled) journalOperationChains.delete(sessionId);
			});
			return queued;
		});
		this.#chain = run.then(() => {}, () => {});
		return run;
	}

	async #queue(answer: PendingAnswer, options?: { telegramTrace?: TelegramDeliveryTraceData }): Promise<string> {
		const key = `${answer.sessionId}:${answer.questionId}`;
		this.#queued.add(key);
		try {
			return await this.#dispatch(answer.text, answer.mode, options);
		} catch (error) {
			this.#queued.delete(key);
			throw error;
		}
	}

	/** Return undefined for ordinary input; only the operator envelope enters this protocol. */
	accept(
		text: string,
		mode: DeliveryMode,
		options?: { telegramTrace?: TelegramDeliveryTraceData },
	): Promise<string | undefined> {
		const questionId = operatorAnswerQuestionId(text);
		if (!questionId) return Promise.resolve(undefined);
		return this.#serialize(async journal => {
			if (this.#journal() !== journal) throw new Error("Operator-answer session changed before acceptance");
			const sessionId = journal.getSessionId();
			const key = `${sessionId}:${questionId}`;
			const { pending, consumed } = this.#scan(journal);
			// An answer still waiting in the runtime queue is a replay. One the operator cleared from the queue is
			// gone: no user message was written, so the retry delivers it again. A dequeue that lands between the
			// runtime taking the message and journaling it is a window of milliseconds against a retry's seconds.
			// A replacement inbox may receive the sender's retry before recover() inspects a still-queued
			// answer. The durable pending record, not only this instance's mark, requires checking the queue.
			// Another manager can have queued the answer after this manager loaded a stale snapshot.
			// Check the shared runtime queue even when no local pending record was observed.
			if (!consumed.has(questionId)) {
				if (this.#isQueued(questionId)) this.#queued.add(key);
				else this.#queued.delete(key);
			}
			if (consumed.has(questionId) || this.#queued.has(key)) {
				logger.info(`DUPLICATE-ANSWER ${questionId}`);
				return "duplicate";
			}
			// A separately opened manager can have an older in-memory journal even after our per-session
			// operation lock has settled. Its empty queue is not proof that no durable answer exists.
			// Refuse to append from that stale snapshot; a reopened manager can recover the original.
			if (await journal.holdsForeignEntries({ requireReadable: true })) {
				throw new Error("Operator-answer journal is stale; reopen session before accepting");
			}
			if (this.#journal() !== journal) throw new Error("Operator-answer session changed before journaling");
			const answer: PendingAnswer = pending.get(questionId) ?? {
				version: 1, sessionId, questionId, inputId: `operator-answer:${questionId}`, text, mode,
			};
			if (!pending.has(questionId)) journal.appendCustomEntry(ENTRY_TYPE, answer);
			// append alone can remain behind the lazy-file gate or a foreign-file rewrite.
			await journal.ensureOnDisk();
			await journal.flush();
			if (this.#journal() !== journal) throw new Error("Operator-answer session changed before injection");
			return this.#queue(answer, options);
		});
	}

	/**
	 * A crash before user-message persistence leaves a pending answer, not a consumed question. Recovery is best
	 * effort: an answer that cannot be injected now stays pending for the sender's retry and never blocks startup.
	 */
	recover(): Promise<void> {
		return this.#serialize(async journal => {
			if (this.#journal() !== journal) return;
			// Recovery must not replay an already-consumed answer from a retained stale manager.
			try {
				if (await journal.holdsForeignEntries({ requireReadable: true })) {
					logger.warn("Skipping operator-answer recovery on stale session journal; reopen session");
					return;
				}
			} catch {
				// Unknown durable state cannot authorize replay; sender retries later.
				logger.warn("Skipping operator-answer recovery because session journal verification failed");
				return;
			}
			if (this.#journal() !== journal) return;
			const { pending, consumed } = this.#scan(journal);
			for (const answer of pending.values()) {
				if (consumed.has(answer.questionId)) continue;
				if (this.#journal() !== journal) return;
				const key = `${answer.sessionId}:${answer.questionId}`;
				try {
					// Reconnect/repeated recovery can see an unconsumed entry whose answer is already queued.
					// Only a user-message entry commits consumption; a cleared queue remains retryable.
					if (this.#isQueued(answer.questionId)) {
						this.#queued.add(key);
						continue;
					}
					this.#queued.delete(key);
					await this.#queue(answer);
				} catch (error) {
					logger.warn("Operator answer recovery could not inject a pending answer", {
						questionId: answer.questionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		});
	}
}
