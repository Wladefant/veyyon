/**
 * WHY: `driveFakeTime` used to advance fake time by 10ms after every real event-loop turn. A turn
 * does not wait for the thread pool and lasts microseconds, so one 3ms file write spent seconds of
 * fake time. The LSP writethrough arms a 5s fake operation budget before it writes the file; on a
 * slow CI disk that budget expired mid-write, the write was reported as timed out, and no
 * diagnostics pull was sent.
 *
 * The class is any driven work whose real I/O spans event-loop turns while a fake deadline is
 * armed. This suite pins the helper's rate bound, which every such test inherits: fake time spent
 * while real I/O runs never exceeds `FAKE_TIME_MAX_SPEEDUP` times the real time it took, so a
 * deadline armed ahead of the I/O fires early only when the I/O is that factor slower than it.
 *
 * It does not catch real I/O that is slower than a budget divided by `FAKE_TIME_MAX_SPEEDUP`:
 * such a budget still expires, as it would in production. It does not see a test that advances
 * fake timers by hand around real I/O instead of driving the work through this helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils/temp";
import { driveFakeTime, FAKE_TIME_MAX_SPEEDUP, installFakeTime } from "./helpers/fake-time";

/** Rounds of write-then-read; each is several thread-pool round trips, so the I/O spans many turns. */
const IO_ROUNDS = 24;
const IO_BYTES = 256 * 1024;

function realMs(): number {
	return Number(process.hrtime.bigint()) / 1e6;
}

describe("driveFakeTime while real I/O is in flight", () => {
	let dir: TempDir;

	beforeEach(() => {
		dir = TempDir.createSync("@veyyon-fake-time-pace-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		dir.removeSync();
	});

	async function realIo(): Promise<number> {
		const file = path.join(dir.path(), "payload.bin");
		const payload = new Uint8Array(IO_BYTES).fill(7);
		let bytesRead = 0;
		for (let round = 0; round < IO_ROUNDS; round++) {
			await fs.writeFile(file, payload);
			bytesRead += (await fs.readFile(file)).byteLength;
		}
		return bytesRead;
	}

	it("spends at most its stated multiple of the real time the I/O took", async () => {
		// Fake timers freeze `process.hrtime`, so real time is read on either side of the fake window.
		const realStart = realMs();
		installFakeTime();
		const fakeStart = Date.now();

		const bytesRead = await driveFakeTime(realIo());
		const fakeElapsed = Date.now() - fakeStart;
		vi.restoreAllMocks();
		vi.useRealTimers();
		const realElapsed = realMs() - realStart;

		expect(bytesRead).toBe(IO_ROUNDS * IO_BYTES);
		expect(fakeElapsed).toBeLessThanOrEqual(realElapsed * FAKE_TIME_MAX_SPEEDUP);
	});
});
