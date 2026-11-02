/**
 * Kernel OS stderr is untrusted. This exercises the exact draining/classifier
 * function that BaseKernel calls BEFORE its persistent logger callback.
 *
 * No kernel, OS subprocess, global logger mock, provider or real credentials are
 * involved. That isolation means logger transport and installed-runtime wiring
 * need separate acceptance; no test pretends otherwise.
 */
import { describe, expect, it } from "bun:test";
import { drainKernelStderr } from "@veyyon/coding-agent/eval/kernel-base";
import { BLOCKED_OUTPUT_RECORD } from "@veyyon/coding-agent/secrets/producer-output";

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
	const warnings: string[] = [];
	const operation = drainKernelStderr(stderr, safe => warnings.push(safe));
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error("Synthetic stderr drain did not finish within 3000ms")),
		3_000,
	);
	try {
		await Promise.race([operation, deadline.promise]);
		expect(stderr.locked).toBe(false);
		return warnings;
	} finally {
		clearTimeout(timer);
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
