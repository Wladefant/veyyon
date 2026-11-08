import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { BaseKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { logger } from "@veyyon/utils";
import type { Subprocess } from "bun";

// WHY: IPC trace previews exposed eval source before the request's output guard ran.
// This drives BaseKernel.execute and observes logger metadata, with only the runner pipe replaced.
// It covers request source at the trace sink, not runner diagnostics or language execution.
class TraceKernel extends BaseKernel {}

const traceSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of traceSpies) spy.mockRestore();
	traceSpies.length = 0;
});

describe("kernel IPC tracing publishes metadata without request source", () => {
	for (const source of ["SERVICE_TOKEN=fake-trace-value", "ordinary source\nwith Unicode λ and fake-trace-value"]) {
		it(`does not log source shaped as ${source.startsWith("SERVICE") ? "an assignment" : "ordinary code"}`, async () => {
			const messages: Array<{ message: string; fields: unknown }> = [];
			traceSpies.push(spyOn(logger, "debug").mockImplementation((message, fields) => {
				messages.push({ message, fields });
			}));
			const exited = Promise.withResolvers<number>();
			let stdout: ReadableStreamDefaultController<Uint8Array>;
			const proc = {
				stdin: {
					write(line: string) {
						const frame = JSON.parse(line);
						if (frame.id) stdout.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "done", id: frame.id, executionCount: 1 })}\n`));
						return line.length;
					},
					flush() {},
					end() { exited.resolve(0); },
				},
				stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
				stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
				exited: exited.promise,
				kill() { exited.resolve(0); },
			} as unknown as Subprocess<"pipe", "pipe", "pipe">;
			const kernel = new TraceKernel("trace-fixture", { languageName: "Trace", traceIpc: true, shutdownGraceMs: 0 });
			kernel.setProcess(proc);
			try {
				const result = await kernel.execute(source, { id: "trace-request" });
				expect(result.status).toBe("ok");
				const sent = messages.filter(entry => entry.message === "TraceKernel send");
				expect(sent).toHaveLength(1);
				expect(JSON.stringify(sent)).not.toContain("fake-trace-value");
				expect(sent[0].fields).toEqual({ characters: expect.any(Number) });
			} finally {
				await kernel.shutdown();
			}
		}, 5_000);
	}
});
