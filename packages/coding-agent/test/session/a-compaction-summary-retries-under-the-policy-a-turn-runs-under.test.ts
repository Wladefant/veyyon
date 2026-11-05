/**
 * WHY: the auto-compaction summary ran its own retry loop beside the turn's. It read the global
 * `retry.maxRetries` whatever the provider, so a Cursor or Devin summary that fails minutes in was
 * re-sent ten times where a turn sends it three or two times; its backoff ladder had no per-attempt
 * ceiling (256 s before the tenth attempt); it slept through any wait the provider stated, however
 * far past `retry.maxDelayMs`; and it retried a spent allowance on the ladder without parking the
 * credential. A Cursor "You're out of usage" summary was sent eleven times over eight and a half
 * minutes while the session sat in compaction, where the same failure ends a turn at once.
 *
 * Class closed: a failed summary retries under the policy a turn on the same model runs under.
 * - attempt count: every built-in provider policy (swept from `PROVIDER_RETRY_DEFAULTS`) and an
 *   operator `retry.perProvider` entry;
 * - backoff: no wait past the per-attempt ceiling a turn uses;
 * - a stated wait past `retry.maxDelayMs`: not slept, the summary fails;
 * - a usage limit no sibling account can serve: one send, across the usage-limit wordings;
 * - a usage limit a sibling account took over: re-sent at once;
 * - a model the account's plan does not serve: one send.
 *
 * The clock is the one boundary replaced: `scheduler.wait` records the wait and returns at once, so
 * a wait the old loop slept for hours shows up as a recorded number instead of a hung test.
 *
 * Does not catch: which sibling the credential layer picks (the library contract in packages/ai),
 * nor a candidate chain moving on to the next model (the fallback-announcement suites).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as AIError from "@veyyon/ai/error";
import { emptyUsage, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import {
	PROVIDER_RETRY_DEFAULTS,
	RETRY_BACKOFF_MAX_DELAY_MS,
	resolveRetryPolicy,
} from "@veyyon/kernel/session/retry-policy";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { extractRetryHint, TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

/** The shipped `retry.*` defaults, which the incident ran under. */
const GLOBAL_RETRY = { maxRetries: 10, baseDelayMs: 500, maxDelayMs: 5 * 60 * 1000 };

const TRANSIENT = "Summarization failed: 503 service unavailable";

/** A spent allowance in each provider's words. None states a wait inside `retry.maxDelayMs`. */
const USAGE_LIMITS = [
	"Summarization failed: Connect error resource_exhausted: Increase limits for faster responses: You're out of usage. Switch to Auto or ask your admin to increase your limit to continue. (ERROR_RATE_LIMITED)",
	"Summarization failed: 429 The usage limit has been reached (usage_limit_reached)",
	"Summarization failed: 403 You have run out of credits for this billing period",
	"Summarization failed: 402 Insufficient balance on the account",
	"Summarization failed: 429 You have exhausted your capacity on this model. Your quota will reset after 3h12m.",
] as const;

const NOT_IN_PLAN =
	"Summarization failed: Connect error resource_exhausted: Named models unavailable: Free plans can only use Auto. Switch to Auto or upgrade plans to continue. (ERROR_RATE_LIMITED_CHANGEABLE)";

const STATED_LONG_WAIT = "Summarization failed: 503 service unavailable. Please try again in 120 min";

/** A bundled row of `provider` sized like the anthropic row, so one threshold turn compacts every candidate. */
function rowOf(provider: string): Model | undefined {
	const known = getBundledProviders().find(entry => entry === provider);
	const row = known === undefined ? undefined : getBundledModels(known)[0];
	return row === undefined ? undefined : { ...row, contextWindow: 200_000, maxTokens: 64_000 };
}

describe("a compaction summary retries under the policy a turn runs under", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let waits: number[];

	const anthropic = requireBundledModel("anthropic", "claude-sonnet-4-5");
	const ordinary: Model = { ...anthropic, contextWindow: 200_000, maxTokens: 64_000 };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-compaction-retry-policy-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		waits = [];
		vi.spyOn(scheduler, "wait").mockImplementation(async (delay?: number) => {
			waits.push(delay ?? 0);
			return undefined;
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
			session = undefined;
		} finally {
			authStorage?.close();
			tempDir?.removeSync();
			vi.restoreAllMocks();
		}
	});

	function createSession(model: Model, settings: Record<string, unknown> = {}) {
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"compaction.remote": false,
				"compaction.modelFallbackStrategy": "configured-only",
				"compaction.modelContextWindow": 200_000,
				"retry.maxRetries": GLOBAL_RETRY.maxRetries,
				"retry.baseDelayMs": GLOBAL_RETRY.baseDelayMs,
				"retry.maxDelayMs": GLOBAL_RETRY.maxDelayMs,
				...settings,
			} as Parameters<typeof Settings.isolated>[0]),
			modelRegistry,
		});
		for (let turn = 0; turn < 4; turn++) {
			const user = { role: "user" as const, content: `question ${turn} `.repeat(400), timestamp: Date.now() };
			const assistant = turnOf(model, `answer ${turn} `.repeat(400), 1_000);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		return session;
	}

	function turnOf(model: Model, text: string, input: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop" as const,
			usage: { ...emptyUsage(), input, output: 100, totalTokens: input + 100 },
			timestamp: Date.now(),
		};
	}

	/** Push the context past the threshold and wait for the compaction it starts to end. */
	async function runAutoCompaction(active: AgentSession, model: Model) {
		const ends: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const { promise: done, resolve } = Promise.withResolvers<void>();
		active.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				ends.push(event);
				resolve();
			}
		});
		const turn = turnOf(model, "Done.", 190_000);
		active.agent.emitExternalEvent({ type: "message_end", message: turn });
		active.agent.emitExternalEvent({ type: "agent_end", messages: [turn] });
		await done;
		await active.waitForIdle();
		return ends;
	}

	/** `compact` fails with `failures` in order, then summarizes; returns the send counter. */
	function summaryFailing(...failures: string[]) {
		const sent = { count: 0 };
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			const failure = failures[sent.count];
			sent.count += 1;
			if (failure !== undefined) throw new Error(failure);
			return {
				summary: "summary",
				shortSummary: "short",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: {},
			};
		});
		return sent;
	}

	function alwaysFailing(message: string) {
		return summaryFailing(...Array.from({ length: 64 }, () => message));
	}

	it("every built-in provider policy can be exercised", () => {
		const unconstructable = Object.keys(PROVIDER_RETRY_DEFAULTS).filter(provider => rowOf(provider) === undefined);
		expect(unconstructable).toEqual([]);
	});

	for (const provider of Object.keys(PROVIDER_RETRY_DEFAULTS)) {
		it(`sends a transient ${provider} summary as many times as a ${provider} turn`, async () => {
			const model = rowOf(provider);
			if (!model) throw new Error(`no bundled ${provider} row`);
			const policy = resolveRetryPolicy(GLOBAL_RETRY, undefined, model);
			// Non-vacuous: the provider's own count differs from the global one the old loop read.
			expect(policy.maxRetries).not.toBe(GLOBAL_RETRY.maxRetries);
			const sent = alwaysFailing(TRANSIENT);

			const ends = await runAutoCompaction(createSession(model), model);

			expect(sent.count).toBe(1 + policy.maxRetries);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.result).toBeUndefined();
		});
	}

	it("sends a summary as many times as an operator retry.perProvider entry allows", async () => {
		const sent = alwaysFailing(TRANSIENT);

		await runAutoCompaction(
			createSession(ordinary, { "retry.perProvider": { anthropic: { maxRetries: 1 } } }),
			ordinary,
		);

		expect(sent.count).toBe(2);
	});

	it("never waits past the per-attempt ceiling a turn's backoff stops at", async () => {
		const sent = alwaysFailing(TRANSIENT);

		await runAutoCompaction(createSession(ordinary), ordinary);

		expect(sent.count).toBe(1 + GLOBAL_RETRY.maxRetries);
		expect(waits).toHaveLength(GLOBAL_RETRY.maxRetries);
		expect(waits.filter(wait => wait > RETRY_BACKOFF_MAX_DELAY_MS)).toEqual([]);
		// The ladder still climbs: the last wait reached the ceiling's own band.
		expect(Math.max(...waits)).toBeGreaterThan(RETRY_BACKOFF_MAX_DELAY_MS / 2);
	});

	it("does not sleep a wait the provider stated past retry.maxDelayMs", async () => {
		expect(extractRetryHint(undefined, STATED_LONG_WAIT)).toBeGreaterThan(GLOBAL_RETRY.maxDelayMs);
		const sent = alwaysFailing(STATED_LONG_WAIT);

		const ends = await runAutoCompaction(createSession(ordinary), ordinary);

		expect(sent.count).toBe(1);
		expect(waits).toEqual([]);
		expect(ends[0]?.errorMessage).toContain("try again in 120 min");
	});

	for (const message of USAGE_LIMITS) {
		it(`sends a spent allowance once when no sibling account can serve it: "${message.slice(22, 82)}"`, async () => {
			expect(AIError.is(AIError.classify(new Error(message), ordinary.api), AIError.Flag.UsageLimit)).toBe(true);
			const sent = alwaysFailing(message);

			const ends = await runAutoCompaction(createSession(ordinary), ordinary);

			expect(sent.count).toBe(1);
			expect(waits).toEqual([]);
			expect(ends).toHaveLength(1);
			expect(ends[0]?.result).toBeUndefined();
			expect(ends[0]?.errorMessage).toContain(message.slice("Summarization failed: ".length));
		});
	}

	it("re-sends a spent allowance at once when a sibling account took over", async () => {
		vi.spyOn(authStorage, "markUsageLimitReached").mockResolvedValueOnce({ switched: true });
		const sent = summaryFailing(USAGE_LIMITS[0]);

		const ends = await runAutoCompaction(createSession(ordinary), ordinary);

		expect(sent.count).toBe(2);
		expect(waits.filter(wait => wait > 0)).toEqual([]);
		expect(ends[0]?.result?.summary).toBe("summary");
	});

	it("sends a model the account's plan does not serve once", async () => {
		expect(AIError.is(AIError.classify(new Error(NOT_IN_PLAN), ordinary.api), AIError.Flag.ModelNotInPlan)).toBe(
			true,
		);
		const sent = alwaysFailing(NOT_IN_PLAN);

		const ends = await runAutoCompaction(createSession(ordinary), ordinary);

		expect(sent.count).toBe(1);
		expect(waits).toEqual([]);
		expect(ends[0]?.errorMessage).toContain("Named models unavailable");
	});
});
