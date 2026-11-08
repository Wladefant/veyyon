import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { BaseKernel } from "../kernel-base";

class PythonCancellationKernel extends BaseKernel {
	constructor() {
		super("python-cancel-test", {
			languageName: "Python",
			buildPayload: (code, id) => JSON.stringify({ type: "exec", id, code }),
			buildCancelPayload: id => JSON.stringify({ type: "cancel", id }),
			interruptEscalationMs: 10,
		});
	}
}

test("a timed-out Python request cancels only its ID and leaves the runner alive", async () => {
	const lines: string[] = [];
	const signals: string[] = [];
	const { promise: exited, resolve: exitedResolve } = Promise.withResolvers<number | null>();
	const { promise: cancelWritten, resolve: cancelWrittenResolve } = Promise.withResolvers<{ type: string; id: string }>();
	const { promise: signalFired, resolve: signalFiredResolve } = Promise.withResolvers<string>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const proc = {
		stdin: {
			write(line: string) {
				lines.push(line);
				try {
					const frame = JSON.parse(line);
					if (frame.type === "cancel") cancelWrittenResolve(frame);
				} catch {}
				return line.length;
			},
			flush() {},
			end() {},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				stdout = controller;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		}),
		exited,
		kill(signal: string) {
			signals.push(signal);
			signalFiredResolve(signal);
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	const kernel = new PythonCancellationKernel();
	kernel.setProcess(proc);
	try {
		const first = kernel.execute("first", { id: "request-a", timeoutMs: 5 });
		const second = kernel.execute("second", { id: "request-b" });
		void first.catch(() => {});
		void second.catch(() => {});

		// Deliberately exercises BaseKernel real timer behavior (timeoutMs and escalation grace); bounded race observes cancel frame vs fallback signals without hanging.
		let timer: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<{ type: "timeout" }>(resolve => {
			timer = setTimeout(() => resolve({ type: "timeout" }), 300);
		});
		const observedEvent = await Promise.race([
			cancelWritten.then(frame => ({ type: "cancel" as const, frame })),
			signalFired.then(signal => ({ type: "signal" as const, signal })),
			timeoutPromise,
		]).finally(() => clearTimeout(timer));

		expect(observedEvent).toEqual({
			type: "cancel",
			frame: { type: "cancel", id: "request-a" },
		});
		expect(signals).toEqual([]);

		let firstTimer: NodeJS.Timeout | undefined;
		const firstTimeout = new Promise<never>((_, reject) => {
			firstTimer = setTimeout(() => reject(new Error("timed out waiting for first request to settle")), 300);
		});
		const result = await Promise.race([first, firstTimeout]).finally(() => clearTimeout(firstTimer));

		const frames = lines.map(line => JSON.parse(line));
		expect(frames.filter(frame => frame.type === "cancel")).toEqual([{ type: "cancel", id: "request-a" }]);

		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		expect(result).toMatchObject({
			cancelled: true,
			timedOut: true,
			cancellationPending: true,
			kernelKilled: false,
		});
		expect(kernel.isAlive()).toBe(true);
		expect(signals).toEqual([]);

		stdout.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", id: "request-b" }) + "\n"));
		let secondTimer: NodeJS.Timeout | undefined;
		const secondTimeout = new Promise<never>((_, reject) => {
			secondTimer = setTimeout(() => reject(new Error("timed out waiting for second request to settle")), 300);
		});
		const secondResult = await Promise.race([second, secondTimeout]).finally(() => clearTimeout(secondTimer));
		expect(secondResult).toMatchObject({ status: "ok" });
	} finally {
		try {
			stdout.close();
		} catch {}
		exitedResolve(0);
	}
}, 5000);

test("a done frame clears Python cancellation pending state", async () => {
	const { promise: exited, resolve: exitedResolve } = Promise.withResolvers<number | null>();
	const { promise: cancelWritten, resolve: cancelWrittenResolve } = Promise.withResolvers<{ type: string; id: string }>();
	const { promise: signalFired, resolve: signalFiredResolve } = Promise.withResolvers<string>();
	const signals: string[] = [];
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const proc = {
		stdin: {
			write(line: string) {
				try {
					const frame = JSON.parse(line);
					if (frame.type === "cancel") cancelWrittenResolve(frame);
				} catch {}
				return line.length;
			},
			flush() {},
			end() {},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(c) {
				stdout = c;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		}),
		exited,
		kill(sig: string) {
			signals.push(sig);
			signalFiredResolve(sig);
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	const kernel = new PythonCancellationKernel();
	kernel.setProcess(proc);
	try {
		const execution = kernel.execute("work", { id: "ack", timeoutMs: 5 });
		void execution.catch(() => {});

		// Deliberately exercises BaseKernel real timer behavior (timeoutMs and escalation grace); bounded race observes cancel frame vs fallback signals without hanging.
		let timer: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<{ type: "timeout" }>(resolve => {
			timer = setTimeout(() => resolve({ type: "timeout" }), 300);
		});
		const observedEvent = await Promise.race([
			cancelWritten.then(frame => ({ type: "cancel" as const, frame })),
			signalFired.then(signal => ({ type: "signal" as const, signal })),
			timeoutPromise,
		]).finally(() => clearTimeout(timer));

		expect(observedEvent).toEqual({
			type: "cancel",
			frame: { type: "cancel", id: "ack" },
		});
		expect(signals).toEqual([]);

		stdout.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", id: "ack", cancelled: true }) + "\n"));
		let executionTimer: NodeJS.Timeout | undefined;
		const executionTimeout = new Promise<never>((_, reject) => {
			executionTimer = setTimeout(() => reject(new Error("timed out waiting for execution to settle")), 300);
		});
		const result = await Promise.race([execution, executionTimeout]).finally(() => clearTimeout(executionTimer));

		expect(result).toMatchObject({ cancelled: true, cancellationPending: false, kernelKilled: false });
		expect(kernel.isAlive()).toBe(true);
	} finally {
		try {
			stdout.close();
		} catch {}
		exitedResolve(0);
	}
}, 5000);
