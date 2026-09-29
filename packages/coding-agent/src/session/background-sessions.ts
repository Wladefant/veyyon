/**
 * The set of conversations this process is running that no screen is showing.
 *
 * A session object both holds a conversation and runs its turn, so a screen that
 * stopped displaying one ended the turn with it. Registering the session here
 * separates the two: the turn runs to completion against a session the UI no
 * longer draws.
 *
 * Callers, none of which is the owner of this registry:
 * - `/new` registers the displayed session and attaches the screen to a new one,
 *   when `session.newKeepsBackground` is on. It passes `session.backgroundLimit`,
 *   and a handoff past that limit stops the oldest running conversation.
 * - `/resume` calls {@link BackgroundSessions.take} to reclaim a registered
 *   session by its transcript, so it re-attaches the live object instead of
 *   replaying that file as finished text. Its picker marks registered
 *   conversations as running and stops one in place through
 *   {@link runningConversations}.
 * - The status line subscribes to the count, because a conversation spending
 *   tokens off-screen has no other surface.
 * - Shutdown calls {@link BackgroundSessions.drain}.
 *
 * A registered session is flushed, never disposed. Disposal tears down the
 * process-wide singletons a top-level session owns — its MCP manager, its async
 * job manager, its eval kernel — and the session the UI moved to inherits them,
 * so ownership stays with the registered session until the process exits. This
 * registry waits for the turn to settle and then persists the transcript.
 *
 * {@link BackgroundSessions.stop} ends a registered conversation's turn through
 * the session's own abort, which closes the provider stream and lets the entry
 * settle and flush like any other.
 */

import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "./agent-session";

/**
 * How long shutdown waits for handed-off background sessions to settle and flush
 * their transcripts before abandoning them. Matches SHUTDOWN_DISPOSE_TIMEOUT_MS:
 * long enough for an in-flight turn to flush, short enough that a wedged turn
 * cannot strand quit forever.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/** Abort reason recorded on a conversation stopped because a newer handoff passed the limit. */
export const BACKGROUND_LIMIT_STOP_REASON = "Stopped: background conversation limit reached";

/**
 * Creates the session a screen attaches to when the one it was displaying is
 * registered as running in the background. Built once from the options the
 * process launched with, so a session started this way carries the same model,
 * prompts, tools and extensions.
 */
export type InteractiveSessionFactory = () => Promise<AgentSession>;

/** A session that is still running after the UI attached to a different one. */
export interface KeptSession {
	readonly session: AgentSession;
	/** Session id at the moment it was handed off. */
	readonly sessionId: string;
	/** Transcript this session writes to, the key `/resume` names it by. */
	readonly sessionFile: string | undefined;
	readonly detachedAt: number;
	/** Monotonic counter disambiguating successive handoffs of the same session object. */
	readonly handoff: number;
	/** Resolves once the turn settled and the transcript was flushed. */
	readonly settled: Promise<void>;
	/** Session ids of the older conversations this handoff stopped to stay within the limit. */
	readonly displaced: readonly string[];
}

export class BackgroundSessions {
	static #instance: BackgroundSessions | undefined;

	#nextHandoff = 0;
	#kept = new Map<AgentSession, KeptSession>();
	/** Registered sessions whose stop is in flight; they no longer count against the limit. */
	#stopping = new Set<AgentSession>();
	static global(): BackgroundSessions {
		BackgroundSessions.#instance ??= new BackgroundSessions();
		return BackgroundSessions.#instance;
	}

	readonly #listeners = new Set<() => void>();

	/** Sessions still finishing their turn, oldest handoff first. */
	get kept(): readonly KeptSession[] {
		return Array.from(this.#kept.values());
	}

	/** How many handed-off sessions have not settled yet. */
	get size(): number {
		return this.#kept.size;
	}

	/**
	 * Watch the set for arrivals and departures. Returns the unsubscribe.
	 *
	 * A conversation that left the screen is spending tokens where nothing draws
	 * it, so the count has to reach the status line the moment it changes rather
	 * than on whatever repaint happens next. Fires after the set is already
	 * updated, so a listener reading {@link size} sees the new value.
	 */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Background session listener failed", { error: errorMessage(error) });
			}
		}
	}

	/**
	 * Take a session the UI no longer displays and let its turn finish.
	 *
	 * `limit` is how many conversations may run here at once. A handoff past it
	 * is accepted and stops the oldest running conversations instead, so the
	 * number of provider streams billing off-screen never exceeds `limit`.
	 *
	 * Idempotent per session: handing the same object over twice returns the
	 * first entry rather than waiting on it twice.
	 */
	keep(session: AgentSession, limit: number): KeptSession {
		if (!(limit >= 1)) {
			throw new RangeError(`session.backgroundLimit must be at least 1, got ${limit}`);
		}
		const existing = this.#kept.get(session);
		if (existing) return existing;
		const running = Array.from(this.#kept.values()).filter(entry => !this.#stopping.has(entry.session));
		const overflow = running.slice(0, Math.max(0, running.length + 1 - limit));
		const sessionId = session.sessionManager.getSessionId();
		const handoff = ++this.#nextHandoff;
		const entry: KeptSession = {
			session,
			sessionId,
			sessionFile: session.sessionManager.getSessionFile(),
			detachedAt: Date.now(),
			handoff,
			settled: this.#settle(session, sessionId, handoff),
			displaced: overflow.map(displaced => displaced.sessionId),
		};
		this.#kept.set(session, entry);
		for (const displaced of overflow) {
			void this.stop(displaced.session, BACKGROUND_LIMIT_STOP_REASON);
		}
		this.#emit();
		return entry;
	}

	/**
	 * End a registered conversation's turn and wait for its entry to settle.
	 *
	 * The session's own abort closes the provider stream; the entry then flushes
	 * its transcript and leaves the set the same way a finished turn does. A
	 * session that is not registered is left alone. An abort that throws is
	 * logged, and the wait still ends when the entry settles.
	 */
	async stop(session: AgentSession, reason: string): Promise<void> {
		const entry = this.#kept.get(session);
		if (!entry) return;
		this.#stopping.add(session);
		try {
			await session.abort({ reason });
		} catch (error) {
			logger.warn("Background conversation failed to stop", {
				sessionId: entry.sessionId,
				error: errorMessage(error),
			});
		}
		await entry.settled;
	}

	/**
	 * The entry describing a session that is on screen rather than handed over.
	 *
	 * `attachMainSession` returns a {@link KeptSession} whether or not anything moved,
	 * and re-attaching the session already displayed moves nothing. Registering it
	 * instead would count a visible conversation in {@link size}, which is the number
	 * the status line shows for conversations nobody is watching.
	 */
	describeAttached(session: AgentSession): KeptSession {
		return (
			this.#kept.get(session) ?? {
				session,
				sessionId: session.sessionManager.getSessionId(),
				sessionFile: session.sessionManager.getSessionFile(),
				detachedAt: Date.now(),
				handoff: 0,
				settled: Promise.resolve(),
				displaced: [],
			}
		);
	}

	/**
	 * Reclaim a kept session by the transcript it writes to, so `/resume` can
	 * re-attach the LIVE object instead of replaying its file as finished text.
	 * It leaves the background set: the UI is displaying it again, and its
	 * pending settle only flushes what the turn already wrote.
	 */
	take(sessionFile: string): AgentSession | undefined {
		const entry = this.find(sessionFile);
		if (!entry) return undefined;
		this.#discard(entry.session, entry.handoff);
		return entry.session;
	}

	/** The registered conversation writing to `sessionFile`, if one is. */
	find(sessionFile: string): KeptSession | undefined {
		const wanted = path.resolve(sessionFile);
		for (const entry of this.#kept.values()) {
			if (entry.sessionFile && path.resolve(entry.sessionFile) === wanted) return entry;
		}
		return undefined;
	}

	/**
	 * Wait for the turns handed off before this call, bounded by `timeoutMs`.
	 * A session that has not settled within the bound is abandoned so shutdown
	 * can proceed.
	 */
	async drain(timeoutMs: number = SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
		if (this.#kept.size === 0) return;
		const snapshot = Array.from(this.#kept.values());
		const unsettled = new Set(snapshot);
		const settled = Promise.all(
			snapshot.map(async entry => {
				await entry.settled;
				unsettled.delete(entry);
			}),
		);
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(timeout.resolve, timeoutMs);
		try {
			await Promise.race([settled, timeout.promise]);
		} finally {
			clearTimeout(timer);
			// An abandoned entry is a transcript that stopped short of its flush.
			// Name them: the only other trace of the loss is a file that ends
			// earlier than the conversation did.
			if (unsettled.size > 0) {
				logger.warn("Background conversations abandoned at shutdown before their transcript flushed", {
					timeoutMs,
					sessions: Array.from(unsettled).map(entry => ({
						sessionId: entry.sessionId,
						sessionFile: entry.sessionFile,
					})),
				});
			}
			for (const entry of snapshot) {
				this.#discard(entry.session, entry.handoff);
			}
		}
	}

	#discard(session: AgentSession, handoff: number): void {
		if (this.#kept.get(session)?.handoff === handoff) {
			this.#kept.delete(session);
			this.#stopping.delete(session);
			this.#emit();
		}
	}

	async #settle(session: AgentSession, sessionId: string, handoff: number): Promise<void> {
		try {
			await session.waitForIdle();
			await session.sessionManager.flush();
		} catch (error) {
			logger.warn("Handed-off session failed to settle", { sessionId, error: errorMessage(error) });
		} finally {
			this.#discard(session, handoff);
		}
	}
}

/** The off-screen conversations a session picker lists, addressed by transcript path. */
export interface RunningConversations {
	/** Whether the conversation writing to `sessionFile` is running off-screen. */
	isRunning(sessionFile: string): boolean;
	/** Abort that conversation's turn and resolve once its entry left the set. */
	stop(sessionFile: string): Promise<void>;
}

/**
 * The picker's view of `keeper`. A stop records `reason` on the aborted turn;
 * a path that names no registered conversation is left alone.
 */
export function runningConversations(keeper: BackgroundSessions, reason: string): RunningConversations {
	return {
		isRunning: sessionFile => keeper.find(sessionFile) !== undefined,
		stop: async sessionFile => {
			const entry = keeper.find(sessionFile);
			if (entry) await keeper.stop(entry.session, reason);
		},
	};
}
