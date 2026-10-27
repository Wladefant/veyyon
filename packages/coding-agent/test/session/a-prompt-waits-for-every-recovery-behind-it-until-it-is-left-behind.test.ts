/**
 * WHY THIS SUITE EXISTS. `prompt()` returns only once the work its turn set off has settled: a retry, the
 * resume a matched TTSR rule holds the turn on, every continuation scheduled behind it, and any stream an
 * outside start began. `TurnContinuations.waitForRecovery` is that wait. A wait that returned early would
 * hand control back while a retry still streams into the transcript; one that never returned would hang
 * the prompt, which happens if it waited on the steer a post-abort drain starts as a fresh turn.
 *
 * THE CLASS. Each thing the wait holds for (retry, TTSR resume, scheduled continuation, outside stream),
 * one starting another while the wait runs, and the two ways it ends: everything settled, or an abort or
 * newer prompt moved the session past the prompt it waits for. Every wait is bounded, so a wait that
 * hangs fails here as a timeout rather than as a stalled session.
 *
 * WHAT IT DOES NOT CATCH. Which prompts run the wait and with which generation; that is the session's
 * prompt path, covered by its own suites.
 */
import { describe, expect, it } from "bun:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { PostPromptTasks } from "@veyyon/coding-agent/session/runtime/post-prompt-tasks";
import { TurnContinuations } from "@veyyon/coding-agent/session/runtime/turn-continuations";

/** What the session in progress holds the wait on; a test sets and clears each one. */
interface InFlight {
	retry: Promise<void> | undefined;
	ttsrResume: Promise<void> | undefined;
	idle: Promise<void>;
	continueRun: Promise<void>;
}

interface FakeSession {
	readonly continuations: TurnContinuations;
	readonly agentState: { isStreaming: boolean };
	readonly state: { generation: number };
	readonly inFlight: InFlight;
}

function fakeSession(): FakeSession {
	const agentState = { isStreaming: false };
	const state = { generation: 1 };
	const inFlight: InFlight = {
		retry: undefined,
		ttsrResume: undefined,
		idle: Promise.resolve(),
		continueRun: Promise.resolve(),
	};
	const tasks = new PostPromptTasks({ promptGeneration: () => state.generation });
	const continuations = new TurnContinuations(tasks, {
		agent: {
			continue: () => inFlight.continueRun,
			waitForIdle: () => inFlight.idle,
			state: agentState,
		},
		promptGeneration: () => state.generation,
		unavailable: () => false,
		disposed: () => false,
		beginTurn: () => {},
		endTurn: () => {},
		restoreFallbackPrimary: async () => {},
		retryGate: () => inFlight.retry,
		ttsrResume: () => inFlight.ttsrResume,
		releaseTtsrResume: () => {},
		postCompactionNudges: () => [],
		promptWith: async () => {},
	});
	return { continuations, agentState, state, inFlight };
}

/** Let every pending microtask and the I/O turn behind it run. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await setImmediate();
}

/** Start `wait` and report whether it has returned, without awaiting it. */
function watch(wait: Promise<void>): { readonly returned: boolean; readonly done: Promise<void> } {
	const watched = { returned: false, done: wait };
	void wait.then(() => {
		watched.returned = true;
	});
	return watched;
}

/** Whether `wait` returns within `ms`; a hang reads as false instead of stalling the suite. */
async function returnsWithin(wait: Promise<void>, ms: number): Promise<boolean> {
	const timedOut = Symbol("timed out");
	return (await Promise.race([wait.then(() => true), setTimeout(ms, timedOut)])) === true;
}

describe("the recovery wait a prompt runs", () => {
	it("returns at once when nothing is in flight", async () => {
		const session = fakeSession();

		expect(await returnsWithin(session.continuations.waitForRecovery(1), 1_000)).toBe(true);
	});

	it("holds until the retry in progress settles", async () => {
		const session = fakeSession();
		const retry = Promise.withResolvers<void>();
		session.inFlight.retry = retry.promise;

		const wait = watch(session.continuations.waitForRecovery(1));
		await flush();
		expect(wait.returned).toBe(false);

		session.inFlight.retry = undefined;
		retry.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("holds until the TTSR resume settles", async () => {
		const session = fakeSession();
		const resume = Promise.withResolvers<void>();
		session.inFlight.ttsrResume = resume.promise;

		const wait = watch(session.continuations.waitForRecovery(1));
		await flush();
		expect(wait.returned).toBe(false);

		session.inFlight.ttsrResume = undefined;
		resume.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("holds until a scheduled continuation's turn settles", async () => {
		const session = fakeSession();
		const run = Promise.withResolvers<void>();
		session.inFlight.continueRun = run.promise;
		session.continuations.scheduleContinue({ generation: 1 });

		const wait = watch(session.continuations.waitForRecovery(1));
		await flush();
		expect(wait.returned).toBe(false);

		run.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("holds until a stream started outside the scheduler goes idle", async () => {
		const session = fakeSession();
		const idle = Promise.withResolvers<void>();
		session.agentState.isStreaming = true;
		session.inFlight.idle = idle.promise;

		const wait = watch(session.continuations.waitForRecovery(1));
		await flush();
		expect(wait.returned).toBe(false);

		session.agentState.isStreaming = false;
		idle.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("holds for a TTSR resume the settling retry started", async () => {
		const session = fakeSession();
		const retry = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		session.inFlight.retry = retry.promise;

		const wait = watch(session.continuations.waitForRecovery(1));
		session.inFlight.retry = undefined;
		session.inFlight.ttsrResume = resume.promise;
		retry.resolve();
		await flush();
		expect(wait.returned).toBe(false);

		session.inFlight.ttsrResume = undefined;
		resume.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("returns without waiting once the session is past the prompt it waits for", async () => {
		const session = fakeSession();
		session.inFlight.retry = new Promise<void>(() => {});
		session.state.generation = 2;

		expect(await returnsWithin(session.continuations.waitForRecovery(1), 1_000)).toBe(true);
	});

	it("returns when an abort moves the session past its prompt while it waits", async () => {
		const session = fakeSession();
		const retry = Promise.withResolvers<void>();
		session.inFlight.retry = retry.promise;

		const wait = watch(session.continuations.waitForRecovery(1));
		await flush();
		expect(wait.returned).toBe(false);

		// The abort bumps the generation; the steer its drain starts as a fresh turn never settles here.
		session.state.generation = 2;
		session.inFlight.retry = undefined;
		session.inFlight.ttsrResume = new Promise<void>(() => {});
		retry.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});

	it("waits on everything in flight when it is given no prompt to track", async () => {
		const session = fakeSession();
		const retry = Promise.withResolvers<void>();
		session.inFlight.retry = retry.promise;
		session.state.generation = 7;

		const wait = watch(session.continuations.waitForRecovery());
		await flush();
		expect(wait.returned).toBe(false);

		session.inFlight.retry = undefined;
		retry.resolve();
		expect(await returnsWithin(wait.done, 1_000)).toBe(true);
	});
});
