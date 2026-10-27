/**
 * Regression test for issue #5260: the browser tool can hang indefinitely at
 * the "Closing tab" phase.
 *
 * `releaseTab` bounds the worker-close handshake, but the subsequent
 * `releaseBrowser` -> `disposeBrowserHandle` awaited Puppeteer's
 * `browser.close()` for the headless kind with no timeout. `browser.close()`
 * resolves only once the Chromium process fully exits; a wedged Chromium (a
 * known Windows failure mode) left that await pending forever, freezing
 * cleanup. The dispose must now cap the wait and force-kill the process tree
 * on timeout so cleanup always completes.
 *
 * The bound runs on fake timers, so each case asserts the release is still
 * pending one millisecond before the bound and settled at it, without spending
 * the five seconds the bound is.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as attach from "@veyyon/coding-agent/tools/web/browser/attach";
import { type BrowserHandle, releaseBrowser } from "@veyyon/coding-agent/tools/web/browser/registry";

/** How long a release waits on a wedged `browser.close()` before killing the process tree. */
const CLOSE_BOUND_MS = 5_000;

/** Build a headless handle whose `browser.close()` never resolves. */
function makeHangingHeadlessHandle(pid: number | undefined): {
	handle: BrowserHandle;
	closeCalls: () => number;
} {
	let closeCalls = 0;
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 1,
		browser: {
			connected: true,
			process: () => (pid === undefined ? null : { pid }),
			close: () => {
				closeCalls++;
				return new Promise<void>(() => {}); // never resolves
			},
		},
	} as unknown as BrowserHandle;
	return { handle, closeCalls: () => closeCalls };
}

/** Let the promise callbacks an advanced timer queued run to completion. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Release `handle` on fake timers, recording each force-kill, and report whether it settled before and at the bound. */
async function releaseAcrossTheBound(
	handle: BrowserHandle,
): Promise<{ settledBefore: boolean; settledAt: boolean; kills: number[] }> {
	const kills: number[] = [];
	const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockImplementation(async pid => {
		kills.push(pid);
	});
	try {
		vi.useFakeTimers();
		let settled = false;
		const release = releaseBrowser(handle, { kill: false }).then(() => {
			settled = true;
		});
		await flush();
		vi.advanceTimersByTime(CLOSE_BOUND_MS - 1);
		await flush();
		const settledBefore = settled;
		vi.advanceTimersByTime(1);
		await flush();
		const settledAt = settled;
		await release;
		return { settledBefore, settledAt, kills };
	} finally {
		killSpy.mockRestore();
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("browser dispose — headless close must not hang forever (issue #5260)", () => {
	it("bounds a wedged browser.close() and force-kills the process tree", async () => {
		const { handle, closeCalls } = makeHangingHeadlessHandle(4242);

		const result = await releaseAcrossTheBound(handle);

		// close() was attempted, and the release returned at the bound rather than
		// hanging on the never-resolving promise.
		expect(closeCalls()).toBe(1);
		expect(result.settledBefore).toBe(false);
		expect(result.settledAt).toBe(true);
		// On timeout, the Chromium process tree is force-killed by pid.
		expect(result.kills).toEqual([4242]);
	});

	it("does not attempt a force-kill when no process handle is available", async () => {
		const { handle } = makeHangingHeadlessHandle(undefined);

		const result = await releaseAcrossTheBound(handle);

		expect(result.settledAt).toBe(true);
		expect(result.kills).toEqual([]);
	});
});
