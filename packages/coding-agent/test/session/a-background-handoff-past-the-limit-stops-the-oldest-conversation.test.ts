/**
 * A handoff past `session.backgroundLimit` stops the oldest background conversation.
 *
 * WHY THIS SUITE EXISTS: `BackgroundSessions.keep` had no cap, so repeated `/new` with
 * `session.newKeepsBackground` on grew the set without limit and put no bound on how many provider
 * streams billed off-screen at once. The class is "more conversations streaming off-screen than
 * the limit": every case asserts the count of conversations whose stream was not stopped, not only
 * which entry left the set.
 *
 * Not caught: a conversation whose own abort ignores its signal (its stream is asked to stop and
 * the entry leaves the set when its turn settles, however long that takes), and the text `/new`
 * prints, which the controller suite owns.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BACKGROUND_LIMIT_STOP_REASON, BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";

interface FakeConversation {
	readonly id: string;
	readonly aborts: string[];
	readonly session: AgentSession;
	/** True until its turn ends, by finishing or by an abort. */
	streaming(): boolean;
	/** Ends the turn the way a finished response does. */
	finish(): void;
}

/**
 * A conversation whose turn runs until it finishes or is aborted. `abortSettles` false models an
 * abort still unwinding: the stream is asked to stop, the turn has not ended yet.
 */
function conversation(id: string, abortSettles = true): FakeConversation {
	const turn = Promise.withResolvers<void>();
	let running = true;
	const aborts: string[] = [];
	const end = () => {
		running = false;
		turn.resolve();
	};
	const session = {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/repo/sessions/${id}.jsonl`,
			flush: async () => {},
		},
		waitForIdle: () => turn.promise,
		abort: async (options?: { reason?: string }) => {
			aborts.push(options?.reason ?? "");
			if (abortSettles) end();
		},
	} as unknown as AgentSession;
	return { id, aborts, session, streaming: () => running && aborts.length === 0, finish: end };
}

function streamingCount(conversations: readonly FakeConversation[]): number {
	return conversations.filter(c => c.streaming()).length;
}

describe("the background conversation limit", () => {
	afterEach(async () => {
		await BackgroundSessions.global().drain(100);
	});

	for (const limit of [1, 2, 3]) {
		it(`keeps at most ${limit} conversation(s) streaming and stops the oldest first`, async () => {
			const keeper = BackgroundSessions.global();
			const conversations = Array.from({ length: limit + 2 }, (_, i) => conversation(`session-${i}`));
			const entries = conversations.map(c => keeper.keep(c.session, limit));

			// The two oldest are stopped, each by the handoff that pushed it past the limit.
			expect(conversations.map(c => c.aborts)).toEqual(
				conversations.map((_, i) => (i < 2 ? [BACKGROUND_LIMIT_STOP_REASON] : [])),
			);
			expect(entries.map(entry => entry.displaced)).toEqual(
				conversations.map((_, i) => (i >= limit && i - limit < 2 ? [`session-${i - limit}`] : [])),
			);
			expect(streamingCount(conversations)).toBe(limit);

			await Promise.all(entries.slice(0, 2).map(entry => entry.settled));
			expect(keeper.kept.map(entry => entry.sessionId)).toEqual(conversations.slice(2).map(c => c.id));
			for (const c of conversations.slice(2)) c.finish();
		});
	}

	/**
	 * A stop still unwinding does not count against the limit. Counting it would stop a second
	 * conversation to make room that the first stop already made.
	 */
	it("does not stop an extra conversation while an earlier stop is still unwinding", () => {
		const keeper = BackgroundSessions.global();
		const first = conversation("session-a", false);
		const second = conversation("session-b", false);
		const third = conversation("session-c", false);

		keeper.keep(first.session, 1);
		keeper.keep(second.session, 1);
		keeper.keep(third.session, 1);

		expect(first.aborts).toEqual([BACKGROUND_LIMIT_STOP_REASON]);
		expect(second.aborts).toEqual([BACKGROUND_LIMIT_STOP_REASON]);
		expect(third.aborts).toEqual([]);
		expect(streamingCount([first, second, third])).toBe(1);
		for (const c of [first, second, third]) c.finish();
	});

	it("accepts the handoff that reaches the limit without stopping anything", () => {
		const keeper = BackgroundSessions.global();
		const conversations = [conversation("session-a"), conversation("session-b")];

		for (const c of conversations) expect(keeper.keep(c.session, 2).displaced).toEqual([]);

		expect(conversations.map(c => c.aborts)).toEqual([[], []]);
		expect(keeper.size).toBe(2);
		for (const c of conversations) c.finish();
	});

	for (const limit of [0, -1, Number.NaN]) {
		it(`rejects a limit of ${limit} and registers nothing`, () => {
			const keeper = BackgroundSessions.global();
			const only = conversation("session-a");

			expect(() => keeper.keep(only.session, limit)).toThrow(RangeError);
			expect(keeper.size).toBe(0);
			only.finish();
		});
	}
});

describe("stopping a background conversation", () => {
	afterEach(async () => {
		await BackgroundSessions.global().drain(100);
	});

	it("aborts its turn with the given reason and waits for its entry to leave the set", async () => {
		const keeper = BackgroundSessions.global();
		const only = conversation("session-a");
		keeper.keep(only.session, 3);

		await keeper.stop(only.session, "Stopped from the process manager");

		expect(only.aborts).toEqual(["Stopped from the process manager"]);
		expect(keeper.size).toBe(0);
	});

	it("leaves a session that is not registered alone", async () => {
		const stranger = conversation("session-a");

		await BackgroundSessions.global().stop(stranger.session, "Stopped from the process manager");

		expect(stranger.aborts).toEqual([]);
		stranger.finish();
	});
});
