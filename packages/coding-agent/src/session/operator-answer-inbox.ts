import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";

const ENTRY_TYPE = "terminal:operator-answer";
const ANSWER_MARKER = /^\[operator-answer question=([^\s\]]{1,256}) event=[^\s\]]{1,256}\](?:\s|$)/;
type DeliveryMode = "auto" | "steer" | "followUp";
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

/** The answer's own user-message entry commits consumption. The pending entry never does. */
export class OperatorAnswerInbox {
	readonly #journal: SessionManager;
	readonly #dispatch: (text: string, mode: DeliveryMode) => Promise<string>;
	readonly #queued = new Set<string>();
	#chain: Promise<void> = Promise.resolve();

	constructor(journal: SessionManager, dispatch: (text: string, mode: DeliveryMode) => Promise<string>) {
		this.#journal = journal;
		this.#dispatch = dispatch;
	}

	#scan(): { pending: Map<string, PendingAnswer>; consumed: Set<string> } {
		const pending = new Map<string, PendingAnswer>();
		const consumed = new Set<string>();
		const sessionId = this.#journal.getSessionId();
		for (const entry of this.#journal.getEntries()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				const text = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n");
				const questionId = operatorAnswerQuestionId(text);
				if (questionId) consumed.add(questionId);
			}
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const value = entry.data;
			if (typeof value !== "object" || value === null) throw new Error("Invalid operator-answer journal record");
			const answer = value as Partial<PendingAnswer>;
			if (answer.sessionId !== sessionId) continue;
			if (answer.version !== 1 || typeof answer.text !== "string" || typeof answer.questionId !== "string" ||
				answer.inputId !== `operator-answer:${answer.questionId}` || operatorAnswerQuestionId(answer.text) !== answer.questionId ||
				!(["auto", "steer", "followUp"] as unknown[]).includes(answer.mode)) {
				throw new Error("Invalid operator-answer journal record");
			}
			pending.set(answer.questionId, answer as PendingAnswer);
		}
		return { pending, consumed };
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(operation);
		this.#chain = run.then(() => {}, () => {});
		return run;
	}

	async #queue(answer: PendingAnswer): Promise<string> {
		const key = `${answer.sessionId}:${answer.questionId}`;
		if (this.#queued.has(key)) return "queued";
		this.#queued.add(key);
		try {
			return await this.#dispatch(answer.text, answer.mode);
		} catch (error) {
			this.#queued.delete(key);
			throw error;
		}
	}

	/** Return undefined for ordinary input; only the operator envelope enters this protocol. */
	accept(text: string, mode: DeliveryMode): Promise<string | undefined> {
		const questionId = operatorAnswerQuestionId(text);
		if (!questionId) return Promise.resolve(undefined);
		return this.#serialize(async () => {
			const sessionId = this.#journal.getSessionId();
			const { pending, consumed } = this.#scan();
			if (consumed.has(questionId) || this.#queued.has(`${sessionId}:${questionId}`)) {
				logger.info(`DUPLICATE-ANSWER ${questionId}`);
				return "duplicate";
			}
			const answer: PendingAnswer = pending.get(questionId) ?? {
				version: 1, sessionId, questionId, inputId: `operator-answer:${questionId}`, text, mode,
			};
			if (!pending.has(questionId)) this.#journal.appendCustomEntry(ENTRY_TYPE, answer);
			// append alone can remain behind the lazy-file gate or a foreign-file rewrite.
			await this.#journal.ensureOnDisk();
			await this.#journal.flush();
			if (this.#journal.getSessionId() !== sessionId) throw new Error("Operator-answer session changed before injection");
			return this.#queue(answer);
		});
	}

	/** A crash before user-message persistence leaves a pending answer, not a consumed question. */
	recover(): Promise<void> {
		return this.#serialize(async () => {
			const sessionId = this.#journal.getSessionId();
			const { pending, consumed } = this.#scan();
			for (const answer of pending.values()) {
				if (consumed.has(answer.questionId)) continue;
				if (this.#journal.getSessionId() !== sessionId) throw new Error("Operator-answer session changed during recovery");
				await this.#queue(answer);
			}
		});
	}
}
