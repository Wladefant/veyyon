import { registerOwnedResourceDisposer } from "@veyyon/kernel/session/owned-resources";
import { errorMessage, isCancellation, logger, postmortem, Snowflake, workerHostEntry } from "@veyyon/utils";
// The owner, not the barrel: this module reaches the two discard contracts and nothing else.
import { bestEffort, optionalResult } from "@veyyon/utils/discarded-fault";
import { callSessionTool } from "../../../eval/js/tool-bridge";
import { logWorkerMessage } from "../../../subprocess/worker-log";
import { raceWithTimeout } from "../../../utils/fetch-timeout";
import { webpExclusionForModel } from "../../../utils/image-loading";
import { TAB_WORKER_ARG } from "../../../worker-args";
import { expandPath } from "../../core/path-utils";
import { ToolAbortError, ToolError } from "../../core/tool-errors";
import type { ToolSession } from "../../index";
import { pickElectronTarget } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import type {
	BrowserRunError,
	ReadyInfo,
	RunResultOk,
	SessionSnapshot,
	TabRunErrorPayload,
	TabWorkerInbound,
	TabWorkerOutbound,
	TabWorkerTransport,
	Transferable,
	WorkerInitPayload,
} from "./tab-protocol";
import { targetIdForPage, targetIdForTarget } from "./target-id";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/standalone builds only need one JavaScript entry.

interface WorkerHandle {
	send(msg: TabWorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: TabWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

/**
 * Terminate a tab worker, in one place.
 *
 * Every caller reaches this while tearing a tab down, either because the tab was released or because the
 * worker stopped answering and is being replaced. None of them can usefully throw: the release has already
 * removed the tab, and the recycle paths raise their own error describing why the recycle failed, which is
 * the error the operator needs rather than the terminate that came after it.
 *
 * The failure is still reported, because it is not free. A terminate fails either because the worker has
 * already exited, which is harmless, or because it is alive and refusing to stop, and in the second case
 * the tab is dropped from the registry while the process keeps running. That is a leaked worker for the
 * lifetime of the session, so it is logged with the reason and the site that was tearing down.
 */
async function terminateWorker(worker: WorkerHandle, context: string): Promise<void> {
	try {
		await worker.terminate();
	} catch (error) {
		logger.warn("browser tab worker did not terminate", { context, mode: worker.mode, error: errorMessage(error) });
	}
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under an agent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	/**
	 * `performance.now()` timestamp at which the caller's timeout budget
	 * started. Callers whose deadline began before this acquisition —
	 * `browser.ts` `open` starts its clock before `acquireBrowser` — pass it
	 * through so time spent in earlier phases within the caller's deadline
	 * counts against the worker-init budget instead of restarting it.
	 * Omit for a fresh clock.
	 */
	deadlineStartMs?: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
}

const tabs = new Map<string, TabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
// Headless targets a worker created before dying during init (page-created).
// A killed worker can't close its own page; the supervisor closes the
// recorded target instead. A shared browser's other targets must never be
// touched.
const workerPageTargets = new WeakMap<WorkerHandle, string>();
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Cold-start guard for the worker's `setup` handshake (realm usable: puppeteer
// loaded, browser connected, page acquired). On hosts where the worker's cold
// import stalls (observed: Bun worker inside a full RPC process), an
// unbounded first-attempt init would consume the caller's entire timeout
// before the inline fallback could engage. Budget: min(10s, remaining/3),
// floor 2s, where remaining is what the caller's budget has left at attempt start.
const SETUP_BUDGET_FLOOR_MS = 2_000;
const SETUP_BUDGET_CAP_MS = 10_000;
// Floor for the ready-phase budget: the 2s setup floor can consume more than
// a sub-3s caller's entire init budget, so the remaining-budget math must
// never hand raceWithTimeout a non-positive value.
const READY_BUDGET_FLOOR_MS = 500;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();

const REPORTED_INIT_FAILURE = Symbol("reported-init-failure");

function markReportedInitFailure(error: Error): Error {
	Object.defineProperty(error, REPORTED_INIT_FAILURE, { value: true, configurable: true });
	return error;
}

function isReportedInitFailure(error: unknown): boolean {
	return error instanceof Error && REPORTED_INIT_FAILURE in error;
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Worker-init deadline: the inline-fallback retry passes this same start
	// so it can't restart the budget (which would let a cold import that
	// consumed most of it spend the phase floors again for another full
	// budget). Defaults to a fresh clock; callers whose own deadline started
	// earlier (browser acquisition is not part of this budget) pass theirs
	// through `deadlineStartMs` so that earlier time counts against it.
	const startedAt = opts.deadlineStartMs ?? performance.now();
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		// The caller acquired (and published) the browser handle before queueing this
		// open, so an abort at dequeue must drop it too — otherwise a live Chromium
		// sits in `browsers` at refCount 0 with no tab pointing at it.
		if (browser.refCount === 0) {
			await bestEffort(releaseBrowser(browser, { kill: false }), "the abort is what the caller gets, not this");
		}
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				// Re-fetch after the awaited reuse steps: the tab can be released
				// concurrently while the snapshot run is in flight.
				const reused = tabs.get(name);
				if (!reused) {
					throw new Error(`Browser tab "${name}" was released while being reused; retry the operation`);
				}
				return { tab: reused, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	// Init budget: the caller's timeout plus the supervisor grace — never a
	// fixed floor. A floor larger than the caller's budget would keep a wedged
	// worker (and its orphaned page on a shared browser) alive long after the
	// caller gave up; the phase floors inside initializeTabWorker keep each
	// phase positive for sub-second budgets, and the caller's abort signal is
	// the hard backstop for floor overshoot.
	const initBudgetMs = opts.timeoutMs + GRACE_MS;
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await terminateWorker(worker, "open-init-failed");
		// A headless worker that died mid-init may have already created its page in the
		// shared browser — a killed worker can't close it, so close the target the worker
		// reported (no-op when it never got that far).
		closeAbandonedWorkerPage(browser, worker);
		if (worker.mode === "inline" || isReportedInitFailure(error)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		// Fail fast once the caller's init budget is exhausted: its timeout has already
		// fired, so a retried result would only be discarded by the post-init abort check —
		// don't spend the phase floors' excess on a cold start nobody is waiting for.
		if (initBudgetExhausted(initBudgetMs, startedAt)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: errorMessage(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
		} catch (inlineError) {
			await terminateWorker(worker, "open-inline-failed");
			closeAbandonedWorkerPage(browser, worker);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${errorMessage(inlineError)}`,
			);
			finalError.cause = error;
			if (opts.signal?.aborted) throw new ToolAbortError("Browser tab open aborted");
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker,
	// tear the freshly-built worker down before publishing the tab so the
	// browser refCount (which `holdBrowser` below would take) never grows for
	// a tab nobody is waiting for.
	if (opts.signal?.aborted) {
		await terminateWorker(worker, "open-aborted");
		closeAbandonedWorkerPage(browser, worker);
		// The browser release runs while an abort is already being raised; its own failure must not
		// replace `ToolAbortError`, and the refCount it adjusts is dropped with the browser anyway.
		// `|| browser.refCount === 0` matches every sibling error path above (:257, :269,
		// :281, :292). Without it, an abort here strands the handle `acquireBrowser`
		// already published at refCount 0 — and nothing walks `browsers`, only `tabs`.
		if (tempHold || browser.refCount === 0) {
			await bestEffort(releaseBrowser(browser, { kill: false }), "the abort is what the caller gets, not this");
		}
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		ownerSessionId: opts.ownerSessionId,
	};
	worker.onMessage(msg => handleTabMessage(tab, msg));
	tabs.set(name, tab);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			// Rolling back the surface we created while the open error is already propagating; that error is what
			// the caller needs, and a close that fails means the surface is already gone with the browser.
			await bestEffort(
				browser.client.request("surface.close", { surface_id: surfaceId }),
				"a close that fails means the surface is already gone with the browser",
			);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and agent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	tab.pending.set(id, pending);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
		}
	}
	const abort = (): void => {
		// `safeSend`, not `tab.worker.send`: this runs from an `abort` event listener, so a
		// throw from a worker terminated by a concurrent recycle/force-kill would escape
		// with nowhere to go. Every other post-init send in this file is already guarded.
		safeSend(tab, { type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		// An already-aborted signal must NOT send `abort` and then `run`: the worker drops
		// the abort (`#active` is still null, so `case "abort"`'s id check fails), the run
		// then executes to completion, and the caller blocks the full timeout on a
		// cancellation it already requested. Throw instead of sending anything — and throw
		// INSIDE the try, because the `finally` below deletes the pending entry. Leaking it
		// would leave `tab.pending.size > 0` forever, making the tab permanently "busy".
		if (opts.signal?.aborted) throw new ToolAbortError("Browser run aborted");
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		try {
			return await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				() => new ToolError("Browser code execution hung past grace; tab killed"),
				{ onTimeout: async () => await forceKillTab(name, "Browser code execution hung past grace; tab killed") },
			);
		} catch (error) {
			if (error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ")) {
				try {
					if (tab.worker.mode === "inline")
						await forceKillTab(name, "Browser code execution timed out; tab killed");
					else await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
				} catch (recycleError) {
					logger.warn("Failed to recycle timed-out browser tab worker; killing tab", {
						error: errorMessage(recycleError),
					});
					await forceKillTab(name, "Browser code execution timed out; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	}
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {
				// The tab is already marked dead: a worker that has exited cannot be
				// told to abort, and the abort below cancels the call regardless.
			}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	if (tab.backend === "cmux") {
		let nonLastCloseError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await tab.browser.client.request("surface.close", { surface_id: tab.targetId });
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: errorMessage(err),
					});
				} else {
					nonLastCloseError = err;
				}
			}
		}
		await releaseBrowser(tab.browser, { kill: opts.kill ?? false });
		tabs.delete(name);
		if (nonLastCloseError) throw nonLastCloseError;
		return true;
	}
	let forced = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await terminateWorker(tab.worker, "release-tab");
	if (forced && tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: opts.kill ?? false });
	tabs.delete(name);
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = Array.from(tabs.keys());
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = Array.from(tabs.values())
		.filter(tab => tab.kindTag === "headless")
		.map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: an agent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = Array.from(tabs.values())
		.filter(tab => tab.ownerSessionId === ownerId)
		.map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = errorMessage(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	const page = await pickElectronTarget(browser.browser, opts.target);
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		targetId,
		dialogs: opts.dialogs,
		url: opts.url,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
	};
}

function handleTabMessage(tab: WorkerTabSession, msg: TabWorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		const failure: BrowserRunError = errorFromPayload(msg.error);
		// Carried on the error rather than resolved separately: the run DID fail, so the caller must
		// still see a rejection, and the output it produced first is context for that rejection.
		if (msg.partial) failure.partialRunOutput = msg.partial;
		pending.reject(failure);
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<TabWorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: TabWorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: errorMessage(err) });
	}
}

function toErrorPayload(error: unknown): TabRunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			// Deadlines count as aborts for this classification: the caller uses the
			// flag to decide whether the tab stopped for a reason of its own, and a
			// timeout is one.
			isAbort: isCancellation(error),
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: errorMessage(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number): Promise<void> {
	// Same deadline carry-over as acquireTabImpl: the inline-fallback retry
	// must not restart the recycle's init budget.
	const startedAt = performance.now();
	const oldWorker = tab.worker;
	await terminateWorker(oldWorker, "recycle-timed-out");
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		timeoutMs,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
	};
	let worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs, startedAt);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		worker.onMessage(msg => handleTabMessage(tab, msg));
	} catch (error) {
		await terminateWorker(worker, "recycle-spawn-failed");
		// The recycle's budget is exhausted: the run caller already timed out, so a
		// retried init can't beat its deadline — fail fast and let the caller
		// force-kill the tab instead of spending the phase floors' excess.
		if (initBudgetExhausted(timeoutMs, startedAt)) {
			throw error;
		}
		worker = await spawnInlineWorker();
		try {
			const info = await initializeTabWorker(worker, payload, timeoutMs, startedAt);
			tab.worker = worker;
			tab.info = info;
			tab.state = "alive";
			worker.onMessage(msg => handleTabMessage(tab, msg));
		} catch (inlineError) {
			await terminateWorker(worker, "recycle-inline-failed");
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${errorMessage(inlineError)}`,
			);
			finalError.cause = error;
			throw finalError;
		}
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		return;
	}
	await terminateWorker(tab.worker, "force-kill");
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
}

/**
 * Best-effort close of a specific page target in the browser. A gone target
 * or a released browser is skipped: per-target lookups and the page close are
 * individually caught.
 */
async function closeTargetById(browser: PuppeteerBrowserHandle, targetId: string): Promise<void> {
	for (const target of browser.browser.targets()) {
		const id = await optionalResult(targetIdForTarget(target), "an id that cannot be read cannot match");
		if (id !== targetId) continue;
		const page = await optionalResult(target.page(), "a target that hands over no page has nothing to close");
		if (page) await bestEffort(page.close(), "a close that fails means the target closed itself first");
		return;
	}
}

/**
 * Best-effort cleanup for a forced-kill path: close the page the tab's worker
 * reported as created. A run caller is never a browser ref holder, so the
 * browser is still in the registry; the tab's browser is the only place that
 * page can be, so no targetId guesswork across multiple sessions.
 */
async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	await closeTargetById(tab.browser, tab.targetId);
}

/**
 * Close the page a worker created (page-created) before dying during init.
 * Fire-and-forget: the caller has already timed out, so the close must not
 * delay error propagation — `page.close()` on a page still stuck in the
 * navigation that caused the timeout waits about as long again. A killed worker
 * can't clean up after itself; a shared browser's other targets must never be
 * touched.
 */
function closeAbandonedWorkerPage(browser: PuppeteerBrowserHandle, worker: WorkerHandle): void {
	const targetId = workerPageTargets.get(worker);
	workerPageTargets.delete(worker);
	if (!targetId) return;
	// The close outlives its caller, and every caller here may go on to release
	// the last browser reference — `closeTargetById` yields before it looks the
	// target up, so a disconnect in that gap turns the lookup into a caught
	// failure and leaves the page on the instance for good. Hold the browser
	// across the close instead of blocking on it: the hold defers the release
	// (and the dispose behind it) rather than cancelling one, so the refCount
	// ends where it would have, one turn later.
	holdBrowser(browser);
	void closeTargetById(browser, targetId)
		.catch(() => undefined)
		.finally(() => void releaseBrowser(browser, { kill: false }).catch(() => undefined));
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, () => new ToolError("Timed out closing browser tab worker"));
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

function errorFromPayload(payload: TabRunErrorPayload): Error {
	const error = payload.isAbort
		? new ToolAbortError()
		: payload.isToolError
			? new ToolError(payload.message)
			: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: [TAB_WORKER_ARG] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: errorMessage(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as TabWorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: TabWorkerOutbound) => void>();
	const workerListeners = new Set<(message: TabWorkerInbound) => void>();
	const workerTransport: TabWorkerTransport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as TabWorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: TabWorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(workerTransport);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async terminate() {},
	};
}

/**
 * Init a tab worker under a single listener spanning the whole init: a short
 * `setup` handshake (bounded by the cold-start guard so a stalled cold start
 * triggers the inline fallback early) and the ready wait for page acquisition
 * and the first navigation. Both phases are bounded by the time LEFT of the
 * caller's `timeoutMs` budget, measured from `deadlineStart` (performance.now()
 * when the caller's budget began): a retried attempt — the inline fallback
 * after a failed isolated worker — passes the same start, so total init
 * across attempts stays within the caller's timeout instead of the retry
 * restarting the clock. A headless worker's `page-created` report (the new
 * target, sent before the slow post-creation CDP work) is recorded in
 * `workerPageTargets` so a supervisor that kills the worker during init
 * (budget exhausted, aborted open) can close exactly the page the worker
 * created — a killed worker can't clean up after itself. The listener is
 * never removed between the phases: the inline transport delivers messages
 * on microtasks, so a `ready` or `init-failed` emitted right after `setup`
 * (e.g. a fast `page.goto` rejection) could otherwise reach the
 * already-settled setup listener before a phase switch re-listens and be
 * dropped.
 */
async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	// Derive both phase budgets from the remaining caller budget so a
	// retried attempt (inline fallback) cannot outlive the caller's timeout.
	// The floors keep the budgets positive when the remaining time is tiny;
	// the caller's abort signal remains the hard backstop for the overshoot.
	const remainingMs = timeoutMs - Math.round(performance.now() - deadlineStart);
	// Cold-start guard: min(10s, remaining/3), floor 2s (see SETUP_BUDGET_*).
	const setupBudgetMs = Math.max(SETUP_BUDGET_FLOOR_MS, Math.min(SETUP_BUDGET_CAP_MS, Math.floor(remainingMs / 3)));
	const setup = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<ReadyInfo>();
	let setupDone = false;
	// Reject only the active phase's promise: the other one may never be
	// awaited (a phase that already failed leaves the rest un-run), so
	// rejecting it would be an unhandled rejection.
	const failStartup = (error: Error) => {
		(setupDone ? ready : setup).reject(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "page-created") {
			// Record the headless target before the (potentially slow)
			// post-creation CDP work: if this init is killed before ready,
			// the supervisor closes exactly this target.
			workerPageTargets.set(worker, msg.targetId);
		} else if (msg.type === "setup") {
			setupDone = true;
			setup.resolve();
		} else if (msg.type === "ready") ready.resolve(msg.info);
		else if (msg.type === "init-failed") failStartup(markReportedInitFailure(errorFromPayload(msg.error)));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		failStartup(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		await raceWithTimeout(
			setup.promise,
			setupBudgetMs,
			() => new ToolError("Timed out waiting for tab worker setup"),
		);
		// The ready wait gets only what is left of the caller's budget at
		// this point; the floor covers sub-3s budgets where the 2s setup
		// floor alone exceeds it.
		const readyBudgetMs = Math.max(READY_BUDGET_FLOOR_MS, timeoutMs - Math.round(performance.now() - deadlineStart));
		return await raceWithTimeout(
			ready.promise,
			readyBudgetMs,
			() => new ToolError("Timed out initializing browser tab worker"),
		);
	} finally {
		unlisten();
		unlistenError();
	}
}

/**
 * True once the caller's init budget (elapsed since `deadlineStart`) is fully
 * consumed. A retry from this point can't be published — the caller's timeout
 * has already fired, so the post-init abort check would discard the result
 * anyway — so callers fail fast instead of spending the phase floors' excess
 * on a cold start nobody is waiting for.
 */
function initBudgetExhausted(budgetMs: number, deadlineStart: number): boolean {
	return budgetMs - Math.round(performance.now() - deadlineStart) <= 0;
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}

/**
 * Wire tab release into the session's owner-scoped cleanup.
 *
 * Keyed by the SESSION id, not the eval-kernel owner id: `ownerSessionId` is stamped at
 * `acquireTab` creation and never on reuse, so an agent re-driving a tab another session opened
 * does not take teardown responsibility from the creator. Bounded, because teardown talks to a
 * live CDP connection and a broken close must not stall `/exit` (issue #3963).
 */
registerOwnedResourceDisposer({
	name: "browser-tabs",
	scope: "session",
	timeoutMs: 3_000,
	dispose: ownerId => releaseTabsForOwner(ownerId, { kill: true }),
});
