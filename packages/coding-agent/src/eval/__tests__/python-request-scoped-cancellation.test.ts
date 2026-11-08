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
	const { promise: exited } = Promise.withResolvers<number | null>();
	const { promise: cancelWritten, resolve: cancelWrittenResolve } = Promise.withResolvers<void>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const proc = {
		stdin: { write(line: string) { lines.push(line); if (JSON.parse(line).type === "cancel") cancelWrittenResolve(); return line.length; }, flush() {}, end() {} },
		stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
		stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
		exited,
		kill(signal: string) { signals.push(signal); },
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	const kernel = new PythonCancellationKernel();
	kernel.setProcess(proc);
	const first = kernel.execute("first", { id: "request-a", timeoutMs: 5 });
	const second = kernel.execute("second", { id: "request-b" });
	await cancelWritten;
	const result = await first;
	const frames = lines.map(line => JSON.parse(line));
	expect(frames.filter(frame => frame.type === "cancel")).toEqual([{ type: "cancel", id: "request-a" }]);
	let secondSettled = false;
	void second.then(() => { secondSettled = true; });
	await Promise.resolve();
	expect(secondSettled).toBe(false);
	expect(result).toMatchObject({ cancelled: true, timedOut: true, cancellationPending: true, kernelKilled: false });
	expect(kernel.isAlive()).toBe(true);
	expect(signals).toEqual([]);
	stdout.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", id: "request-b" }) + "\n"));
	stdout.close();
	await second;
});


test("a done frame clears Python cancellation pending state", async () => {
 const { promise: exited } = Promise.withResolvers<number | null>();
 const { promise: cancel, resolve } = Promise.withResolvers<void>();
 let stdout!: ReadableStreamDefaultController<Uint8Array>;
 const proc = { stdin: { write(line: string) { if (JSON.parse(line).type === "cancel") resolve(); return line.length; }, flush() {}, end() {} }, stdout: new ReadableStream<Uint8Array>({ start(c) { stdout = c; } }), stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited, kill() {} } as unknown as Subprocess<"pipe", "pipe", "pipe">;
 const kernel = new PythonCancellationKernel(); kernel.setProcess(proc);
 const execution = kernel.execute("work", { id: "ack", timeoutMs: 5 });
 await cancel;
 stdout.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", id: "ack", cancelled: true }) + "\n"));
 const result = await execution;
 expect(result).toMatchObject({ cancelled: true, cancellationPending: false, kernelKilled: false });
 expect(kernel.isAlive()).toBe(true); stdout.close();
});
