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
}

interface FrameWaiter {
	matches(frame: RunnerFrame): boolean;
	resolve(frame: RunnerFrame): void;
}

interface RunnerClient {
	send(message: object): Promise<void>;
	nextMatchingFrame(matches: (frame: RunnerFrame) => boolean): Promise<RunnerFrame>;
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
		async close() {
			try {
				await proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
				await proc.stdin.flush();
				proc.stdin.end();
			} catch { /* process already ended */ }
			if (proc.exitCode === null) proc.kill("SIGKILL");
			await proc.exited;
			await pump;
			try { reader.releaseLock(); } catch { /* stream already closed */ }
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

async function submitAndDone(runner: RunnerClient, id: string, code: string): Promise<RunnerFrame & { result: unknown }> {
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
			await submit(runner, "seed", lines("import asyncio", "release_b = asyncio.Event()", "shared_sentinel = 'retained'"));
			expect((await doneFor(runner, "seed")).status).toBe("ok");
			await submit(runner, "async-a", lines("print('A_STARTED', flush=True)", "await release_b.wait()"));
			expect((await frameFor(runner, "async-a", ["started"])).type).toBe("started");
			await frameFor(runner, "async-a", ["stdout"]);
			await submit(runner, "async-b", lines("print('B_STARTED', flush=True)", "await release_b.wait()", "print('B_FINISHED', flush=True)", "shared_sentinel"));
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
			await submit(runner, "parent", lines("print('PARENT_STARTED', flush=True)", "await bridge_done.wait()", "print('PARENT_FINISHED', flush=True)"));
			expect((await frameFor(runner, "parent", ["started"])).type).toBe("started");
			await frameFor(runner, "parent", ["stdout"]);
			await submit(runner, "child", lines("print('CHILD_STARTED', flush=True)", "bridge_done.set()", "print('CHILD_FINISHED', flush=True)"));
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
			await submit(runner, "sync-active", lines("print('SYNC_ACTIVE_STARTED', flush=True)", "for _ in range(5_000_000): pass", "print('SYNC_ACTIVE_FINISHED', flush=True)"));
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
			expect(queuedFrames.some(frame => frame.type === "error" && frame.evalue?.includes("CANCELLED_SOURCE_RAN"))).toBe(false);
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
});
