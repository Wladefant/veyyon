/**
 * Every Smithery request gets the same deadline, from one place.
 *
 * WHY THIS SUITE EXISTS. Smithery is reached from `smithery-auth` for the CLI
 * handshake and `smithery-registry` for search and install, and each once declared
 * its own ten-second timeout. `withSmitheryDeadline` is the one owner. This suite
 * pins the value and the composition with a caller's own signal; the deadline
 * firing, covering the body, and leaving no timer armed is proved against the
 * real Smithery entrypoints in
 * `an-http-deadline-ends-a-stalled-request-and-leaves-no-timer-armed.test.ts`.
 *
 * What this does not catch: a new Smithery entrypoint that bypasses the helper.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { SMITHERY_HTTP_TIMEOUT_MS, withSmitheryDeadline } from "@veyyon/coding-agent/mcp/smithery-http";

describe("SMITHERY_HTTP_TIMEOUT_MS", () => {
	/**
	 * The value, asserted exactly. Every caller fetches a small JSON document, so
	 * this is a deadline for an exchange rather than for a download; a test that
	 * only checked "some positive number" would let a 30-second regression through.
	 */
	it("is ten seconds", () => {
		expect(SMITHERY_HTTP_TIMEOUT_MS).toBe(10_000);
	});
});

describe("withSmitheryDeadline", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts the request signal at the Smithery deadline and not before", async () => {
		vi.useFakeTimers();
		const started = Promise.withResolvers<AbortSignal>();
		const request = withSmitheryDeadline(signal => {
			started.resolve(signal);
			const ended = Promise.withResolvers<never>();
			signal.addEventListener("abort", () => ended.reject(signal.reason), { once: true });
			return ended.promise;
		});
		const signal = await started.promise;

		vi.advanceTimersByTime(SMITHERY_HTTP_TIMEOUT_MS - 1);
		expect(signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);

		await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
	});

	/**
	 * A cancelled command stops the request, rather than the request waiting out
	 * its ten seconds.
	 */
	it("aborts as soon as the caller's own signal aborts", async () => {
		const caller = new AbortController();
		const seen = await withSmitheryDeadline(async signal => {
			expect(signal.aborted).toBe(false);
			caller.abort(new Error("cancelled by the caller"));
			return signal.reason;
		}, caller.signal);

		expect((seen as Error).message).toBe("cancelled by the caller");
	});

	/**
	 * A caller that is already cancelled hands the request an already-aborted
	 * signal, so no request goes out.
	 */
	it("hands the request an aborted signal when the caller was cancelled first", async () => {
		const caller = new AbortController();
		caller.abort(new Error("cancelled before the call"));

		const seen = await withSmitheryDeadline(async signal => signal.reason, caller.signal);

		expect((seen as Error).message).toBe("cancelled before the call");
	});
});
