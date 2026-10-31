/**
 * Leaves one interval armed and stops three others, used by
 * `scripts/test-sandbox/find-test-leaks.test.ts` to prove the tracer reports an interval a file
 * never stopped, at the line that armed it, and nothing for one that was stopped. The collection
 * forced at the end proves the tracer's weak hold still finds an armed interval nothing else
 * references.
 *
 * Named `.fixture.ts` so an ordinary `bun test <dir>` does not collect it; see
 * `leaky-suite.fixture.ts`.
 */
import { afterAll, expect, it, vi } from "bun:test";

const stoppedInAfterAll = setInterval(() => {}, 60_000);
stoppedInAfterAll.unref();

it("arms an interval and never stops it", () => {
	const left = setInterval(() => {}, 60_000);
	left.unref();
	expect(left.hasRef()).toBe(false);
});

it("stops what it arms, so it must not be reported", () => {
	const stopped = setInterval(() => {}, 60_000);
	clearInterval(stopped);
	vi.useFakeTimers();
	setInterval(() => {}, 1_000);
	expect(vi.getTimerCount()).toBe(1);
	vi.useRealTimers();
});

afterAll(() => {
	clearInterval(stoppedInAfterAll);
	Bun.gc(true);
});
