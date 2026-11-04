/**
 * The IRC message cards in the transcript's live region: each card retires
 * after a visible TTL, and a burst beyond the live-card cap retires the oldest
 * first. A card whose rows may already be in native scrollback is never
 * removed.
 */
import type { Component } from "@veyyon/tui";
import type { EventControllerContext } from "./event-controller";

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
/**
 * Concurrent IRC cards allowed in the transcript's live region. Cards land
 * below a still-live block (a running task), where they cannot commit to
 * native scrollback (commits are prefix-only) — every visible card inflates
 * the live region and pushes the live block's uncommitted rows above the
 * window top, where they are neither on screen nor in history. A swarm burst
 * (several agents coordinating at once) must therefore stay bounded: the
 * oldest live-region card retires as soon as a new one would exceed the cap.
 */
const MAX_LIVE_IRC_CARDS = 4;

type IrcCardsContext = Pick<EventControllerContext, "chatContainer" | "ui">;

export class IrcCards {
	#expiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// components each card contributed (see #retire for the guard).
	#liveCards = new Map<string, Component[]>();

	constructor(private ctx: IrcCardsContext) {}

	/** Starts the visible TTL of a card just added to the transcript and enforces the live-card cap. */
	track(signature: string, components: Component[]): void {
		this.#scheduleExpiry(signature, components);
		this.#enforceCap(signature);
	}

	/** Forgets every live card and disarms every expiry timer, leaving the cards where they are. */
	clear(): void {
		for (const timer of this.#expiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#expiryTimers.clear();
		this.#liveCards.clear();
	}

	#scheduleExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#expiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#expiryTimers.delete(signature);
			this.#retire(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#expiryTimers.set(signature, timer);
		this.#liveCards.set(signature, components);
	}

	/**
	 * Remove an expired/evicted IRC card — but only while it still sits below a
	 * live block, where its rows cannot have entered native scrollback. Once
	 * everything above it has finalized, its rows may already be committed;
	 * removing them then is an interior deletion of the committed prefix, which
	 * the engine can only repair by recommitting every row below the gap —
	 * exactly the duplicated-block artifact this guard exists to prevent. Such
	 * a card simply stays: it is final history, and the window scrolls past it.
	 */
	#retire(signature: string): void {
		const components = this.#liveCards.get(signature);
		this.#liveCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.isBlockUncommitted(component)) continue;
			this.ctx.chatContainer.removeChild(component);
			removed = true;
		}
		if (removed) this.ctx.ui.requestRender();
	}

	/** Evict oldest live-region cards beyond {@link MAX_LIVE_IRC_CARDS}. */
	#enforceCap(latestSignature: string): void {
		while (this.#liveCards.size > MAX_LIVE_IRC_CARDS) {
			const oldest = this.#liveCards.keys().next().value;
			if (oldest === undefined || oldest === latestSignature) return;
			const timer = this.#expiryTimers.get(oldest);
			if (timer) {
				clearTimeout(timer);
				this.#expiryTimers.delete(oldest);
			}
			this.#retire(oldest);
		}
	}
}
