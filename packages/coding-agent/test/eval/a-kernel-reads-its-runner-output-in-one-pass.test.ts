import { afterEach, describe, expect, it } from "bun:test";
import { BaseKernel, type KernelExecuteResult } from "@veyyon/coding-agent/eval/kernel-base";
import { STREAM_FRAME_MAX_BYTES_ENV } from "@veyyon/utils";
import type { Subprocess } from "bun";

/**
 * WHY: an eval kernel's runner answers on stdout with one JSON frame per line, and a pipe hands the
 * reader a large frame in 64 KiB pieces. The reader appended each piece to one string and searched
 * the whole string for a newline again, so a frame of n bytes cost n²/64 KiB of scanning, all of it
 * on the event loop: a 32 MiB result held the terminal 541 ms and a 50 MB one about 1.3 s. The
 * reader now splits lines with `readLines`, which scans each piece once.
 *
 * The class this closes is "runner output read in time that grows faster than its size", pinned by
 * the ratio of the time a frame four times as large takes (one pass: about 4; rescanning: about 16),
 * together with what a one-pass splitter must still get right: a frame split anywhere, including
 * inside a multibyte character, several frames in one piece, and a last frame with no newline. A
 * frame over the stream frame ceiling cannot be read at all; the execution waiting on it ends with
 * the reason instead of waiting forever, and the kernel stops, since no later frame can reach it.
 *
 * What it does not catch: a slowdown that scales linearly, and the time `JSON.parse` takes on one
 * large frame, which still runs on the event loop.
 */

class TestKernel extends BaseKernel {}

/** A runner whose stdout replays `pieces` once `opened` resolves, then ends. */
function runner(pieces: Uint8Array[], opened: Promise<void>): Subprocess<"pipe", "pipe", "pipe"> {
	let next = 0;
	const exited = Promise.withResolvers<number>();
	return {
		stdin: { write: () => 0, flush: () => {}, end: () => exited.resolve(0) },
		stdout: new ReadableStream<Uint8Array>({
			async pull(controller) {
				await opened;
				if (next < pieces.length) controller.enqueue(pieces[next++]);
				else controller.close();
			},
		}),
		stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
		exited: exited.promise,
		kill: () => exited.resolve(0),
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
}

/** `bytes` cut into pieces of `size`, the way a pipe delivers them. */
function cut(bytes: Uint8Array, size: number): Uint8Array[] {
	const pieces: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
	return pieces;
}

const encoder = new TextEncoder();

/** Run one execution whose runner answers with `output`, delivered as `pieces`. */
async function run(
	id: string,
	pieces: (frames: Uint8Array) => Uint8Array[],
	output: string,
): Promise<{ result: KernelExecuteResult; chunks: string[]; kernel: TestKernel }> {
	const kernel = new TestKernel(id, { languageName: "Test", shutdownGraceMs: 0 });
	const opened = Promise.withResolvers<void>();
	kernel.setProcess(runner(pieces(encoder.encode(output)), opened.promise));
	const chunks: string[] = [];
	const settled = kernel.execute("code", { id, onChunk: text => void chunks.push(text) });
	opened.resolve();
	return { result: await settled, chunks, kernel };
}

const stdoutFrame = (id: string, data: string) => JSON.stringify({ type: "stdout", id, data });
const doneFrame = (id: string) => JSON.stringify({ type: "done", id, executionCount: 7 });

/** The ceiling a test replaced, restored after it; `null` when no test replaced it. */
let replacedCeiling: { value: string | undefined } | null = null;
afterEach(() => {
	if (!replacedCeiling) return;
	if (replacedCeiling.value === undefined) delete process.env[STREAM_FRAME_MAX_BYTES_ENV];
	else process.env[STREAM_FRAME_MAX_BYTES_ENV] = replacedCeiling.value;
	replacedCeiling = null;
});

describe("a kernel reads its runner output in one pass", () => {
	it("reads a frame four times as large in about four times the time", async () => {
		const timeFor = async (megabytes: number): Promise<number> => {
			let fastest = Number.POSITIVE_INFINITY;
			for (let attempt = 0; attempt < 3; attempt++) {
				const id = `scale-${megabytes}-${attempt}`;
				const data = "x".repeat(megabytes * 1024 * 1024);
				const start = performance.now();
				const { result, chunks } = await run(
					id,
					frames => cut(frames, 64 * 1024),
					`${stdoutFrame(id, data)}\n${doneFrame(id)}\n`,
				);
				fastest = Math.min(fastest, performance.now() - start);
				expect(result.status).toBe("ok");
				expect(chunks.join("").length).toBe(data.length);
			}
			return fastest;
		};

		const small = await timeFor(8);
		const large = await timeFor(32);

		expect(large / small).toBeLessThan(8);
	}, 30_000);

	it("delivers frames split anywhere, packed together, or left without a final newline", async () => {
		const id = "split";
		// Three-byte and four-byte characters, so some cuts land inside a character.
		const texts = ["first ", "€ second ", "𝄞 third ", "x".repeat(200)];
		const output = `${texts.map(text => stdoutFrame(id, text)).join("\n")}\n${doneFrame(id)}`;
		for (const size of [1, 2, 3, 5, 64, 1 << 16]) {
			const { result, chunks } = await run(id, frames => cut(frames, size), output);
			expect({ size, status: result.status, executionCount: result.executionCount, chunks }).toEqual({
				size,
				status: "ok",
				executionCount: 7,
				chunks: texts,
			});
		}
	});

	it("ends the execution with the reason and stops the kernel when a frame exceeds the ceiling", async () => {
		replacedCeiling = { value: process.env[STREAM_FRAME_MAX_BYTES_ENV] };
		process.env[STREAM_FRAME_MAX_BYTES_ENV] = String(1024);
		const id = "oversized";
		const { result, chunks, kernel } = await run(
			id,
			frames => cut(frames, 256),
			`${stdoutFrame(id, "x".repeat(4096))}\n${doneFrame(id)}\n`,
		);

		expect(result).toMatchObject({ status: "error", cancelled: true, kernelKilled: true });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toStartWith("[kernel] Test kernel output could not be read: ");
		expect(kernel.isAlive()).toBe(false);
	});
});
