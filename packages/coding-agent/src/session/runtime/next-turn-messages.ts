/**
 * The hidden messages queued for the next turn, and the turn a queued message asks to start on them.
 *
 * This is a session collaborator. It holds the queue and the prompt generation of a requested turn
 * that has not started, and reaches the session only through {@link NextTurnMessagesHost}. A prompt
 * takes the queue ahead of its own message. A requested turn takes the whole queue when it starts,
 * a turn requested while another of the same prompt generation waits to start joins it, and a turn
 * that fails to start puts its messages back ahead of any queued since.
 */
import type { CustomMessage } from "../messages";
import type { PostPromptTasks } from "./post-prompt-tasks";

/** What {@link NextTurnMessages} needs from the session that holds it. */
export interface NextTurnMessagesHost {
	/** Bumped by each abort and prompt; a requested turn of an earlier generation is skipped. */
	promptGeneration(): number;
	/** Where a requested turn is tracked until it settles. */
	readonly postPrompt: Pick<PostPromptTasks, "schedule">;
	/** Start a turn on `message`, with `prepended` ahead of it in the turn's input; it waits for a running turn. */
	promptWith(message: CustomMessage, prepended: CustomMessage[]): Promise<void>;
}

/** The queue and its requested turn, as a failed session switch puts them back. */
export interface NextTurnSnapshot {
	readonly messages: CustomMessage[];
	readonly scheduledGeneration: number | undefined;
}

export class NextTurnMessages {
	readonly #host: NextTurnMessagesHost;
	#messages: CustomMessage[] = [];
	/** The prompt generation of a requested turn that has not started, if one waits. */
	#scheduledGeneration: number | undefined;

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

	/** Remove every queued message and return them in queue order. */
	take(): CustomMessage[] {
		const taken = this.#messages;
		this.#messages = [];
		return taken;
	}

	/** Remove the queued messages `predicate` matches and return them; the rest keep their order. */
	remove(predicate: (message: CustomMessage) => boolean): CustomMessage[] {
		const removed: CustomMessage[] = [];
		const kept: CustomMessage[] = [];
		for (const message of this.#messages) {
			if (predicate(message)) removed.push(message);
			else kept.push(message);
		}
		if (removed.length > 0) this.#messages = kept;
		return removed;
	}

	/** Forget a requested turn that has not started, so the next request schedules its own. */
	forgetRequestedTurn(): void {
		this.#scheduledGeneration = undefined;
	}

	/** Drop every queued message and forget a requested turn that has not started. */
	clear(): void {
		this.#messages = [];
		this.#scheduledGeneration = undefined;
	}

	snapshot(): NextTurnSnapshot {
		return { messages: [...this.#messages], scheduledGeneration: this.#scheduledGeneration };
	}

	restore(snapshot: NextTurnSnapshot): void {
		this.#messages = snapshot.messages;
		this.#scheduledGeneration = snapshot.scheduledGeneration;
	}

	/** Start a turn on the last queued message, with the others ahead of it. */
	async #startTurn(): Promise<void> {
		const queued = this.take();
		const message = queued.at(-1);
		if (!message) return;
		try {
			await this.#host.promptWith(message, queued.slice(0, -1));
		} catch (error) {
			this.#messages = [...queued, ...this.#messages];
			throw error;
		}
	}
}
