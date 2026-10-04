import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	formatBackgroundNotice,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../../src/async/auto-background";

describe("shared auto-background helpers", () => {
	it("formats background notices with job ID", () => {
		expect(formatBackgroundNotice("job-123")).toBe(
			"Backgrounded as job job-123; result will be delivered automatically.",
		);
		expect(DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS).toBe(60_000);
	});

	describe("resolveAutoBackgroundWaitMs", () => {
		it("returns 0 when threshold is zero or negative", () => {
			expect(resolveAutoBackgroundWaitMs(0, 30_000)).toBe(0);
			expect(resolveAutoBackgroundWaitMs(-500, 30_000)).toBe(0);
		});

		it("returns threshold when timeout is undefined", () => {
			expect(resolveAutoBackgroundWaitMs(15_000, undefined)).toBe(15_000);
		});

		it("clamps threshold to timeout minus 1-second buffer", () => {
			expect(resolveAutoBackgroundWaitMs(60_000, 10_000)).toBe(9_000);
			expect(resolveAutoBackgroundWaitMs(5_000, 10_000)).toBe(5_000);
			expect(resolveAutoBackgroundWaitMs(5_000, 1_000)).toBe(0);
			expect(resolveAutoBackgroundWaitMs(5_000, 500)).toBe(0);
		});
	});

	describe("raceJobSettlement", () => {
		it("resolves with completion value when job finishes before threshold", async () => {
			const job = Promise.resolve("done");
			const outcome = await raceJobSettlement(job, 5_000);
			expect(outcome).toBe("done");
		});

		it("returns running outcome when threshold elapses first", async () => {
			const pending = new Promise<string>(() => {});
			const outcome = await raceJobSettlement(pending, 20);
			expect(outcome).toEqual({ kind: "running" });
		});

		it("returns aborted outcome when abort signal triggers", async () => {
			const pending = new Promise<string>(() => {});
			const controller = new AbortController();
			const racePromise = raceJobSettlement(pending, 5_000, controller.signal);
			controller.abort();
			const outcome = await racePromise;
			expect(outcome).toEqual({ kind: "aborted" });
		});

		it("returns steer outcome when steering signal triggers", async () => {
			const pending = new Promise<string>(() => {});
			const controller = new AbortController();
			const racePromise = raceJobSettlement(pending, 5_000, undefined, controller.signal);
			controller.abort();
			const outcome = await racePromise;
			expect(outcome).toEqual({ kind: "steer" });
		});
	});
});
