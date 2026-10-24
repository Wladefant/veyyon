import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModels } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * WHY. A provider that states its rate-limit window in a sentence was retried as if it had stated
 * none. The shared retry-hint reader understood `reset after 1h2m3s` and no other member of that
 * family, so "Your limit will reset in 17 minutes", "Resets in 20m45s" and "Resets in 1hr 39min"
 * reached the session retry as no window at all. The retry backed off for seconds, asked again
 * inside the window the provider had named, failed again, and spent its budget that way; a window
 * longer than `retry.maxDelayMs` was retried instead of failing at once.
 *
 * The class closed here is "a reset window stated in prose that the session retry does not read".
 * Every phrasing below is driven through a real `AgentSession` at a window under the cap, where the
 * retry must wait that window and then succeed, and at a window over it, where the turn must fail
 * with no retry.
 *
 * Not caught: a phrasing absent from this sweep (the shared reader is pinned phrase by phrase in
 * `packages/utils/test/fetch-retry.test.ts`), and a stated window that is wrong, which the session
 * believes.
 */

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MINUTE_MS = 60_000;
const MAX_DELAY_MS = 5 * MINUTE_MS;
const UNDER_CAP_MS = 2 * MINUTE_MS;
const OVER_CAP_MS = 17 * MINUTE_MS;

interface Phrasing {
	readonly name: string;
	readonly render: (windowMs: number) => string;
}

const PHRASINGS: readonly Phrasing[] = [
	{
		name: "a window in minutes with the reset clock beside it",
		render: ms =>
			`Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in ${ms / MINUTE_MS} minutes (at 12:00 UTC). (trace ID: 00000000000000000000000000000000)`,
	},
	{
		name: "a window in seconds",
		render: ms =>
			`Devin stream error permission_denied: Reached overall message rate limit. Please try again later. Your limit will reset in ${ms / 1000} seconds.`,
	},
	{
		name: "a compact minutes-and-seconds window",
		render: ms =>
			`Cloud Code Assist API error (429): Individual quota reached. Resets in ${Math.floor(ms / MINUTE_MS)}m${(ms % MINUTE_MS) / 1000}s.`,
	},
	{
		name: "an hours-and-minutes window in abbreviated words",
		render: ms =>
			`429 5-hour usage limit reached. Resets in ${Math.floor(ms / (60 * MINUTE_MS))}hr ${(ms % (60 * MINUTE_MS)) / MINUTE_MS}min.`,
	},
];

function lastAssistant(session: AgentSession | undefined): AssistantMessage {
	const message = session?.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message;
}

describe("a reset window a provider states in words", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-reset-window-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	async function run(errorMessage: string): Promise<{
		calls: number;
		starts: AutoRetryStartEvent[];
		ends: AutoRetryEndEvent[];
	}> {
		const model = getBundledModels("devin")[0];
		if (!model) throw new Error("Expected a bundled Devin model");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["answered after the window"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": MAX_DELAY_MS,
			"retry.maxRetries": 3,
			"retry.modelFallback": false,
		});
		settings.setDefaultModel(`${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const starts: AutoRetryStartEvent[] = [];
		const ends: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts.push(event);
			if (event.type === "auto_retry_end") ends.push(event);
		});
		await session.prompt("hello");
		await session.waitForIdle();
		return { calls: mock.calls.length, starts, ends };
	}

	for (const phrasing of PHRASINGS) {
		it(`waits out ${phrasing.name} and then succeeds`, async () => {
			const { calls, starts, ends } = await run(phrasing.render(UNDER_CAP_MS));
			expect(starts.map(event => event.delayMs)).toEqual([UNDER_CAP_MS]);
			expect(calls).toBe(2);
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
		});

		it(`fails at once on ${phrasing.name} longer than retry.maxDelayMs`, async () => {
			const { calls, starts, ends } = await run(phrasing.render(OVER_CAP_MS));
			expect(starts).toEqual([]);
			expect(calls).toBe(1);
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({ success: false });
			expect(ends[0]?.finalError).toContain("Provider requested a 17m wait, longer than retry.maxDelayMs (5m)");
			expect(lastAssistant(session).stopReason).toBe("error");
		});
	}
});
