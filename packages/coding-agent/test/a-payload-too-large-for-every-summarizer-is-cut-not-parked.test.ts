/**
 * WHY. Reported from a real run. A session printed
 *
 *   "Context overflow recovery failed: Compaction failed: <model> holds 262000
 *    tokens and the summary needed 481608."
 *   "Compaction freed too little context to make progress — pausing automatic
 *    maintenance to avoid a compaction loop."
 *
 * and stopped doing maintenance, with the remedy offered being to start a new
 * session. Nothing was wrong with the history: one body in it was larger than
 * any summarizer on offer could read in one request.
 *
 * WHICH REQUEST OUTGROWS A WINDOW. Not the history one. A long history is
 * planned into staged segments sized to fit, so its estimate stays near the
 * segment budget however long the history is. The turn-prefix request — the
 * part of the turn in progress that falls before the cut point — is built whole
 * and has no staged fallback, so a single oversized body in the current turn is
 * what pushes a summarization request past every candidate window.
 *
 * THE DEFECT. Two budgets exist and only one was enforced. `bar` measures the
 * LIVE context against this model's threshold; the summarization payload is
 * measured against the widest window any candidate declares. When the payload
 * does not fit, the candidate loop skips every model BEFORE `compact()` runs, so
 * no summary is attempted at all. The dead-end rescue then reduced to `bar` — it
 * freed real bytes, reported progress, and scheduled the retry, which rebuilt
 * the same oversized payload and parked. Worse, when the live context already
 * met its bar the rescue short-circuited on `#compactionMeets(bar)` and cut
 * nothing whatsoever, so the retry was guaranteed to fail the same way.
 *
 * THE CLASS THIS CLOSES. Not "one model too small". The class is a compaction
 * that cannot run because the thing it must read is larger than anything that
 * can read it, for which the only recovery is to reduce until it fits. The
 * rescue now takes the gap as a floor: it reports progress only once it has
 * freed at least `payload - widestCandidateWindow`, and the truncation tier cuts
 * to the larger of the two budgets. The suite drives the real `AgentSession`
 * candidate loop, its skip-for-size branch and the whole recovery tail; only the
 * summary text is stubbed, at the module boundary, so the pass that follows the
 * rescue completes the way it does in production and no network call is made.
 *
 * MUTATION GATE. Measure freed tokens from the agent message array instead of
 * the reported context, and both arms park. Truncate to `bar` alone, and the
 * over-threshold arm parks. Restore the `#compactionMeets(bar)` short-circuit,
 * or stop recording the gap, and the rescue never runs at all.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the summary is any good, only that
 * maintenance freed enough for one to be attempted and let the turn continue. It
 * says nothing about a history whose bulk is spread so thin that no single text
 * is large enough to cut — that remains the dead end
 * `a-turn-too-large-to-summarize-is-truncated-not-parked` pins — nor about a
 * candidate window below the fixed floor of a request, where no history cut can
 * ever close the gap and parking is the truthful answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, countTokens } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";

const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
const RECOVERY_FRAGMENT = "Compaction dead-end recovery";

/** Unfenced prose: only the size-driven truncation tier can reduce it. */
function prose(approxTokens: number): string {
	const sample = "sentence 1000 describes an unremarkable observation about record 7000.";
	const count = Math.max(1, Math.ceil(approxTokens / countTokens(sample)));
	const sentences: string[] = [];
	for (let i = 0; i < count; i++) {
		sentences.push(`sentence ${i} describes an unremarkable observation about record ${i * 7}.`);
	}
	return sentences.join(" ");
}

/** Token size of a branch message, whichever shape its body takes. */
function entryTokens(message: object): number {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return countTokens(content);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
			total += countTokens(block.text);
		}
	}
	return total;
}

/**
 * The two ways the payload outgrows every summarizer, both reported by the same
 * dead end. `over-threshold` is the ordinary trigger, where the live context is
 * also above its bar. `within-bar` is the one the short-circuit hid: the live
 * context already meets its bar, so a rescue keyed on the bar alone frees
 * nothing and the retry is guaranteed to park.
 */
const LIVE_CONTEXT_STATES = ["over-threshold", "within-bar"] as const;
/**
 * A realistic window, so threshold compaction triggers the way it does in
 * production; a 16k-class window falls into the reserve regime where the
 * threshold is never reached and nothing would run at all.
 */
const CONTEXT_WINDOW = 200_000;

/**
 * The window every compaction candidate is judged against, so the payload
 * cannot fit one whatever the registry offers. It sits above the fixed part of
 * a summarization request — system prompt, tools, scaffolding, which no history
 * cut can reduce — so the gap this suite opens is one that cutting history can
 * actually close. A window below that fixed floor is a different case: the
 * honest dead end, which `a-turn-too-large-to-summarize-is-truncated-not-parked`
 * pins.
 */
const SUMMARIZER_WINDOW = 20_000;

describe("a payload too large for every summarizer is cut, not parked", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-payload-gap-");
		compactionStarts = 0;
		compactionFailure = undefined;
		fs.mkdirSync(getProjectAgentDir(tempDir.path()), { recursive: true });

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				// Every candidate is judged against this, so the payload cannot fit
				// one no matter which model the registry offers.
				"compaction.modelContextWindow": SUMMARIZER_WINDOW,
				// A small kept tail, so the bulk below falls on the summarized side
				// of the cut point and is therefore part of the payload. Bulk that
				// is merely recent inflates the live context without inflating the
				// summarization request, which is a different case entirely.
				"compaction.keepRecentTokens": 200,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	/** Live context read from the branch, so only a tier that removes bytes moves it. */
	function trackLiveContext(baseTokens: number) {
		vi.spyOn(session, "getContextUsage").mockImplementation(() => {
			let live = 0;
			for (const entry of sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				live += entryTokens(entry.message);
			}
			const tokens = baseTokens + live;
			return { tokens, contextWindow: CONTEXT_WINDOW, percent: (tokens / CONTEXT_WINDOW) * 100 };
		});
	}

	function collectNotices() {
		const notices: { level: string; message: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") {
				notices.push({ level: event.level, message: event.message });
			}
		});
		return notices;
	}

	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: CONTEXT_WINDOW - 2_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: CONTEXT_WINDOW - 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	let compactionStarts = 0;
	let compactionFailure: string | undefined;

	async function runMaintenance() {
		const { promise, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") compactionStarts++;
			// The end event is emitted BEFORE the dead-end rescue runs, so the
			// rescue's own work is awaited through `waitForIdle` below.
			if (event.type === "auto_compaction_end") {
				compactionFailure ??= event.errorMessage;
				resolve();
			}
		});
		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await promise;
		await session.waitForIdle();
	}

	function resumptionRecorder(): () => string[] {
		const resumed: string[] = [];
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			resumed.push("continue");
		});
		vi.spyOn(session.agent, "prompt").mockImplementation((async () => {
			resumed.push("prompt");
		}) as typeof session.agent.prompt);
		return () => resumed;
	}

	/**
	 * Prior turns large enough that the summarization request outgrows every
	 * candidate window, followed by a small recent turn the cut point keeps.
	 * Assistant turns carry content blocks, which is the shape a real branch
	 * holds: a string-bodied assistant entry is not a turn the cut point reads.
	 */
	function assistantMessage(text: string): void {
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
	}

	function smallAssistantTurn(text: string): void {
		assistantMessage(text);
		sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	}

	function seedOversizedHistory(): void {
		// Prior turns the cut point can summarize normally, then ONE long turn
		// whose first message is oversized. The cut point falls inside that turn,
		// so its earlier messages are summarized as a TURN PREFIX. The history
		// request is staged into segments that fit any window; the turn-prefix
		// request is not staged, so a single oversized body in it pushes the
		// request past every candidate window. That is the reported shape.
		for (let i = 0; i < 6; i++) smallAssistantTurn(prose(60));
		sessionManager.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
		assistantMessage(prose(60_000));
		for (let i = 0; i < 6; i++) assistantMessage(prose(60));
	}

	function branchTokens(): number {
		let total = 0;
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			total += entryTokens(entry.message);
		}
		return total;
	}

	/**
	 * The summarizer is stubbed at the module boundary, not the network: the
	 * candidate loop, the size check that skips every candidate and the whole
	 * recovery tail are the production ones. Returns the calls it received, so
	 * the suite can assert that no summarization was attempted while the payload
	 * could not fit — the skip happens BEFORE a request is built — and that one
	 * is attempted once the rescue has made it fit.
	 */
	function summarizerCalls(): () => number {
		let calls = 0;
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			calls++;
			return {
				summary: "compacted",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		return () => calls;
	}

	/**
	 * No network call is reachable in this shape, so any attempt to open one is a
	 * defect in the test rather than a slow test. Asserted rather than assumed.
	 */
	function forbidProviderCalls(): void {
		vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("a network request was attempted; the summarizer is stubbed at the module boundary");
		}) as unknown as typeof globalThis.fetch);
	}

	for (const state of LIVE_CONTEXT_STATES) {
		it(`frees the summarizer gap and keeps the turn alive (${state})`, async () => {
			// Bulk far past the summarizer window: no summarization request built
			// from this branch can fit SUMMARIZER_WINDOW.
			seedOversizedHistory();
			forbidProviderCalls();
			const summarized = summarizerCalls();
			const resumed = resumptionRecorder();
			// `over-threshold` also sits above the recovery band. `within-bar`
			// reports a live context that already satisfies the bar, which is
			// precisely when the old short-circuit cut nothing at all.
			trackLiveContext(state === "over-threshold" ? 120_000 : 0);

			const before = branchTokens();
			const notices = collectNotices();
			await runMaintenance();
			const after = branchTokens();

			// A variant that never reached compaction proves nothing about the
			// rescue, so it fails as itself rather than as a timeout downstream.
			// The reported condition, not some other summarizer failure: every
			// candidate refused on size before a request was built.
			expect(compactionFailure ?? "").toContain("the summary needed");
			expect(compactionStarts).toBeGreaterThan(0);
			expect(notices.filter(n => n.message.includes(NO_PROGRESS_FRAGMENT))).toEqual([]);
			const recovery = notices.filter(n => n.message.includes(RECOVERY_FRAGMENT));
			expect(recovery).toHaveLength(1);
			expect(recovery[0]?.level).toBe("info");

			// The gap is what had to go: the branch must now be small enough for a
			// summarization request against the candidate window to be possible at
			// all, not merely smaller than it was. Cutting to the model's own bar —
			// which `within-bar` already met — leaves it far above this.
			expect(before).toBeGreaterThan(SUMMARIZER_WINDOW * 2);
			expect(after).toBeLessThan(SUMMARIZER_WINDOW);

			// Maintenance made progress, so the turn continues rather than parking.
			expect(resumed().length).toBeGreaterThan(0);

			// The cut is what made a summary possible: none was attempted while the
			// payload was oversized, and the pass that follows the rescue reaches one.
			expect(summarized()).toBeGreaterThan(0);
		}, 60_000);
	}

	it("sweeps every live-context state the dead end is reachable from", () => {
		expect([...LIVE_CONTEXT_STATES]).toEqual(["over-threshold", "within-bar"]);
	});
});
