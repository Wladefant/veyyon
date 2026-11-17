import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	message?: string;
	evalue?: string;
	bundle?: Record<string, unknown>;
	cancelled?: boolean;
	cancellationPending?: boolean;
}

interface FrameWaiter {
	matches(frame: RunnerFrame): boolean;
	resolve(frame: RunnerFrame): void;
}

interface RunnerClient {
	send(message: object): Promise<void>;
	nextMatchingFrame(matches: (frame: RunnerFrame) => boolean): Promise<RunnerFrame>;
	bufferedFrames(matches?: (frame: RunnerFrame) => boolean): RunnerFrame[];
	close(): Promise<void>;
}

const pythonPath = Bun.env.PYTHON ?? "python3";
const runnerPath = path.resolve(import.meta.dir, "../py/runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const lines = (...source: string[]) => source.join(String.fromCharCode(10));

function spawnRunner(): RunnerClient {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	let pending = "";
	const queued: RunnerFrame[] = [];
	const waiters: FrameWaiter[] = [];
	const pump = (async () => {
		try {
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					const frame = JSON.parse(line) as RunnerFrame;
					const waiterIndex = waiters.findIndex(waiter => waiter.matches(frame));
					if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0]!.resolve(frame);
					else queued.push(frame);
					continue;
				}
				const { value, done } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
			}
		} catch (error) {
			for (const waiter of waiters.splice(0)) waiter.resolve({ type: "reader-error", message: String(error) });
		}
	})();
	return {
		async send(message) {
			await proc.stdin.write(encoder.encode(`${JSON.stringify(message)}\n`));
			await proc.stdin.flush();
		},
		async nextMatchingFrame(matches) {
			const index = queued.findIndex(matches);
			if (index >= 0) return queued.splice(index, 1)[0]!;
			const { promise, resolve } = Promise.withResolvers<RunnerFrame>();
			waiters.push({ matches, resolve });
			return await promise;
		},
		bufferedFrames(matches) {
			return matches ? queued.filter(matches) : [...queued];
		},
		async close() {
			try {
				await proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
				await proc.stdin.flush();
				proc.stdin.end();
			} catch {
				/* process already ended */
			}
			if (proc.exitCode === null) proc.kill("SIGKILL");
			await proc.exited;
			await pump;
			try {
				reader.releaseLock();
			} catch {
				/* stream already closed */
			}
			await stderr;
		},
	};
}

async function frameFor(runner: RunnerClient, id: string, types: string[]): Promise<RunnerFrame> {
	return await runner.nextMatchingFrame(frame => frame.id === id && types.includes(frame.type ?? ""));
}

async function doneFor(runner: RunnerClient, id: string): Promise<RunnerFrame> {
	return await frameFor(runner, id, ["done"]);
}

async function submit(runner: RunnerClient, id: string, code: string): Promise<void> {
	await runner.send({ id, code });
}

async function submitAndDone(
	runner: RunnerClient,
	id: string,
	code: string,
): Promise<RunnerFrame & { result: unknown }> {
	await submit(runner, id, code);
	const frames: RunnerFrame[] = [];
	while (true) {
		const frame = await runner.nextMatchingFrame(candidate => candidate.id === id);
		frames.push(frame);
		if (frame.type === "done") {
			return { ...frame, result: frames.find(item => item.type === "result")?.bundle?.["text/plain"] };
		}
	}
}

describe("Python runner request-specific cancellation protocol", () => {
	it("cancels async request A without interrupting B or losing the shared namespace", async () => {
		const runner = spawnRunner();
		try {
			await submit(
				runner,
				"seed",
				lines("import asyncio", "release_b = asyncio.Event()", "shared_sentinel = 'retained'"),
			);
			expect((await doneFor(runner, "seed")).status).toBe("ok");
			await submit(runner, "async-a", lines("print('A_STARTED', flush=True)", "await release_b.wait()"));
			expect((await frameFor(runner, "async-a", ["started"])).type).toBe("started");
			await frameFor(runner, "async-a", ["stdout"]);
			await submit(
				runner,
				"async-b",
				lines(
					"print('B_STARTED', flush=True)",
					"await release_b.wait()",
					"print('B_FINISHED', flush=True)",
					"shared_sentinel",
				),
			);
			expect((await frameFor(runner, "async-b", ["started"])).type).toBe("started");
			await frameFor(runner, "async-b", ["stdout"]);
			await runner.send({ type: "cancel", id: "async-a" });
			await submit(runner, "release-b", "release_b.set()");
			expect((await doneFor(runner, "release-b")).status).toBe("ok");
			expect((await doneFor(runner, "async-a")).status).toBe("error");
			expect((await doneFor(runner, "async-b")).status).toBe("ok");
			const retained = await submitAndDone(runner, "check-shared", "shared_sentinel");
			expect(retained.status).toBe("ok");
			expect(retained.result).toBe("'retained'");
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("allows an async parent to resume after a child-like same-kernel request", async () => {
		// This covers raw protocol reentrancy; the actual agent bridge case lives in agent-bridge.test.ts.
		const runner = spawnRunner();
		try {
			await submit(runner, "seed", lines("import asyncio", "bridge_done = asyncio.Event()"));
			expect((await doneFor(runner, "seed")).status).toBe("ok");
			await submit(
				runner,
				"parent",
				lines(
					"print('PARENT_STARTED', flush=True)",
					"await bridge_done.wait()",
					"print('PARENT_FINISHED', flush=True)",
				),
			);
			expect((await frameFor(runner, "parent", ["started"])).type).toBe("started");
			await frameFor(runner, "parent", ["stdout"]);
			await submit(
				runner,
				"child",
				lines("print('CHILD_STARTED', flush=True)", "bridge_done.set()", "print('CHILD_FINISHED', flush=True)"),
			);
			expect((await frameFor(runner, "child", ["started"])).type).toBe("started");
			expect((await doneFor(runner, "parent")).status).toBe("ok");
			expect((await doneFor(runner, "child")).status).toBe("ok");
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("cancels a queued request before it starts without affecting the active sync request", async () => {
		const runner = spawnRunner();
		try {
			await submit(
				runner,
				"sync-active",
				lines(
					"print('SYNC_ACTIVE_STARTED', flush=True)",
					"for _ in range(5_000_000): pass",
					"print('SYNC_ACTIVE_FINISHED', flush=True)",
				),
			);
			expect((await frameFor(runner, "sync-active", ["started"])).type).toBe("started");
			await frameFor(runner, "sync-active", ["stdout"]);
			await submit(runner, "queued-cancel", "raise RuntimeError('CANCELLED_SOURCE_RAN')");
			await runner.send({ type: "cancel", id: "queued-cancel" });
			expect((await doneFor(runner, "sync-active")).status).toBe("ok");
			const queuedFrames: RunnerFrame[] = [];
			while (true) {
				const frame = await runner.nextMatchingFrame(candidate => candidate.id === "queued-cancel");
				queuedFrames.push(frame);
				if (frame.type === "done") break;
			}
			expect(queuedFrames.some(frame => frame.type === "started")).toBe(true);
			expect(queuedFrames.find(frame => frame.type === "done")?.status).toBe("error");
			expect(
				queuedFrames.some(frame => frame.type === "error" && frame.evalue?.includes("CANCELLED_SOURCE_RAN")),
			).toBe(false);
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("interrupts only the targeted active synchronous loop and accepts the next cell", async () => {
		const runner = spawnRunner();
		try {
			await submit(runner, "loop-target", lines("print('LOOP_STARTED', flush=True)", "while True: pass"));
			expect((await frameFor(runner, "loop-target", ["started"])).type).toBe("started");
			await frameFor(runner, "loop-target", ["stdout"]);
			await runner.send({ type: "cancel", id: "loop-target" });
			expect((await doneFor(runner, "loop-target")).status).toBe("error");
			const after = await submitAndDone(runner, "after-loop", lines("print('NEXT_CELL_OK', flush=True)", "42"));
			expect(after.status).toBe("ok");
			expect(after.result).toBe("42");
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("marks cancellationPending when cancelling an awaiting asyncio.to_thread worker that remains blocked", async () => {
		const runner = spawnRunner();
		try {
			await submit(
				runner,
				"seed",
				lines(
					"import asyncio, threading",
					"import sys",
					"gate = threading.Event()",
					"worker_done = threading.Event()",
					"def blocked_worker():",
					"    print('WORKER_STARTED', flush=True)",
					"    gate.wait(timeout=3.0)",
					"    print('WORKER_LATE_STDOUT', flush=True)",
					"    print('WORKER_LATE_PARTIAL', end='')",
					"    display('WORKER_LATE_DISPLAY')",
					"    worker_done.set()",
					"    return 'worker-finished'",
				),
			);
			expect((await doneFor(runner, "seed")).status).toBe("ok");

			await submit(runner, "thread-a", "await asyncio.to_thread(blocked_worker)");
			expect((await frameFor(runner, "thread-a", ["started"])).type).toBe("started");
			const startedOut = await frameFor(runner, "thread-a", ["stdout"]);
			expect(startedOut.data).toContain("WORKER_STARTED");

			await runner.send({ type: "cancel", id: "thread-a" });
			const cancelledDone = await doneFor(runner, "thread-a");
			expect(cancelledDone.status).toBe("error");
			expect(cancelledDone.cancelled).toBe(true);
			expect(cancelledDone.cancellationPending).toBe(true);

			// Sibling request B still runs and completes while A's worker is blocked.
			const sibling = await submitAndDone(runner, "sibling-b", "'sibling-ok'");
			expect(sibling.status).toBe("ok");
			expect(sibling.result).toBe("'sibling-ok'");

			// Release worker and verify it finishes cleanly without emitting late frames for thread-a.
			const releaseRes = await submitAndDone(
				runner,
				"release-worker",
				lines(
					"gate.set()",
					"assert worker_done.wait(timeout=2.0)",
					"for _ in range(200):",
					"    if not sys.modules['__main__']._STATE.active_thread_workers: break",
					"    await asyncio.sleep(0.005)",
					"'released'",
				),
			);
			expect(releaseRes.status).toBe("ok");
			expect(releaseRes.result).toBe("'released'");

			expect(
				runner.bufferedFrames(
					frame => frame.id === "thread-a" && ["stdout", "stderr", "display", "result"].includes(frame.type ?? ""),
				),
			).toEqual([]);

			const cleanupState = await submitAndDone(
				runner,
				"check-cleanup",
				lines(
					"import sys",
					"st = sys.modules['__main__']._STATE",
					"(dict(st.active_thread_workers), sorted(st.suppressed_cancelled_rids))",
				),
			);
			expect(cleanupState.status).toBe("ok");
			expect(cleanupState.result).toBe("({}, [])");
			const after = await submitAndDone(runner, "after-worker", "123");
			expect(after.status).toBe("ok");
			expect(after.result).toBe("123");
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("does not leak worker custody or suppression when cancelling queued to_thread requests", async () => {
		const runner = spawnRunner();
		try {
			await submit(
				runner,
				"seed",
				lines(
					"import asyncio, sys, threading",
					"loop = asyncio.get_running_loop()",
					"TrackingExecutor = type(loop._default_executor)",
					"bounded_executor = TrackingExecutor(max_workers=1)",
					"loop.set_default_executor(bounded_executor)",
					"gate = threading.Event()",
					"worker_started = threading.Event()",
					"queued_ran = []",
					"def occupy():",
					"    worker_started.set()",
					"    print('OCCUPIER_STARTED', flush=True)",
					"    gate.wait(timeout=5.0)",
					"    return 'occupied-done'",
					"def queued_fn(idx):",
					"    queued_ran.append(idx)",
					"    return f'queued-{idx}'",
				),
			);
			expect((await doneFor(runner, "seed")).status).toBe("ok");

			await submit(runner, "occupier", "await asyncio.to_thread(occupy)");
			expect((await frameFor(runner, "occupier", ["started"])).type).toBe("started");
			const occupiedOut = await frameFor(runner, "occupier", ["stdout"]);
			expect(occupiedOut.data).toContain("OCCUPIER_STARTED");

			for (let i = 0; i < 3; i++) {
				const rid = `queued-${i}`;
				await submit(
					runner,
					rid,
					lines(
						`t = asyncio.create_task(asyncio.to_thread(queued_fn, ${i}))`,
						"await asyncio.sleep(0)",
						"print('QUEUED_SUBMITTED', flush=True)",
						"await t",
					),
				);
				expect((await frameFor(runner, rid, ["started"])).type).toBe("started");
				const submittedOut = await frameFor(runner, rid, ["stdout"]);
				expect(submittedOut.data).toContain("QUEUED_SUBMITTED");

				await runner.send({ type: "cancel", id: rid });
				const cancelledDone = await doneFor(runner, rid);
				expect(cancelledDone.status).toBe("error");
				expect(cancelledDone.cancelled).toBe(true);
				expect(cancelledDone.cancellationPending).toBe(false);
			}

			const release = await submitAndDone(runner, "release-occupier", lines("gate.set()", "'released'"));
			expect(release.status).toBe("ok");
			expect((await doneFor(runner, "occupier")).status).toBe("ok");

			const stateCheck = await submitAndDone(
				runner,
				"check-state",
				lines(
					"st = sys.modules['__main__']._STATE",
					"(queued_ran, dict(st.active_thread_workers), sorted(st.suppressed_cancelled_rids))",
				),
			);
			expect(stateCheck.status).toBe("ok");
			expect(stateCheck.result).toBe("([], {}, [])");
			expect(
				runner.bufferedFrames(
					frame =>
						(frame.id?.startsWith("queued-") ?? false) &&
						["stdout", "stderr", "display", "result"].includes(frame.type ?? ""),
				),
			).toEqual([]);
		} finally {
			await runner.close();
		}
	}, 8_000);

	it("does not accumulate suppression tombstones for cancelled requests with no worker", async () => {
		const runner = spawnRunner();
		try {
			await submit(runner, "seed", lines("import asyncio, sys", "never = asyncio.Event()"));
			expect((await doneFor(runner, "seed")).status).toBe("ok");

			for (let i = 0; i < 4; i++) {
				const rid = `no-worker-${i}`;
				await submit(runner, rid, lines("print('WAITING', flush=True)", "await never.wait()"));
				expect((await frameFor(runner, rid, ["started"])).type).toBe("started");
				await frameFor(runner, rid, ["stdout"]);
				await runner.send({ type: "cancel", id: rid });
				const done = await doneFor(runner, rid);
				expect(done.status).toBe("error");
				expect(done.cancelled).toBe(true);
				expect(done.cancellationPending).toBe(false);
			}

			const stateCheck = await submitAndDone(
				runner,
				"check-tombstones",
				lines(
					"st = sys.modules['__main__']._STATE",
					"(dict(st.active_thread_workers), sorted(st.suppressed_cancelled_rids))",
				),
			);
			expect(stateCheck.status).toBe("ok");
			expect(stateCheck.result).toBe("({}, [])");
		} finally {
			await runner.close();
		}
	}, 8_000);
});
