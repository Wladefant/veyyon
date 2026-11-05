/**
 * The IRC records that reached a session while it could not take them at once, until a step boundary,
 * an inbox call or the next prompt takes them.
 *
 * This is a session collaborator. It holds two queues and never touches the session: the session
 * queues each record, and takes them back at the boundary that delivers them.
 *
 * - **Interrupts**: a peer message that arrived mid-turn. `job poll` and `irc wait` peek at these
 *   through {@link IrcInbox.hasInterrupts} to return before the next step boundary.
 * - **Asides**: an auto-reply this session sent on its own behalf, recorded so the model knows what
 *   was said for it.
 *
 * Every take returns interrupts before asides.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { IrcMessage } from "../../task/irc-bus";
import type { CustomMessage } from "../messages";

/** Which `irc:incoming` records {@link IrcInbox.takeIncoming} returns. */
export interface IrcIncomingFilter {
	/** Only records sent by this agent. */
	from?: string;
	/** At most this many records. */
	limit?: number;
}

export class IrcInbox {
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];
	#completionWake: CustomMessage | undefined;

	queueCompletionWake(record: CustomMessage): void {
		this.#completionWake ??= record;
	}

	get completionWake(): CustomMessage | undefined {
		return this.#completionWake;
	}

	/** Whether a peer message is waiting for the next step boundary. */
	get hasInterrupts(): boolean {
		return this.#interrupts.length > 0 || this.#completionWake !== undefined;
	}

	/** Whether any record is waiting. */
	get isEmpty(): boolean {
		return this.#interrupts.length === 0 && this.#asides.length === 0 && this.#completionWake === undefined;
	}

	queueInterrupt(record: CustomMessage): void {
		this.#interrupts.push(record);
	}

	queueAside(record: CustomMessage): void {
		this.#asides.push(record);
	}

	/** Every waiting record, interrupts first, leaving both queues empty. */
	takeAll(): CustomMessage[] {
		this.#completionWake = undefined;
		const records = this.#interrupts.concat(this.#asides);
		this.#interrupts = [];
		this.#asides = [];
		return records;
	}

	/**
	 * The waiting `irc:incoming` records that match `filter`, as bus messages addressed to `agentId`,
	 * removed from their queues. Every other record stays where it was, in order.
	 */
	takeIncoming(agentId: string, filter?: IrcIncomingFilter): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const keep = (record: CustomMessage): boolean => {
			if (record.customType !== "irc:incoming") return true;
			const details = record.details;
			if (!details || typeof details !== "object") return true;
			const id = Reflect.get(details, "id");
			const from = Reflect.get(details, "from");
			const body = Reflect.get(details, "message");
			const replyTo = Reflect.get(details, "replyTo");
			const actor = Reflect.get(details, "actor") as IrcMessage["actor"] | undefined;
			if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") return true;
			if (filter?.from !== undefined && from !== filter.from) return true;
			if (filter?.limit !== undefined && messages.length >= filter.limit) return true;
			messages.push({
				id,
				from,
				to: agentId,
				body,
				ts: record.timestamp,
				...(actor?.source === "agent" && actor.selfId === agentId ? { actor } : {}),
				...(typeof replyTo === "string" ? { replyTo } : {}),
			});
			return false;
		};
		this.#interrupts = this.#interrupts.filter(keep);
		this.#asides = this.#asides.filter(keep);
		return messages;
	}
}

/** Durable outbox for results from retained-context IRC turns, separate from immutable spawn output. */
export interface IrcContinuation {
	version: 1;
	id: string;
	agentId: string;
	parentId: string;
	phaseId: string;
	handle: string;
	output: string;
	resultSource: "agent" | "harness";
}

function isContinuation(value: unknown): value is IrcContinuation {
	if (!value || typeof value !== "object") return false;
	return Reflect.get(value, "version") === 1 &&
		["id", "agentId", "parentId", "phaseId", "handle", "output"].every(key => typeof Reflect.get(value, key) === "string") &&
		(Reflect.get(value, "resultSource") === "agent" || Reflect.get(value, "resultSource") === "harness");
}

/** Keep native continuation artifacts in one portable path component.
 * Regular IDs retain their existing handles. Unsafe/oversized IDs use a stable
 * digest so traversal, Windows device names and invalid filename characters
 * never become filesystem path syntax. The original agentId stays in the journal. */
function continuationArtifactAgentComponent(agentId: string): string {
	const portable = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(agentId) &&
		!/[.]$/.test(agentId) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(agentId);
	return portable ? agentId : `agent-${createHash("sha256").update(agentId).digest("hex")}`;
}

export class IrcContinuationOutbox {
	readonly #store: SessionManager;
	#flushing: Promise<void> | undefined;
	readonly #completing = new Map<string, Promise<IrcContinuation>>();

	constructor(store: SessionManager) {
		this.#store = store;
	}

	hasPhase(phaseId: string): boolean {
		return this.#store.getEntries().some(entry => entry.type === "custom" &&
			entry.customType === "irc:continuation-phase" && typeof entry.data === "object" && entry.data !== null &&
			Reflect.get(entry.data, "version") === 1 && Reflect.get(entry.data, "phaseId") === phaseId);
	}

	/** Retained native input lets activation recover a phase interrupted before its result was saved. */
	unfinished(): CustomMessage[] {
		const completed = new Set(this.#results().map(result => result.phaseId));
		return this.#store.getEntries().flatMap(entry => {
			if (entry.type !== "custom" || entry.customType !== "irc:continuation-phase" ||
				!entry.data || typeof entry.data !== "object" || Reflect.get(entry.data, "version") !== 1) return [];
			const phaseId = Reflect.get(entry.data, "phaseId");
			const record = Reflect.get(entry.data, "record") as CustomMessage | undefined;
			return typeof phaseId === "string" && !completed.has(phaseId) && record?.role === "custom" &&
				(record.customType === "irc:incoming" || record.customType === "task:continuation") ? [record] : [];
		});
	}

	#results(): IrcContinuation[] {
		const results = new Map<string, IrcContinuation>();
		for (const entry of this.#store.getEntries()) {
			if (entry.type === "custom" && entry.customType === "irc:continuation-result" && isContinuation(entry.data)) {
				if (!results.has(entry.data.id)) results.set(entry.data.id, entry.data);
			}
		}
		return [...results.values()];
	}

	/** Claim a native message ID before starting its turn. A replay cannot start it twice. */
	begin(phaseId: string, record?: CustomMessage): boolean {
		if (this.hasPhase(phaseId)) return false;
		this.#store.appendCustomEntry("irc:continuation-phase", { version: 1, phaseId, record });
		this.#store.flushSync();
		return true;
	}

	complete(agentId: string, parentId: string, phaseId: string, output: string, resultSource: IrcContinuation["resultSource"] = "agent"): Promise<IrcContinuation> {
		const pending = this.#completing.get(phaseId);
		if (pending) return pending;
		const completion = this.#complete(agentId, parentId, phaseId, output, resultSource)
			.finally(() => { this.#completing.delete(phaseId); });
		this.#completing.set(phaseId, completion);
		return completion;
	}

	async #complete(agentId: string, parentId: string, phaseId: string, output: string, resultSource: IrcContinuation["resultSource"]): Promise<IrcContinuation> {
		await this.#store.ensureOnDisk();
		const id = createHash("sha256").update(this.#store.getSessionId()).update("\0").update(phaseId).digest("hex");
		const existing = this.#results().find(item => item.id === id);
		if (existing) return existing;
		const stem = `${continuationArtifactAgentComponent(agentId)}.phase-${id}`;
		const completion: IrcContinuation = { version: 1, id, agentId, parentId, phaseId, handle: `agent://${stem}`, output, resultSource };
		const dir = this.#store.getArtifactsDir();
		if (!dir) throw new Error("Cannot publish a continuation without an artifact directory");
		await fs.mkdir(dir, { recursive: true });
		// Publish only a fully synced file. A crash must not leave a partial immutable result.
		const artifact = path.join(dir, `${stem}.md`);
		const temporary = path.join(dir, `${stem}.${randomUUID()}.tmp`);
		try {
			const file = await fs.open(temporary, "wx");
			try {
				await file.writeFile(output, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			try {
				await fs.link(temporary, artifact);
			} catch (error) {
				if (!(error && typeof error === "object" && Reflect.get(error, "code") === "EEXIST")) throw error;
				if (await fs.readFile(artifact, "utf8") !== output) throw new Error("Continuation output changed during replay");
			}
		} finally {
			await fs.rm(temporary, { force: true });
		}
		const raced = this.#results().find(item => item.id === id);
		if (raced) return raced;
		this.#store.appendCustomEntry("irc:continuation-result", completion);
		this.#store.flushSync();
		await this.#store.sync();
		return completion;
	}

	pending(): IrcContinuation[] {
		const entries = this.#store.getEntries();
		const acknowledged = new Set(entries.flatMap(entry =>
			entry.type === "custom" && entry.customType === "irc:continuation-delivered" &&
			typeof entry.data === "string" ? [entry.data] : []));
		return this.#results().filter(result => !acknowledged.has(result.id));
	}

	/** The receiver durably deduplicates before accepting; a crash before this ack safely replays. */
	flush(deliver: (completion: IrcContinuation) => Promise<boolean>): Promise<void> {
		if (this.#flushing) return this.#flushing;
		const drain = Promise.withResolvers<void>();
		const flushing = drain.promise;
		this.#flushing = flushing;
		void (async () => {
			const attempted = new Set<string>();
			for (;;) {
				const completion = this.pending().find(item => !attempted.has(item.id));
				if (!completion) {
					if (this.#flushing === flushing) this.#flushing = undefined;
					return;
				}
				attempted.add(completion.id);
				if (!await deliver(completion)) continue;
				this.#store.appendCustomEntry("irc:continuation-delivered", completion.id);
				this.#store.flushSync();
				await this.#store.sync();
			}
		})().then(() => {
			if (this.#flushing === flushing) this.#flushing = undefined;
			drain.resolve();
		}, (error: unknown) => {
			if (this.#flushing === flushing) this.#flushing = undefined;
			drain.reject(error);
		});
		return flushing;
	}
}
