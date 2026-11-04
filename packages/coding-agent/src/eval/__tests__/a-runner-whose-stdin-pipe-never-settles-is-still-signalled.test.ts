import { describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { BaseKernel } from "../kernel-base";

// WHY THIS SUITE EXISTS (issue 639: eval runners outlive their session)
// --------------------------------------------------------------------
// `BaseKernel.shutdown` used to await the graceful exit request itself: the exit
// payload write, then `stdin.end()`. A runner blocked in user code never drains stdin,
// so a pending pipe operation held shutdown before it reached SIGTERM or SIGKILL, and
// the interpreter outlived its session. Shutdown now sends the graceful request
// detached, so escalation starts on the grace timer whatever the pipe does. `#writeLine`
// starts each flush without awaiting it, and a rejected flush is caught and logged, so it
// is contained rather than surfacing as an unhandled rejection.
//
// Only the OS process is faked, through the seam `kernel-shutdown-confirm.test.ts`
// uses. The kernel's own grace timers run for real, and a regression that blocks
// escalation leaves the test pending until the bun timeout fails it. The suite checks
// which signals the process received and whether shutdown confirmed.
//
// Gap: the flush-hang case passes on the pre-change code too, because that code never
// awaited the flush either. The execute() cases below guard the same path against a future
// await. The rejected-flush case covers the one behaviour this change moves: the old code
// left that rejection unhandled.

const EXIT_PAYLOAD = JSON.stringify({ type: "exit" });

type PipeOutcome = "settle" | "hang" | "reject";

const BROKEN_PIPE = Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write" });

function pipeOutcome(outcome: PipeOutcome): Promise<void> {
	switch (outcome) {
		case "settle":
			return Promise.resolve();
		case "hang":
			return new Promise<void>(() => {});
		case "reject":
			return Promise.reject(BROKEN_PIPE);
	}
}

class TestKernel extends BaseKernel {}

interface RunnerBehaviour {
	/** Whether the runner exits when it receives the graceful exit request. */
	exitOnPayload: boolean;
	/** Signals that end the runner's process. */
	exitOnSignals: readonly string[];
	flush?: PipeOutcome;
	end?: PipeOutcome;
}

function createKernel(behaviour: RunnerBehaviour): { kernel: BaseKernel; writes: string[]; signals: string[] } {
	const writes: string[] = [];
	const signals: string[] = [];
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number | null>();
	const closedStream = () => new ReadableStream<Uint8Array>({ start: controller => controller.close() });
	const proc = {
		stdin: {
			write: (chunk: string): number => {
				writes.push(chunk);
				if (chunk.trim() === EXIT_PAYLOAD && behaviour.exitOnPayload) resolveExit(0);
				return chunk.length;
			},
			flush: () => pipeOutcome(behaviour.flush ?? "settle"),
			end: () => pipeOutcome(behaviour.end ?? "settle"),
		},
		stdout: closedStream(),
		stderr: closedStream(),
		exited,
		kill: (signal?: string | number) => {
			const name = typeof signal === "string" ? signal : "SIGTERM";
			signals.push(name);
			if (behaviour.exitOnSignals.includes(name)) resolveExit(null);
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	const kernel = new TestKernel("runner", {
		languageName: "Test",
		traceIpc: false,
		exitPayload: EXIT_PAYLOAD,
		interruptEscalationMs: 20,
		shutdownGraceMs: 20,
		buildPayload: (code, msgId) => JSON.stringify({ type: "exec", id: msgId, code }),
	});
	kernel.setProcess(proc);
	return { kernel, writes, signals };
}

describe("BaseKernel.shutdown with a stuck stdin pipe", () => {
	it("an end that never settles still escalates to SIGTERM and confirms once the runner exits", async () => {
		const { kernel, writes, signals } = createKernel({ exitOnPayload: false, exitOnSignals: ["SIGTERM"], end: "hang" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(signals).toEqual(["SIGTERM"]);
		expect(writes.some(line => line.trim() === EXIT_PAYLOAD)).toBe(true);
	});

	it("an end that never settles reaches SIGKILL and confirms only when that kill makes the runner exit", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: false, exitOnSignals: ["SIGKILL"], end: "hang" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("an end that never settles and a runner that never exits reports unconfirmed after SIGKILL", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: false, exitOnSignals: [], end: "hang" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(false);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("a flush that never settles does not hold back the graceful request or the SIGTERM escalation", async () => {
		const { kernel, writes, signals } = createKernel({ exitOnPayload: false, exitOnSignals: ["SIGTERM"], flush: "hang" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(writes.some(line => line.trim() === EXIT_PAYLOAD)).toBe(true);
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("a rejected flush while requesting exit is contained: the runner exits and shutdown confirms without a kill", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: true, exitOnSignals: [], flush: "reject" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(signals).toEqual([]);
	});

	it("an execute whose flush never settles still completes when its timeout fires", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: false, exitOnSignals: ["SIGINT"], flush: "hang" });

		const result = await kernel.execute("1 + 1", { timeoutMs: 20 });

		expect(result.status).toBe("error");
		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(signals).toEqual(["SIGINT"]);
	});

	it("an execute whose flush never settles still completes when its signal aborts", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: false, exitOnSignals: ["SIGINT"], flush: "hang" });
		const abort = new AbortController();

		const running = kernel.execute("1 + 1", { signal: abort.signal });
		abort.abort(new Error("lane cancelled"));
		const result = await running;

		expect(result.cancelled).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(signals).toEqual(["SIGINT"]);
	});

	it("a rejected end with a runner that never exits still escalates and reports unconfirmed", async () => {
		const { kernel, signals } = createKernel({ exitOnPayload: false, exitOnSignals: [], end: "reject" });

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(false);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
