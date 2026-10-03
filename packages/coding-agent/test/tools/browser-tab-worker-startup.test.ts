import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@veyyon/coding-agent/tools/web/browser/registry";
import type {
	ReadyInfo,
	TabWorkerInbound,
	TabWorkerOutbound,
} from "@veyyon/coding-agent/tools/web/browser/tab-protocol";
import { acquireTab, initializeTabWorkerForTest } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#messageHandlers = new Set<(msg: TabWorkerOutbound) => void>();
	readonly sent: TabWorkerInbound[] = [];
	readonly mode = "worker" as const;

	send(msg: TabWorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: TabWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {}

	emitReady(info: ReadyInfo): void {
		for (const handler of this.#messageHandlers) handler({ type: "ready", info });
	}

	emitSetup(): void {
		for (const handler of this.#messageHandlers) handler({ type: "setup" });
	}

	emitInitFailed(error: { name: string; message: string; isToolError: boolean; isAbort: boolean }): void {
		for (const handler of this.#messageHandlers) handler({ type: "init-failed", error });
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/veyyon-puppeteer",
	timeoutMs: 1_000,
};

describe("browser tab worker startup", () => {
	it("surfaces worker startup errors instead of waiting for the generic init timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("Cannot find tab-worker-entry.ts"));

		await expect(pending).rejects.toThrow("Tab worker failed during startup: Cannot find tab-worker-entry.ts");
		expect(worker.sent).toEqual([{ type: "init", payload: initPayload }]);
	});

	it("resolves with ready info when the worker sends setup before ready", async () => {
		const worker = new FakeStartupWorker();
		const info: ReadyInfo = {
			url: "about:blank",
			title: "Test",
			viewport: { width: 1280, height: 720 },
			targetId: "target-1",
		};
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitSetup();
		// The inline transport delivers messages on microtasks, so `ready` can
		// land in the same tick as `setup`; the single listener spanning both
		// phases must resolve it instead of dropping it.
		worker.emitReady(info);

		await expect(pending).resolves.toEqual(info);
	});

	it("rejects with the setup timeout when the worker never signals setup", async () => {
		const worker = new FakeStartupWorker();
		// timeoutMs 3_000 -> setup budget = max(2s, min(10s, 1s)) = 2s: the stall
		// must reject under the setup guard, not consume the full init budget.
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");
	});

	it("surfaces a reported init failure that arrives after setup", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		worker.emitSetup();
		// A fast `init-failed` that lands right behind `setup` — a `page.goto`
		// rejection without a macrotask boundary — must surface the real
		// failure instead of the generic init timeout.
		worker.emitInitFailed({ name: "Error", message: "connect failed", isToolError: false, isAbort: false });

		await expect(pending).rejects.toThrow("connect failed");
	});

	it("bounds a retried attempt by the caller's remaining budget, not a fresh budget", async () => {
		const worker = new FakeStartupWorker();
		// Simulate the inline-fallback retry: the failed isolated attempt
		// already consumed 25 s of the caller's 30 s init budget.
		const pending = initializeTabWorkerForTest(worker, initPayload, 30_000, performance.now() - 25_000);
		const startedAt = performance.now();

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");

		// 5 s remain → guard min(10 s, 5 s / 3) = 1.67 s → floored to 2 s.
		// A fresh (un-carried) budget would guard for 10 s.
		expect(performance.now() - startedAt).toBeLessThan(8_000);
	});
});

describe("browser init budget exhaustion", () => {
	it("bounds a pre-exhausted init to the setup floor instead of a fresh budget", async () => {
		const worker = new FakeStartupWorker();
		// The caller's budget is fully elapsed before this attempt began: the
		// result can only be discarded by the post-init abort check, so the
		// init must not stretch past the setup floor.
		const startedAt = performance.now() - 30_000;
		const started = performance.now();
		const pending = initializeTabWorkerForTest(worker, initPayload, 30_000, startedAt);

		await expect(pending).rejects.toThrow("Timed out waiting for tab worker setup");
		expect(performance.now() - started).toBeLessThan(3_000);
	});
});

describe("browser init deadline carry-over", () => {
	let sharedHeadless: BrowserHandle | undefined;

	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		sharedHeadless = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	});

	afterAll(async () => {
		if (sharedHeadless) await releaseBrowser(sharedHeadless, { kill: true });
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"counts caller time already spent before acquisition against the worker-init budget",
		async () => {
			const launched = sharedHeadless;
			if (!launched) throw new Error("Expected a shared headless browser");
			// The hang server makes the ready phase burn its (floor-clamped) budget
			// without resolving, so the first init attempt fails on its own.
			const server = Bun.serve({
				port: 0,
				fetch: () => Promise.withResolvers<Response>().promise,
			});
			let failure: unknown;
			try {
				// The caller's deadline started before browser acquisition and that
				// phase consumed the whole budget (simulated with a backdated
				// `deadlineStartMs`): `acquireTabImpl` must count that elapsed time
				// against the worker-init budget instead of starting a fresh
				// `timeoutMs + GRACE_MS` clock. An exhausted budget fails fast with
				// the original init error — never the wrapped inline-fallback error.
				const deadlineStart = performance.now() - 60_000;
				const started = performance.now();
				try {
					await acquireTab(`deadline-carry-${process.pid}-${Math.random().toString(36).slice(2)}`, launched, {
						url: `http://127.0.0.1:${server.port}/hang`,
						waitUntil: "domcontentloaded",
						timeoutMs: 5_000,
						deadlineStartMs: deadlineStart,
					});
				} catch (error) {
					failure = error;
				}
				const elapsed = performance.now() - started;
				expect(failure).toBeDefined();
				expect(String((failure as Error).message)).not.toContain("inline fallback also failed");
				// Only the first attempt's floors are spent (setup floor 2 s + ready
				// floor 500 ms), never a second full budget cycle.
				expect(elapsed).toBeLessThan(4_000);
			} finally {
				await server.stop(true);
			}
		},
		30_000,
	);
});

/**
 * Defends `acquireTabImpl`'s init budget without a browser: the tab worker is the real isolated
 * worker, pointed at a loopback "browser" whose websocket upgrade never completes, so it never
 * reports `setup`. Only the external boundary (the browser endpoint) is faked.
 *
 * Closes: `startedAt` ignoring `deadlineStartMs` (budget restarts after browser acquisition) and the
 * `initBudgetExhausted` fail-fast (an exhausted budget still spending a second, inline attempt), and
 * an abort during init being reported as a startup failure.
 * Gap: the recycle path's own fail-fast and the headless page-close are not exercised here.
 */
describe("acquireTab init budget without a browser", () => {
	function makeStalledBrowser(endpoint: string): BrowserHandle {
		// A headless handle never reaches puppeteer in the supervisor itself: it only reads
		// `wsEndpoint()` to build the payload, and `refCount: 1` keeps release out of the path.
		return {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			browser: { wsEndpoint: () => endpoint, targets: () => [], connected: true },
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;
	}

	async function withStalledEndpoint<T>(onConnect: () => void, run: (endpoint: string) => Promise<T>): Promise<T> {
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				onConnect();
				return Promise.withResolvers<Response>().promise;
			},
		});
		try {
			return await run(`ws://127.0.0.1:${server.port}/devtools/browser/stalled`);
		} finally {
			await server.stop(true);
		}
	}

	async function failureOf(promise: Promise<unknown>): Promise<Error> {
		try {
			await promise;
		} catch (error) {
			if (error instanceof Error) return error;
		}
		throw new Error("Expected acquireTab to reject with an Error");
	}

	const uniqueName = () => `budget-${process.pid}-${Math.random().toString(36).slice(2)}`;

	it("counts time spent before acquisition: an exhausted budget fails with the first attempt's error, no inline retry", async () => {
		await withStalledEndpoint(
			() => {},
			async endpoint => {
				const started = performance.now();
				const failure = await failureOf(
					acquireTab(uniqueName(), makeStalledBrowser(endpoint), {
						timeoutMs: 5_000,
						deadlineStartMs: performance.now() - 60_000,
					}),
				);
				expect(failure.message).toBe("Timed out waiting for tab worker setup");
				// One setup floor (2 s), not two: the inline retry would add another.
				expect(performance.now() - started).toBeLessThan(4_000);
			},
		);
	}, 30_000);

	it("retries inline when budget remains and wraps the final failure with its cause", async () => {
		await withStalledEndpoint(
			() => {},
			async endpoint => {
				const failure = await failureOf(
					acquireTab(uniqueName(), makeStalledBrowser(endpoint), { timeoutMs: 3_000 }),
				);
				expect(failure.message).toContain("inline fallback also failed");
				expect(failure.cause).toBeInstanceOf(Error);
				expect(Object.keys(failure)).toContain("cause");
			},
		);
	}, 30_000);

	it("surfaces an abort that fired during init as an abort, not as a startup failure", async () => {
		const controller = new AbortController();
		await withStalledEndpoint(
			// The worker reaching the endpoint is the moment init is in flight.
			() => controller.abort(),
			async endpoint => {
				const failure = await failureOf(
					acquireTab(uniqueName(), makeStalledBrowser(endpoint), {
						timeoutMs: 3_000,
						signal: controller.signal,
					}),
				);
				expect(failure.name).toBe("ToolAbortError");
				expect(failure.message).toBe("Browser tab open aborted");
			},
		);
	}, 30_000);
});
