/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * A `cursor-agent` turn was governed by a blind idle timer: 600s with no stream event and the turn
 * was aborted with "Provider stream stalled while waiting for the next event". The remote agent
 * plans, edits and runs commands on Cursor's side and emits no progress while it does, so the timer
 * was guessing. In one recorded session the healthy gaps between events reached 355s and seven
 * turns died at exactly 600s, each discarding finished text and up to 35 completed tool calls.
 *
 * The class this closes is "silence read as death, and death read as silence". A turn now ends on
 * what the transport says — an HTTP/2 PING the peer must acknowledge — plus one ceiling on time
 * without progress that a live transport cannot excuse:
 *
 *   - a quiet stream whose connection answers keeps running;
 *   - a connection that stops answering fails in seconds, well before that ceiling;
 *   - a connection that answers while the backend emits nothing still ends, at the ceiling;
 *   - a connection that sends only heartbeats still ends, at the ceiling: the server sends an
 *     `interactionUpdate.heartbeat` every ten seconds whether or not its agent works, and counting
 *     those bytes as activity held a wedged turn open for over forty minutes;
 *   - a local tool holding the stream open holds the clock, bounded by the same ceiling, and a
 *     tool that never returns cannot keep the resulting failure, or an abort, from ending the turn.
 *
 * The governor is driven on a fake clock. The end-to-end cases drive the real provider over a real
 * HTTP/2 connection, where a fake clock cannot reach the kernel's sockets, and the dead-connection
 * case black-holes a TCP relay, which is what a half-open socket does and what no `socket.destroy()`
 * can imitate.
 *
 * WHAT IT DOES NOT CATCH: whether Cursor's own backend is healthy, and whether an edge in front of
 * a wedged backend answers PINGs on its behalf — that is precisely why the ceiling exists and is
 * asserted here rather than assumed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import * as net from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import * as AIError from "@veyyon/ai/error";
import { type CursorOptions, streamCursor } from "@veyyon/ai/providers/cursor";
import { startCursorLiveness } from "@veyyon/ai/providers/cursor-liveness";
import type { AssistantMessage, AssistantMessageEvent, Context, CursorExecHandlers, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	GrepArgsSchema,
	HeartbeatUpdateSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

/** Advance the fake clock in small steps, draining the microtasks each probe schedules. */
async function advance(totalMs: number, stepMs = 10): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
		vi.advanceTimersByTime(stepMs);
		for (let drain = 0; drain < 20; drain++) await Promise.resolve();
	}
}

function frame(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

function heartbeatFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

/** The server asking this process to run a local grep, which is how a local tool holds the turn. */
function grepExecFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-wedged-1",
				message: { case: "grepArgs", value: create(GrepArgsSchema, { pattern: "p" }) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

/** Write a heartbeat every `everyMs` until the stream closes, as Cursor's server does. */
function sendHeartbeats(stream: http2.ServerHttp2Stream, everyMs: number): void {
	const timer = setInterval(() => {
		if (stream.closed || stream.destroyed) {
			clearInterval(timer);
			return;
		}
		stream.write(heartbeatFrame());
	}, everyMs);
	timer.unref?.();
	stream.on("close", () => clearInterval(timer));
}

/** A grep handler whose work never settles: a local tool that is wedged. */
const wedgedGrep: CursorExecHandlers = {
	grep: () => Promise.withResolvers<never>().promise,
};

/** Fail rather than hang when `turn` outlives `boundMs`, so a regression reports a bound, not a timeout. */
async function endsWithin<T>(turn: Promise<T>, boundMs: number): Promise<T> {
	const { promise: expired, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`the turn did not end within ${boundMs}ms`)), boundMs);
	try {
		return await Promise.race([turn, expired]);
	} finally {
		clearTimeout(timer);
	}
}

const cursorModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

interface Closable {
	close: () => Promise<void>;
}

const openServers: Closable[] = [];

afterEach(async () => {
	vi.useRealTimers();
	while (openServers.length > 0) await openServers.pop()?.close();
});

/**
 * A localhost h2c server that answers, then behaves as `onStream` says. It never ends the stream on
 * its own, so silence is the default and each test decides what breaks it.
 */
async function startCursorServer(onStream: (stream: http2.ServerHttp2Stream) => void): Promise<number> {
	const server = http2.createServer();
	server.on("session", session => session.on("error", () => {}));
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("error", () => {});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		onStream(stream);
	});
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve(typeof address === "object" && address ? address.port : 0);
	});
	const port = await promise;
	openServers.push({
		close: () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		},
	});
	return port;
}

/**
 * A TCP relay to `port` that stops forwarding in both directions once `blackholeAfterMs` elapses,
 * without closing anything. This is a half-open connection: every write still succeeds locally and
 * nothing ever comes back, which is the failure a timer cannot tell from a busy remote agent.
 */
async function startBlackholeRelay(port: number, blackholeAfterMs: number): Promise<number> {
	const sockets: net.Socket[] = [];
	const relay = net.createServer(downstream => {
		sockets.push(downstream);
		const upstream = net.connect(port, "127.0.0.1");
		sockets.push(upstream);
		let dropped = false;
		const drop = setTimeout(() => {
			dropped = true;
		}, blackholeAfterMs);
		drop.unref?.();
		downstream.on("data", chunk => {
			if (!dropped) upstream.write(chunk);
		});
		upstream.on("data", chunk => {
			if (!dropped) downstream.write(chunk);
		});
		for (const socket of [downstream, upstream]) {
			socket.on("error", () => {});
			socket.on("close", () => clearTimeout(drop));
		}
	});
	const { promise, resolve } = Promise.withResolvers<number>();
	relay.listen(0, "127.0.0.1", () => {
		const address = relay.address();
		resolve(typeof address === "object" && address ? address.port : 0);
	});
	const relayPort = await promise;
	openServers.push({
		close: () => {
			for (const socket of sockets) socket.destroy();
			const done = Promise.withResolvers<void>();
			relay.close(() => done.resolve());
			return done.promise;
		},
	});
	return relayPort;
}

interface TurnOutcome {
	message: AssistantMessage;
	events: AssistantMessageEvent[];
}

/**
 * `streamIdleTimeoutMs` is the silence ceiling a caller pins, and the probe cadence derives from it
 * (a third of it), so a test names one number and gets a proportional probe.
 */
async function runTurn(
	port: number,
	silenceCeilingMs: number,
	extra: Partial<CursorOptions> = {},
): Promise<TurnOutcome> {
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of streamCursor(cursorModel(`http://127.0.0.1:${port}`), context, {
		apiKey: "test-token",
		streamIdleTimeoutMs: silenceCeilingMs,
		...extra,
	})) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("stream produced no terminal event");
	return { message, events };
}

describe("cursor liveness governor", () => {
	it("keeps a quiet turn alive while the connection answers", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		let probes = 0;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 600_000,
			probe: async () => {
				probes++;
			},
			onDead: error => {
				died = error;
			},
		});

		await advance(60_000, 50);
		liveness.stop();

		// The point of the whole change: silence alone never ends a turn. Ten minutes of it,
		// which is exactly what the old budget killed.
		expect(died).toBeUndefined();
		expect(probes).toBeGreaterThan(10);
	});

	it("ends the turn when a probe goes unacknowledged", async () => {
		vi.useFakeTimers();
		const { promise: neverAnswers } = Promise.withResolvers<void>();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 600_000,
			probe: () => neverAnswers,
			onDead: error => {
				died = error;
			},
		});

		await advance(400, 10);
		liveness.stop();

		expect(died?.message).toMatch(/stopped answering/);
		expect(died).toBeInstanceOf(AIError.ProviderResponseError);
		// Transient, so the turn is retried rather than walled: a dead socket is not a request
		// the provider refused.
		expect(AIError.isProviderRetryableError(died)).toBe(true);
	});

	// A server byte that lands just after the probe timer was armed must not push the first probe out
	// by a whole extra interval. With a phase-locked timer it did: the tick one interval in fell a
	// moment short of a full interval of silence and was skipped, so a dead connection was reported
	// at two intervals plus the probe timeout, which at a ceiling of three intervals is the ceiling.
	it("reports a dead connection within one interval and one probe timeout of the last byte", async () => {
		vi.useFakeTimers();
		const { promise: neverAnswers } = Promise.withResolvers<void>();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 100,
			probeTimeoutMs: 100,
			maxSilentMs: 300,
			probe: () => neverAnswers,
			onDead: error => {
				died = error;
			},
		});

		await advance(10, 10);
		liveness.markProgress();
		await advance(210, 10);
		liveness.stop();

		expect(died?.message).toMatch(/stopped answering/);
	});

	it("ends the turn when a probe is refused outright", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 600_000,
			probe: () => Promise.reject(new Error("the HTTP/2 session refused the ping")),
			onDead: error => {
				died = error;
			},
		});

		await advance(200, 10);
		liveness.stop();

		expect(died?.message).toMatch(/stopped answering.*refused the ping/);
	});

	it("ends a turn whose connection answers while the backend emits nothing", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 300,
			probe: () => Promise.resolve(),
			onDead: error => {
				died = error;
			},
		});

		await advance(1_000, 10);
		liveness.stop();

		// An edge answering PINGs for a wedged backend is the case liveness alone cannot see.
		expect(died?.message).toMatch(/made no progress for/);
		expect(died).toBeInstanceOf(AIError.StreamTimeoutError);
	});

	it("ends a turn whose server sends only heartbeats, at the ceiling", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		let probes = 0;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 300,
			probe: async () => {
				probes++;
			},
			onDead: error => {
				died = error;
			},
		});

		for (let tick = 0; tick < 100 && died === undefined; tick++) {
			await advance(10, 10);
			liveness.markTransport();
		}
		liveness.stop();

		expect(died?.message).toMatch(/made no progress for/);
		// Heartbeats prove the connection as well as a probe does, so none is sent while they flow.
		expect(probes).toBe(0);
	});

	it("bounds a local tool hold even while heartbeats keep arriving", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 400,
			hasPendingLocalWork: () => true,
			probe: () => Promise.resolve(),
			onDead: error => {
				died = error;
			},
		});

		for (let tick = 0; tick < 150 && died === undefined; tick++) {
			await advance(10, 10);
			liveness.markTransport();
		}
		liveness.stop();

		expect(died?.message).toMatch(/held open for .* by a local tool that never completed/);
	});

	it("lets a local tool hold the clock, and bounds the hold by the same ceiling", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 400,
			hasPendingLocalWork: () => true,
			probe: () => Promise.resolve(),
			onDead: error => {
				died = error;
			},
		});

		await advance(200, 10);
		// Still running a tool Cursor asked for: that silence is ours, not the provider's.
		expect(died).toBeUndefined();

		await advance(1_000, 10);
		liveness.stop();

		expect(died?.message).toMatch(/held open for .* by a local tool that never completed/);
	});

	it("reports nothing once stopped", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 100,
			probe: () => Promise.reject(new Error("dead")),
			onDead: error => {
				died = error;
			},
		});

		liveness.stop();
		await advance(1_000, 10);

		expect(died).toBeUndefined();
	});

	it("restarts the clock on every message that advances the turn", async () => {
		vi.useFakeTimers();
		let died: Error | undefined;
		const liveness = startCursorLiveness({
			probeIntervalMs: 50,
			probeTimeoutMs: 50,
			maxSilentMs: 300,
			probe: () => Promise.resolve(),
			onDead: error => {
				died = error;
			},
		});

		for (let tick = 0; tick < 20; tick++) {
			await advance(100, 10);
			liveness.markProgress();
		}
		liveness.stop();

		// Two seconds of turn against a 300ms ceiling, and it survives because the stream moved.
		expect(died).toBeUndefined();
	});
});

// Real sockets, therefore the real clock: a fake timer cannot drive an HTTP/2 PING through the
// kernel, and a half-open connection is only observable by holding one open. Every ceiling here is
// in the low seconds so the suite pays milliseconds, not the production ceiling.
describe("cursor turn over a real connection", () => {
	it("survives a silent stretch and completes when the turn ends", async () => {
		const port = await startCursorServer(stream => {
			setTimeout(() => {
				stream.write(turnEndedFrame());
				stream.end();
			}, 1_000).unref?.();
		});

		const outcome = await runTurn(port, 2_400);

		expect(outcome.message.stopReason).not.toBe("error");
		expect(outcome.events.at(-1)?.type).toBe("done");
	}, 20_000);

	it("names the transport, not the ceiling, when the connection stops answering", async () => {
		const port = await startCursorServer(() => {
			// Answers the request and then says nothing, forever.
		});
		const relayPort = await startBlackholeRelay(port, 150);

		const outcome = await runTurn(relayPort, 3_000);

		// Which of the two ways a turn can end is the whole question: the transport
		// reported it, rather than a clock running out on a connection nobody asked
		// about. How much sooner that happens is the governor's, proved on the fake
		// clock above, where an unacknowledged probe ends a turn inside 400ms of a
		// ten-minute ceiling. Here the probe cadence is a third of a three-second
		// ceiling and a dead connection is reported within one interval plus one
		// probe timeout of the last byte, a full second before the ceiling, so only
		// the cause distinguishes them.
		expect(outcome.message.errorMessage).toMatch(/stopped answering/);
		expect(outcome.message.errorMessage).not.toMatch(/made no progress for/);
		// Transient: a dead socket is retried, not treated as a refusal.
		expect(AIError.is(outcome.message.errorId, AIError.Flag.Transient)).toBe(true);
	}, 20_000);

	it("ends a turn the server never finishes, at the ceiling", async () => {
		const port = await startCursorServer(() => {
			// A live connection that emits nothing: PINGs are answered by the server's HTTP/2
			// layer while the turn never progresses.
		});

		const ceilingMs = 1_500;
		const outcome = await runTurn(port, ceilingMs);

		expect(outcome.message.stopReason).toBe("error");
		expect(outcome.message.errorMessage).toMatch(/made no progress for/);
	}, 20_000);

	it("ends a turn whose server sends only heartbeats, at the ceiling", async () => {
		const port = await startCursorServer(stream => sendHeartbeats(stream, 100));

		const ceilingMs = 1_500;
		const outcome = await endsWithin(runTurn(port, ceilingMs), ceilingMs + 3_000);

		expect(outcome.message.stopReason).toBe("error");
		expect(outcome.message.errorMessage).toMatch(/made no progress for/);
	}, 20_000);

	it("ends a turn held by a wedged local tool, at the ceiling", async () => {
		const port = await startCursorServer(stream => {
			stream.write(grepExecFrame());
			sendHeartbeats(stream, 100);
		});

		const ceilingMs = 1_500;
		const outcome = await endsWithin(runTurn(port, ceilingMs, { execHandlers: wedgedGrep }), ceilingMs + 3_000);

		expect(outcome.message.stopReason).toBe("error");
		expect(outcome.message.errorMessage).toMatch(/held open for .* by a local tool that never completed/);
	}, 20_000);

	it("ends a turn held by a wedged local tool when the caller aborts", async () => {
		const port = await startCursorServer(stream => {
			stream.write(grepExecFrame());
			sendHeartbeats(stream, 100);
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300).unref?.();

		// A ceiling far past the bound, so only the abort can end the turn in time.
		const outcome = await endsWithin(
			runTurn(port, 60_000, { execHandlers: wedgedGrep, signal: controller.signal }),
			3_000,
		);

		expect(outcome.message.stopReason).toBe("aborted");
	}, 20_000);
});
