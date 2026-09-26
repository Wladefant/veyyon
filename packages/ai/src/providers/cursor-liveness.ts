import * as AIError from "../error";

/**
 * Transport liveness for a Cursor turn, because silence is not death.
 *
 * WHAT WENT WRONG. `cursor-agent` runs its own agent loop server-side: it plans, edits and runs
 * commands on Cursor's machines and emits nothing to this process while it does. The turn was
 * governed by a blind idle timer — 600s of no stream event and the turn was aborted with "Provider
 * stream stalled while waiting for the next event", discarding an assistant message that already
 * carried finished text and up to 35 completed tool calls. In one recorded run of that budget the
 * healthy gaps between events reached 355s, so the budget was a guess sitting a single step above
 * normal behaviour, and it killed seven live turns in under three hours.
 *
 * WHY A TIMER CANNOT DECIDE THIS. The Cursor protocol has no server heartbeat: `agent.v1` carries a
 * `ClientHeartbeat` this process sends and nothing the server sends back, so no length of silence
 * distinguishes a remote agent that is working from a connection that has died. HTTP/2 PING does:
 * the peer must acknowledge it (RFC 9113 §6.7), so an answered probe proves the transport while the
 * stream is quiet, and an unanswered one reports a dead connection in seconds rather than in the ten
 * minutes the idle budget took to notice.
 *
 * WHAT IT STILL BOUNDS. A PING is answered by whatever terminates HTTP/2, which may be an edge in
 * front of a wedged backend, so liveness alone would replace a ten-minute failure with an unbounded
 * hang. {@link CursorLivenessOptions.maxSilentMs} is the ceiling on unbroken server silence and ends
 * the turn even while the probes come back.
 */

/** How the probe ended a turn, which is also what separates the two failure messages. */
type DeathCause = "unacknowledged" | "silence" | "local-work";

export interface CursorLivenessOptions {
	/** Server silence that triggers a probe, and the gap between probes. */
	probeIntervalMs: number;
	/** How long one probe may go unacknowledged before the connection is dead. */
	probeTimeoutMs: number;
	/** Unbroken server silence that ends the turn even while probes are acknowledged. */
	maxSilentMs: number;
	/**
	 * Send one transport probe. Resolves on acknowledgement, rejects when the probe could not be
	 * sent or was not acknowledged in time.
	 */
	probe: () => Promise<void>;
	/**
	 * Whether this process is holding the stream open with work of its own — a tool Cursor asked it
	 * to run. That silence belongs to this side, so it resets the clock rather than ending the turn,
	 * bounded by the same ceiling so a tool that never returns is still reported.
	 */
	hasPendingLocalWork?: () => boolean;
	/** Report the turn-ending failure. Called at most once, and never after {@link CursorLiveness.stop}. */
	onDead: (error: Error) => void;
}

export interface CursorLiveness {
	/** Record that the server sent something. Resets the silence clock. */
	markActivity(): void;
	/** Stop probing. Idempotent, and after it no failure is reported. */
	stop(): void;
}

function deathError(cause: DeathCause, silentMs: number, detail?: unknown): Error {
	const seconds = Math.round(silentMs / 1000);
	if (cause === "unacknowledged") {
		const reason = detail instanceof Error ? `: ${detail.message}` : "";
		return new AIError.ProviderResponseError(
			`Cursor connection stopped answering: no HTTP/2 PING acknowledgement after ${seconds}s of silence${reason}`,
			{ provider: "cursor", kind: "incomplete-stream", cause: detail },
		);
	}
	if (cause === "local-work") {
		return new AIError.StreamTimeoutError(
			`Cursor stream held open for ${seconds}s by a local tool that never completed`,
		);
	}
	return new AIError.StreamTimeoutError(
		`Cursor sent nothing for ${seconds}s while the connection stayed alive; the remote agent is not responding`,
	);
}

/**
 * Start probing. The returned handle is stopped by the turn's `finally`, so a probe never outlives
 * the request that owns it.
 */
export function startCursorLiveness(options: CursorLivenessOptions): CursorLiveness {
	const now = Date.now;
	let lastActivityAt = now();
	// When the last probe was acknowledged. An acknowledgement defers the next probe by one interval
	// but never the silence ceiling, which counts from `lastActivityAt` alone.
	let lastProbeAt = Number.NEGATIVE_INFINITY;
	let localWorkStartedAt: number | undefined;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	// A local tool holding the stream open stands the silence clock down; the hold is capped by the
	// same ceiling as server silence, so a tool that never returns is still reported.
	const maxLocalWorkHoldMs = options.maxSilentMs;

	// The next wakeup is armed from when the silence began, not from a fixed interval phase. A
	// phase-locked interval skips the tick that lands a moment short of a full interval after the last
	// byte, which delays the first probe to almost two intervals and lets a dead connection run into
	// the silence ceiling before its probe can report it. Armed this way, a dead connection is
	// reported within one interval plus one probe timeout of the last byte the server sent.
	const schedule = (): void => {
		if (stopped) return;
		const probeDueAt = Math.max(lastActivityAt, lastProbeAt) + options.probeIntervalMs;
		const dueAt = Math.min(probeDueAt, lastActivityAt + options.maxSilentMs);
		timer = setTimeout(
			() => {
				void tick();
			},
			Math.max(0, dueAt - now()),
		);
		// A probe is never the reason a process stays alive; the turn is.
		timer.unref?.();
	};

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
	};

	const die = (cause: DeathCause, silentMs: number, detail?: unknown): void => {
		if (stopped) return;
		stop();
		options.onDead(deathError(cause, silentMs, detail));
	};

	async function tick(): Promise<void> {
		if (stopped) return;
		const silentMs = now() - lastActivityAt;
		// The server spoke since this wakeup was armed; `markActivity` never re-arms, so a busy
		// stream costs one wakeup per interval rather than one per event.
		if (silentMs < options.probeIntervalMs) {
			schedule();
			return;
		}

		if (options.hasPendingLocalWork?.() === true) {
			localWorkStartedAt ??= lastActivityAt;
			if (now() - localWorkStartedAt >= maxLocalWorkHoldMs) {
				die("local-work", now() - localWorkStartedAt);
				return;
			}
			lastActivityAt = now();
			schedule();
			return;
		}
		localWorkStartedAt = undefined;

		if (silentMs >= options.maxSilentMs) {
			die("silence", silentMs);
			return;
		}
		if (now() - lastProbeAt < options.probeIntervalMs) {
			schedule();
			return;
		}
		try {
			await withTimeout(options.probe(), options.probeTimeoutMs);
		} catch (error) {
			// A probe that was refused, errored or went unanswered is the transport
			// itself reporting, which is the one signal silence never carries.
			die("unacknowledged", now() - lastActivityAt, error);
			return;
		}
		// An acknowledgement proves the connection, NOT progress: the silence clock
		// keeps running so `maxSilentMs` still governs a wedged backend behind a
		// healthy edge.
		lastProbeAt = now();
		schedule();
	}

	schedule();

	return {
		markActivity: () => {
			lastActivityAt = now();
			localWorkStartedAt = undefined;
		},
		stop,
	};
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
	const { promise: expiry, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`probe unanswered after ${timeoutMs}ms`)), timeoutMs);
	timer.unref?.();
	try {
		await Promise.race([promise, expiry]);
	} finally {
		clearTimeout(timer);
	}
}
