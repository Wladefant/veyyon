/**
 * Kernel OS stderr is an untrusted producer: it must pass the same complete-record
 * inventory guard before the persistent logger sink, even when bytes split anywhere.
 *
 * These drive the real BaseKernel#setProcess stderr drain against an in-memory fake
 * child and spy on the real logger boundary. No interpreter, provider, credential
 * or external process is launched. The test does not verify an installed runtime,
 * JS-eval display output, or other log producers.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Subprocess } from "bun";
import { BaseKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { BLOCKED_OUTPUT_RECORD } from "@veyyon/coding-agent/secrets/producer-output";
import { logger } from "@veyyon/utils";

class SyntheticKernel extends BaseKernel {
	constructor() {
		super("synthetic-kernel", { languageName: "Synthetic" });
	}
}

const encoder = new TextEncoder();

function readableChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const bytes of chunks) controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function capturedKernelStderr(chunks: Uint8Array[]): Promise<string[]> {
	const stderr = readableChunks(chunks);
	const stdout = readableChunks([]);
	const exited = Promise.withResolvers<number>();
	const warnings: string[] = [];
	const spy = spyOn(logger, "warn").mockImplementation((message, context) => {
		if (message !== "Synthetic runner stderr") return;
		const text = (context as { text?: unknown } | undefined)?.text;
		if (typeof text === "string") warnings.push(text);
	});
	try {
		// BaseKernel owns both readers. The fake only supplies shaped, already
		// closed byte streams; it is never registered as an OS process/owner.
		const process = {
			pid: 0,
			stdin: { write: () => 0, end: async () => {} },
			stdout,
			stderr,
			exited: exited.promise,
			kill: () => {},
		} as unknown as Subprocess<"pipe", "pipe", "pipe">;
		new SyntheticKernel().setProcess(process, null);
		expect(stderr.locked).toBe(true);
		const started = performance.now();
		while (stderr.locked) {
			if (performance.now() - started > 3_000) {
				throw new Error("Synthetic kernel stderr reader did not release within 3000ms");
			}
			await sleep(1);
		}
		expect(performance.now() - started).toBeLessThan(3_000);
		return warnings;
	} finally {
		exited.resolve(0);
		spy.mockRestore();
	}
}

describe("kernel stderr never reaches the persistent logger as raw inventory", () => {
	it("withholds the complete three-row OS stderr inventory before any log call", async () => {
		const emitted = await capturedKernelStderr([
			encoder.encode("ALPHA=fake-a\n"),
			encoder.encode("BETA=fake-b\n"),
			encoder.encode("GAMMA=fake-c\n"),
		]);
		const visible = emitted.join("");
		expect(visible).toContain(BLOCKED_OUTPUT_RECORD);
		expect(visible).not.toContain("fake-a");
		expect(visible).not.toContain("fake-b");
		expect(visible).not.toContain("fake-c");
	});

	it("also withholds the inventory when every byte arrives separately", async () => {
		const bytes = encoder.encode("ALPHA=fake-a\nBETA=fake-b\nGAMMA=fake-c\n");
		const emitted = await capturedKernelStderr(Array.from(bytes, byte => Uint8Array.of(byte)));
		const visible = emitted.join("");
		expect(visible).toContain(BLOCKED_OUTPUT_RECORD);
		expect(visible).not.toContain("fake-a");
		expect(visible).not.toContain("fake-b");
		expect(visible).not.toContain("fake-c");
	});

	it("retains ordinary diagnostic lines and a final unterminated fragment", async () => {
		const emitted = await capturedKernelStderr([
			encoder.encode("kernel boot "),
			encoder.encode("ok\nfollow-up "),
			encoder.encode("detail"),
		]);
		expect(emitted.join("")).toBe("kernel boot ok\nfollow-up detail");
	});

	it("decodes UTF-8 safely when a code point is split between stderr chunks", async () => {
		const bytes = encoder.encode("héllo\n");
		const emitted = await capturedKernelStderr([bytes.slice(0, 2), bytes.slice(2, 3), bytes.slice(3)]);
		expect(emitted.join("")).toBe("héllo\n");
	});

	it("keeps the existing allowance for only two neutral assignments", async () => {
		const emitted = await capturedKernelStderr([
			encoder.encode("ALPHA=fake-a\n"),
			encoder.encode("BETA=fake-b\n"),
		]);
		expect(emitted.join("")).toBe("ALPHA=fake-a\nBETA=fake-b\n");
	});

	it("does not emit trailing diagnostics after an inventory was withheld", async () => {
		const emitted = await capturedKernelStderr([
			encoder.encode("ALPHA=fake-a\nBETA=fake-b\nGAMMA=fake-c\n"),
			encoder.encode("trailing diagnostic\n"),
		]);
		const visible = emitted.join("");
		expect(visible).toContain(BLOCKED_OUTPUT_RECORD);
		expect(visible).not.toContain("fake-a");
		expect(visible).not.toContain("trailing diagnostic");
	});
});
