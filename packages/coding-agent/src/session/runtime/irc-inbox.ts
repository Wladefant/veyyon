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
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { IrcMessage } from "../../task/irc-bus";
import type { CustomMessage } from "../messages";

export function sameIrcRecord(
	left: Pick<CustomMessage, "customType" | "details">,
	right: Pick<CustomMessage, "customType" | "details">,
): boolean {
	if (left.customType !== right.customType) return false;
	const field = left.customType === "task:continuation" ? "completionId" : "id";
	const id = Reflect.get(left.details ?? {}, field);
	return typeof id === "string" && Reflect.get(right.details ?? {}, field) === id;
}

function receivedCompletion(data: unknown): CustomMessage | undefined {
	if (!data || typeof data !== "object" || Reflect.get(data, "version") !== 1) return undefined;
	const record = Reflect.get(data, "record") as CustomMessage | undefined;
	return record?.role === "custom" &&
		record.customType === "task:continuation" &&
		typeof Reflect.get(record.details ?? {}, "completionId") === "string"
		? record
		: undefined;
}

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

	/** Whether a peer message is waiting for the next step boundary. */
	get hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any record is waiting. */
	get isEmpty(): boolean {
		return this.#interrupts.length === 0 && this.#asides.length === 0;
	}

	queueInterrupt(record: CustomMessage): void {
		this.#interrupts.push(record);
	}

	takeCompletion(record: CustomMessage): void {
		const index = this.#interrupts.findIndex(candidate => sameIrcRecord(candidate, record));
		if (index >= 0) this.#interrupts.splice(index, 1);
	}

	queueAside(record: CustomMessage): void {
		this.#asides.push(record);
	}

	/** Every waiting record, interrupts first, leaving both queues empty. */
	takeAll(): CustomMessage[] {
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
	return (
		Reflect.get(value, "version") === 1 &&
		["id", "agentId", "parentId", "phaseId", "handle", "output"].every(
			key => typeof Reflect.get(value, key) === "string",
		) &&
		(Reflect.get(value, "resultSource") === "agent" || Reflect.get(value, "resultSource") === "harness")
	);
}

/** Keep native continuation artifacts in one portable path component.
 * Regular IDs retain their existing handles. Unsafe/oversized IDs use a stable
 * digest so traversal, Windows device names and invalid filename characters
 * never become filesystem path syntax. The original agentId stays in the journal. */
function continuationArtifactAgentComponent(agentId: string): string {
	const portable =
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(agentId) &&
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

	hasReceivedCompletion(completionId: string): boolean {
		return this.#store.getEntries().some(entry => {
			if (entry.type === "custom_message" && entry.customType === "task:continuation") {
				return Reflect.get(entry.details ?? {}, "completionId") === completionId;
			}
			if (entry.type !== "custom" || entry.customType !== "irc:completion-received") return false;
			const record = receivedCompletion(entry.data);
			return record !== undefined && Reflect.get(record.details ?? {}, "completionId") === completionId;
		});
	}

	/** A durable delivery receipt is not a provider input and cannot split an in-flight tool exchange. */
	receiveCompletion(record: CustomMessage): void {
		const id = Reflect.get(record.details ?? {}, "completionId");
		if (record.customType !== "task:continuation" || typeof id !== "string") {
			throw new Error("Native completion receipt requires a completion ID");
		}
		if (!this.hasReceivedCompletion(id)) {
			this.#store.appendCustomEntry("irc:completion-received", { version: 1, record });
		}
	}

	pendingReceivedCompletions(consumedInContext: ReadonlySet<string>): CustomMessage[] {
		const consumed = new Set(consumedInContext);
		const records = new Map<string, CustomMessage>();
		for (const entry of this.#store.getEntries()) {
			let record: CustomMessage | undefined;
			if (entry.type === "custom") {
				if (entry.customType === "irc:completion-consumed" && typeof entry.data === "string")
					consumed.add(entry.data);
				else if (entry.customType === "irc:completion-received") record = receivedCompletion(entry.data);
			} else if (entry.type === "custom_message" && entry.customType === "task:continuation") {
				const message = this.#store.buildEntryContext(entry).messages[0];
				if (message?.role === "custom") record = message;
			}
			if (!record) continue;
			const id = Reflect.get(record.details ?? {}, "completionId");
			if (typeof id !== "string") continue;
			if (Reflect.get(record.details ?? {}, "streamingCompletion") === true) consumed.add(id);
			if (!records.has(id)) records.set(id, record);
		}
		return [...records.values()].filter(record => !consumed.has(Reflect.get(record.details ?? {}, "completionId")));
	}

	/** Only messages after both the durable phase claim and its actual input can belong to its result. */
	recoveryMessages(phaseId: string, record: CustomMessage): AgentMessage[] | undefined {
		const entries = this.#store.getBranch();
		const claim = entries.findIndex(
			entry =>
				entry.type === "custom" &&
				entry.customType === "irc:continuation-phase" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				Reflect.get(entry.data, "version") === 1 &&
				Reflect.get(entry.data, "phaseId") === phaseId,
		);
		const input = entries.findIndex(entry => entry.type === "custom_message" && sameIrcRecord(entry, record));
		if (claim < 0 || input < 0) return undefined;
		return entries.slice(Math.max(claim, input) + 1).flatMap(entry => this.#store.buildEntryContext(entry).messages);
	}

	hasPhase(phaseId: string): boolean {
		return this.#store
			.getEntries()
			.some(
				entry =>
					entry.type === "custom" &&
					entry.customType === "irc:continuation-phase" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					Reflect.get(entry.data, "version") === 1 &&
					Reflect.get(entry.data, "phaseId") === phaseId,
			);
	}

	/** Retained native input with its durable phase ID lets activation recover a phase interrupted before its result was saved. */
	unfinishedPhases(): Array<{ phaseId: string; record: CustomMessage }> {
		const entries = this.#store.getEntries();
		const completed = new Set(this.#results().map(result => result.phaseId));
		for (const entry of entries) {
			if (
				entry.type === "custom" &&
				entry.customType === "irc:completion-consumed" &&
				typeof entry.data === "string"
			) {
				completed.add(`completion:${entry.data}`);
			} else if (
				entry.type === "custom_message" &&
				entry.customType === "task:continuation" &&
				Reflect.get(entry.details ?? {}, "streamingCompletion") === true
			) {
				const id = Reflect.get(entry.details ?? {}, "completionId");
				if (typeof id === "string") completed.add(`completion:${id}`);
			}
		}
		const consumedSteers = new Set(
			entries.flatMap(entry =>
				entry.type === "custom_message" &&
				entry.customType === "irc:incoming" &&
				Reflect.get(entry.details ?? {}, "streamingSteer") === true
					? [Reflect.get(entry.details ?? {}, "id")]
					: [],
			),
		);
		return entries.flatMap(entry => {
			if (
				entry.type !== "custom" ||
				entry.customType !== "irc:continuation-phase" ||
				!entry.data ||
				typeof entry.data !== "object" ||
				Reflect.get(entry.data, "version") !== 1
			)
				return [];
			const phaseId = Reflect.get(entry.data, "phaseId");
			const record = Reflect.get(entry.data, "record") as CustomMessage | undefined;
			return typeof phaseId === "string" &&
				!completed.has(phaseId) &&
				!consumedSteers.has(phaseId) &&
				record?.role === "custom" &&
				(record.customType === "irc:incoming" || record.customType === "task:continuation")
				? [{ phaseId, record }]
				: [];
		});
	}

	/** Retained native input lets activation recover a phase interrupted before its result was saved. */
	unfinished(): CustomMessage[] {
		return this.unfinishedPhases().map(entry => entry.record);
	}

	/** Describe late continuation input without treating independent instructions as replacements. */
	withOrdering(record: CustomMessage): CustomMessage {
		const from = Reflect.get(record.details ?? {}, "from");
		const id = Reflect.get(record.details ?? {}, "id");
		if (typeof from !== "string" || typeof id !== "string") return record;
		let newerId: string | undefined;
		let newerTimestamp = record.timestamp;
		for (const entry of this.#store.getEntries()) {
			const candidate =
				entry.type === "custom_message"
					? entry
					: entry.type === "custom" && entry.customType === "irc:completion-received"
						? receivedCompletion(entry.data)
						: undefined;
			if (
				!candidate ||
				(candidate.customType !== "irc:incoming" && candidate.customType !== "task:continuation") ||
				Reflect.get(candidate.details ?? {}, "from") !== from
			)
				continue;
			const candidateId = Reflect.get(candidate.details ?? {}, "id");
			const timestamp =
				Reflect.get(candidate.details ?? {}, "sentAt") ??
				(typeof candidate.timestamp === "number" ? candidate.timestamp : new Date(candidate.timestamp).getTime());
			if (
				typeof candidateId === "string" &&
				candidateId !== id &&
				typeof timestamp === "number" &&
				timestamp > newerTimestamp
			) {
				newerId = candidateId;
				newerTimestamp = timestamp;
			}
		}
		return {
			...record,
			content: newerId
				? `${record.content}\n[IRC ordering: sent at ${record.timestamp}; phase ${id}; arrived after newer ${newerId} from same sender. This does not establish supersession.]`
				: record.content,
			details: {
				...(record.details && typeof record.details === "object" ? record.details : {}),
				sentAt: record.timestamp,
				phaseId: Reflect.get(record.details ?? {}, "phaseId") ?? id,
				...(newerId ? { arrivedAfter: newerId } : {}),
			},
		};
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

	/** Claim synchronously in memory; the caller persists before executing the claimed phase. */
	begin(phaseId: string, record?: CustomMessage): boolean {
		if (this.hasPhase(phaseId)) return false;
		this.#store.appendCustomEntry("irc:continuation-phase", { version: 1, phaseId, record });
		return true;
	}

	complete(
		agentId: string,
		parentId: string,
		phaseId: string,
		output: string,
		resultSource: IrcContinuation["resultSource"] = "agent",
	): Promise<IrcContinuation> {
		const pending = this.#completing.get(phaseId);
		if (pending) return pending;
		const completion = this.#complete(agentId, parentId, phaseId, output, resultSource).finally(() => {
			this.#completing.delete(phaseId);
		});
		this.#completing.set(phaseId, completion);
		return completion;
	}

	async #complete(
		agentId: string,
		parentId: string,
		phaseId: string,
		output: string,
		resultSource: IrcContinuation["resultSource"],
	): Promise<IrcContinuation> {
		await this.#store.ensureOnDisk();
		const id = createHash("sha256").update(this.#store.getSessionId()).update("\0").update(phaseId).digest("hex");
		const existing = this.#results().find(item => item.id === id);
		if (existing) {
			await this.#store.sync();
			return existing;
		}
		const stem = `${continuationArtifactAgentComponent(agentId)}.phase-${id}`;
		const completion: IrcContinuation = {
			version: 1,
			id,
			agentId,
			parentId,
			phaseId,
			handle: `agent://${stem}`,
			output,
			resultSource,
		};
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
				if ((await fs.readFile(artifact, "utf8")) !== output)
					throw new Error("Continuation output changed during replay");
			}
		} finally {
			await fs.rm(temporary, { force: true });
		}
		const raced = this.#results().find(item => item.id === id);
		if (raced) {
			await this.#store.sync();
			return raced;
		}
		this.#store.appendCustomEntry("irc:continuation-result", completion);
		await this.#store.sync();
		return completion;
	}

	pending(): IrcContinuation[] {
		const entries = this.#store.getEntries();
		const acknowledged = new Set(
			entries.flatMap(entry =>
				entry.type === "custom" &&
				entry.customType === "irc:continuation-delivered" &&
				typeof entry.data === "string"
					? [entry.data]
					: [],
			),
		);
		return this.#results().filter(result => !acknowledged.has(result.id));
	}

	/** A recipient owns an attempted delivery even if its acknowledgement is lost.
	 * Failover is safe only before sending; an unavailable owner leaves the result pending. */
	deliveryTarget(completionId: string): string | undefined {
		for (const entry of this.#store.getEntries()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== "irc:continuation-target" ||
				!entry.data ||
				typeof entry.data !== "object" ||
				Reflect.get(entry.data, "version") !== 1 ||
				Reflect.get(entry.data, "completionId") !== completionId
			)
				continue;
			const target = Reflect.get(entry.data, "parentId");
			if (typeof target === "string") return target;
		}
		return undefined;
	}

	async claimDeliveryTarget(completionId: string, parentId: string): Promise<string> {
		const existing = this.deliveryTarget(completionId);
		if (existing) {
			await this.#store.ensureOnDisk();
			await this.#store.sync();
			return existing;
		}
		this.#store.appendCustomEntry("irc:continuation-target", { version: 1, completionId, parentId });
		await this.#store.ensureOnDisk();
		await this.#store.sync();
		return parentId;
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
				// Another publisher's entry can be visible while its sync is pending.
				// Commit this observed result before allowing external delivery.
				await this.#store.ensureOnDisk();
				await this.#store.sync();
				if (!(await deliver(completion))) continue;
				this.#store.appendCustomEntry("irc:continuation-delivered", completion.id);
				await this.#store.sync();
			}
		})().then(
			() => {
				if (this.#flushing === flushing) this.#flushing = undefined;
				drain.resolve();
			},
			(error: unknown) => {
				if (this.#flushing === flushing) this.#flushing = undefined;
				drain.reject(error);
			},
		);
		return flushing;
	}
}
