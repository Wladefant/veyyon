import { expect, it, spyOn } from "bun:test";
import { BaseKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { logger } from "@veyyon/utils";
import type { Subprocess } from "bun";

/**
 * WHY: the persistent stderr reader logs bytes without an execution owner, so a literal emitted
 * between requests bypasses the current request's output guard and reaches retained logs. This
 * production-path test closes unowned stderr disclosure for startup and reused-kernel chunks. It
 * does not prove redaction of attributed stdout/stderr protocol frames or other logger sinks.
 */
class TestKernel extends BaseKernel {}

function processWithStderr(parts: Uint8Array[]): Subprocess<"pipe", "pipe", "pipe"> {
	let part = 0;
	const exited = Promise.withResolvers<number>();
	return {
		stdin: { write: () => 0, flush: () => {}, end: () => exited.resolve(0) },
		stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		stderr: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (part < parts.length) controller.enqueue(parts[part++]);
				else controller.close();
			},
		}),
		exited: exited.promise,
		kill: () => exited.resolve(0),
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
}

it("withholds ownerless stderr bytes instead of logging their content", async () => {
	const warnings: unknown[][] = [];
	const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args);
	});
	const secret = "bravo-literal-271828";
	const encoder = new TextEncoder();
	const kernel = new TestKernel("stderr-ownerless", { languageName: "Test", shutdownGraceMs: 0 });
	kernel.setProcess(processWithStderr([encoder.encode(secret.slice(0, 8)), encoder.encode(secret.slice(8))]));
	await kernel.shutdown({ timeoutMs: 50 });
	await Promise.resolve();
	warn.mockRestore();
	const serialized = JSON.stringify(warnings);
	expect(serialized).not.toContain(secret);
	// The ownerless stream is discarded, not classified or logged as a payload.
	expect(warnings).toEqual([]);
});
