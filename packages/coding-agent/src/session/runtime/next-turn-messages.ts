/**
 * The hidden messages queued for the next turn, and the turn a queued message asks to start on them.
 *
 * This is a session collaborator. It holds the queue and the prompt generation of a requested turn
 * that has not started, and reaches the session only through {@link NextTurnMessagesHost}. A prompt
 * leases the queue ahead of its own message and settles the lease when the agent takes its input; a
 * prompt that ends before that releases it, and the leased messages go back ahead of any queued since.
 * A requested turn leases the whole queue when it starts, a turn requested while another of the same
 * prompt generation waits to start joins it, and a turn that fails to start puts its messages back
 * ahead of any queued since.
 */
import type { CustomMessage } from "../messages";
import type { PostPromptTasks } from "./post-prompt-tasks";

/** What {@link NextTurnMessages} needs from the session that holds it. */
export interface NextTurnMessagesHost {
	/** Bumped by each abort and prompt; a requested turn of an earlier generation is skipped. */
	promptGeneration(): number;
	/** Where a requested turn is tracked until it settles. */
	readonly postPrompt: Pick<PostPromptTasks, "schedule">;
	/**
	 * Start a turn on `message`, with the leased messages ahead of it in the turn's input; it waits
	 * for a running turn, and settles `prepended` when the agent takes the input.
	 */
	promptWith(message: CustomMessage, prepended: NextTurnLease): Promise<void>;
}

/** The queue and its requested turn, as a failed session switch puts them back. */
export interface NextTurnSnapshot {
	readonly messages: CustomMessage[];
	readonly scheduledGeneration: number | undefined;
}

/**
 * Queued messages a prompt took for its input and has not yet handed to the agent. Until it settles,
 * {@link NextTurnMessages.remove} still reaches them, and {@link NextTurnMessages.clear} drops them.
 */
export interface NextTurnLease {
	/** The leased messages in queue order, less any removed since. */
	readonly messages: readonly CustomMessage[];
	/** The agent took the input: the messages leave the queue for good. */
	settle(): void;
	/**
	 * The input never reached the agent: the messages go back ahead of any queued since, unless the
	 * queue was cleared after the lease. Does nothing once settled or released.
	 */
	release(): void;
}

/** Move the messages `predicate` matches out of `list`, in place, onto `into`; the rest keep their order. */
function extract(list: CustomMessage[], predicate: (message: CustomMessage) => boolean, into: CustomMessage[]): void {
	let kept = 0;
	for (const message of list) {
		if (predicate(message)) into.push(message);
		else list[kept++] = message;
	}
	list.length = kept;
}

export class NextTurnMessages {
	readonly #host: NextTurnMessagesHost;
	#messages: CustomMessage[] = [];
	/** The prompt generation of a requested turn that has not started, if one waits. */
	#scheduledGeneration: number | undefined;
	/** The messages of every open lease, oldest lease first; a clear closes them all. */
	readonly #leased = new Set<CustomMessage[]>();

	constructor(host: NextTurnMessagesHost) {
		this.#host = host;
	}

	/** How many messages are queued. */
	get count(): number {
		return this.#messages.length;
	}

	/**
	 * Queue `message` for the next turn. With `startTurn`, request a turn on the queue, unless a
	 * turn of this prompt generation is already waiting to start.
	 */
	queue(message: CustomMessage, startTurn: boolean): void {
		this.#messages.push(message);
		if (!startTurn) return;
		const generation = this.#host.promptGeneration();
		if (this.#scheduledGeneration === generation) return;
		this.#scheduledGeneration = generation;
		this.#host.postPrompt.schedule(
			async () => {
				if (this.#scheduledGeneration === generation) this.#scheduledGeneration = undefined;
				if (this.#messages.length === 0) return;
				try {
					await this.#startTurn();
				} catch {
					// The messages stay queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledGeneration === generation) this.#scheduledGeneration = undefined;
				},
			},
		);
	}

	/** Lease every queued message, in queue order, to a prompt building its input. */
	lease(): NextTurnLease {
		const messages = this.#messages;
		this.#messages = [];
		return this.#hold(messages);
	}

	/**
	 * Remove the queued and leased messages `predicate` matches and return them, leased ones first;
	 * the rest keep their order.
	 */
	remove(predicate: (message: CustomMessage) => boolean): CustomMessage[] {
		const removed: CustomMessage[] = [];
		for (const leased of this.#leased) extract(leased, predicate, removed);
		extract(this.#messages, predicate, removed);
		return removed;
	}

	/** Forget a requested turn that has not started, so the next request schedules its own. */
	forgetRequestedTurn(): void {
		this.#scheduledGeneration = undefined;
	}

	/** Drop every queued and leased message and forget a requested turn that has not started. */
	clear(): void {
		this.#messages = [];
		this.#scheduledGeneration = undefined;
		this.#leased.clear();
	}

	snapshot(): NextTurnSnapshot {
		return { messages: [...this.#messages], scheduledGeneration: this.#scheduledGeneration };
	}

	restore(snapshot: NextTurnSnapshot): void {
		this.#messages = snapshot.messages;
		this.#scheduledGeneration = snapshot.scheduledGeneration;
	}

	#hold(messages: CustomMessage[]): NextTurnLease {
		this.#leased.add(messages);
		return {
			messages,
			settle: () => {
				this.#leased.delete(messages);
			},
			release: () => {
				if (this.#leased.delete(messages) && messages.length > 0) this.#messages = [...messages, ...this.#messages];
			},
		};
	}

	/**
	 * Start a turn on the last queued message, with the others ahead of it. A turn that never starts
	 * puts the others back and drops its own message with the interrupt that stopped it; a turn that
	 * fails to start puts back all of them.
	 */
	async #startTurn(): Promise<void> {
		const queued = this.#messages;
		this.#messages = [];
		const message = queued.pop();
		if (!message) return;
		const prepended = this.#hold(queued);
		try {
			await this.#host.promptWith(message, prepended);
		} catch (error) {
			queued.push(message);
			throw error;
		} finally {
			prepended.release();
		}
	}
}
