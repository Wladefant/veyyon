import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import { waitForDiagnostics } from "@veyyon/coding-agent/lsp/diagnostics";
import type { Diagnostic, LspClient } from "@veyyon/coding-agent/lsp/types";

/**
 * WHY: `waitForDiagnostics` read its state on a 100ms poll. The publish that decided the answer was
 * seen at the next tick, so a version-matched publish cost up to 100ms more than the server took, and
 * an unversioned one (typescript-language-server never echoes the version) opened its settle window at
 * the tick instead of at the publish: a server that answered every edit in 50ms was reported at
 * 400ms. An abort was noticed at the next tick as well.
 *
 * CLASS CLOSED: every event the wait reads (a publish for the document, a superseding publish, a pull
 * report, a pull that answers nothing, an abort) and every deadline it keeps (the settle window, the
 * budget) ends the wait at the fake millisecond it happens, and every exit path releases its publish
 * listener, its abort listener and its timer. A wake source added to the loop without a row here
 * shows up as a wait that ends late in the row that exercises it.
 *
 * NOT CAUGHT: how fast a real server publishes, and the writethrough's 500ms inline cap, which
 * selects whether a slow answer is shown inline or delivered later.
 */

const URI = "file:///repo/src/a.ts";
const OTHER_URI = "file:///repo/src/b.ts";
const SETTLE_MS = 250;
const BUDGET_MS = 1000;

function diagnostic(message: string): Diagnostic {
	return { message, severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
}

function fakeClient(pull: boolean): LspClient {
	return {
		name: "fake-lsp",
		cwd: "/repo",
		config: { command: "fake-lsp", fileTypes: [".ts"], rootMarkers: [] },
		proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
		serverCapabilities: pull ? { diagnosticProvider: { interFileDependencies: false } } : undefined,
	};
}

/** An event that records a publish of one diagnostic named `message` for `uri`, as the reader loop does. */
function publish(client: LspClient, uri: string, message: string, version: number | null): () => void {
	return () => lspClient.recordPublishedDiagnostics(client, uri, { diagnostics: [diagnostic(message)], version });
}

/** Answer the client's outstanding `textDocument/diagnostic` request the way the reader loop does. */
function answerPull(client: LspClient, report: unknown): void {
	for (const [id, pending] of client.pendingRequests) {
		if (pending.method !== "textDocument/diagnostic") continue;
		client.pendingRequests.delete(id);
		pending.resolve(report);
	}
}

/** A real signal whose abort registrations and removals are counted. */
function countingSignal(): { signal: AbortSignal; live: () => number; abort: () => void } {
	const controller = new AbortController();
	const signal = controller.signal;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	let live = 0;
	signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
		if (type === "abort") live++;
		return add(type as "abort", listener, options as AddEventListenerOptions);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
		if (type === "abort") live--;
		return remove(type as "abort", listener, options as EventListenerOptions);
	}) as typeof signal.removeEventListener;
	return { signal, live: () => live, abort: () => controller.abort() };
}

/** One real event-loop turn, so continuations queued by a fired fake timer run before time moves. */
function realTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

interface Settled {
	at: number;
	diagnostics?: Diagnostic[];
	error?: unknown;
}

interface Row {
	name: string;
	pull: boolean;
	/** Events at fake milliseconds after the wait starts. */
	events: (client: LspClient, abort: () => void) => Array<[number, () => void]>;
	expectedDocumentVersion?: number;
	at: number;
	messages?: string[];
	aborted?: boolean;
}

const ROWS: Row[] = [
	{
		name: "a version-matched publish ends the wait when it lands",
		pull: false,
		expectedDocumentVersion: 2,
		events: client => [[37, publish(client, URI, "matched", 2)]],
		at: 37,
		messages: ["matched"],
	},
	{
		name: "an unversioned publish settles exactly one window after it lands",
		pull: false,
		events: client => [[37, publish(client, URI, "unversioned", null)]],
		at: 37 + SETTLE_MS,
		messages: ["unversioned"],
	},
	{
		name: "a superseding publish restarts the settle window from its own arrival",
		pull: false,
		events: client => [
			[37, publish(client, URI, "pre-edit", null)],
			[137, publish(client, URI, "post-edit", null)],
		],
		at: 137 + SETTLE_MS,
		messages: ["post-edit"],
	},
	{
		name: "a publish for another document leaves the wait running to its budget",
		pull: false,
		events: client => [[20, publish(client, OTHER_URI, "other", 1)]],
		at: BUDGET_MS,
		messages: [],
	},
	{
		name: "a pull report ends the wait when it lands",
		pull: true,
		events: client => [[53, () => answerPull(client, { kind: "full", items: [diagnostic("pulled")] })]],
		at: 53,
		messages: ["pulled"],
	},
	{
		name: "a pull that answers nothing leaves the wait on publishes",
		pull: true,
		expectedDocumentVersion: 4,
		events: client => [
			[10, () => answerPull(client, null)],
			[60, publish(client, URI, "published", 4)],
		],
		at: 60,
		messages: ["published"],
	},
	{
		name: "an abort ends the wait when it fires",
		pull: false,
		events: (_client, abort) => [[50, abort]],
		at: 50,
		aborted: true,
	},
];

describe("a diagnostics wait returns when the deciding publish lands", () => {
	let liveSubscriptions = 0;

	beforeEach(() => {
		vi.useFakeTimers();
		liveSubscriptions = 0;
		const subscribe = lspClient.onDiagnosticsPublish;
		vi.spyOn(lspClient, "onDiagnosticsPublish").mockImplementation((client, listener) => {
			liveSubscriptions++;
			const stop = subscribe(client, listener);
			return () => {
				liveSubscriptions--;
				stop();
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(ROWS)("$name", async row => {
		const client = fakeClient(row.pull);
		const { signal, live, abort } = countingSignal();
		const start = Date.now();
		for (const [ms, event] of row.events(client, abort)) setTimeout(event, ms);
		const outcome: { settled?: Settled } = {};
		void waitForDiagnostics(client, URI, {
			timeoutMs: BUDGET_MS,
			settleMs: SETTLE_MS,
			signal,
			expectedDocumentVersion: row.expectedDocumentVersion,
		}).then(
			diagnostics => {
				outcome.settled = { at: Date.now() - start, diagnostics };
			},
			(error: unknown) => {
				outcome.settled = { at: Date.now() - start, error };
			},
		);
		for (let ms = 0; ms <= BUDGET_MS + 1 && !outcome.settled; ms++) {
			await realTurn();
			if (!outcome.settled) vi.advanceTimersByTime(1);
		}
		const settled = outcome.settled;
		if (!settled) throw new Error(`the wait did not end within ${BUDGET_MS + 1}ms of fake time`);

		expect(settled.at).toBe(row.at);
		if (row.aborted) {
			expect(settled.error).toBeInstanceOf(Error);
		} else {
			expect(settled.error).toBeUndefined();
			expect(settled.diagnostics?.map(d => d.message)).toEqual(row.messages);
		}
		expect(liveSubscriptions).toBe(0);
		expect(live()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
