import { expect, it, spyOn } from "bun:test";
import { BaseKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { logger } from "@veyyon/utils";
import type { Subprocess } from "bun";

/**
 * WHY: startup output before runner capture can emit non-JSON lines. Logging the raw line prefix
 * or SyntaxError message can expose secrets (e.g. SERVICE_TOKEN=fake-token). This production-path
 * test verifies that invalid JSON diagnostics log only safe metadata (character and byte length)
 * without raw text or SyntaxError payload reflections.
 */
class DiagnosticKernel extends BaseKernel {}

function processWithStdout(lines: string[]): Subprocess<"pipe", "pipe", "pipe"> {
	let idx = 0;
	const encoder = new TextEncoder();
	const exited = Promise.withResolvers<number>();
	return {
		stdin: { write: () => 0, flush: () => {}, end: () => exited.resolve(0) },
		stdout: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (idx < lines.length) {
					controller.enqueue(encoder.encode(`${lines[idx++]}\n`));
				} else {
					controller.close();
				}
			},
		}),
		stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		exited: exited.promise,
		kill: () => exited.resolve(0),
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
}

it("logs metadata only and withholds startup line text and syntax error reflections", async () => {
	const warnings: unknown[][] = [];
	const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args);
	});
	const secretToken = "SERVICE_TOKEN=fake-startup-secret-71828";
	const kernel = new DiagnosticKernel("diag-test", { languageName: "Test", shutdownGraceMs: 0 });
	kernel.setProcess(processWithStdout([secretToken]));

	await kernel.shutdown({ timeoutMs: 50 });
	await Promise.resolve();
	warn.mockRestore();

	const serialized = JSON.stringify(warnings);
	expect(serialized).not.toContain(secretToken);
	expect(warnings.length).toBe(1);
	const [message, payload] = warnings[0] as [string, Record<string, unknown>];
	expect(message).toBe("Test runner emitted invalid JSON");
	expect(payload).toEqual({
		length: secretToken.length,
		byteLength: Buffer.byteLength(secretToken),
	});
});
