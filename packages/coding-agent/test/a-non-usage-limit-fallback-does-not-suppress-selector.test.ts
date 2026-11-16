import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

describe("retry fallback selector suppression", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-non-usage-limit-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.set("anthropic", [{ type: "api_key", key: "anthropic-key-1" }]);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
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

	it("does not suppress the failing selector on non-UsageLimit fallback errors", async () => {
		const primary = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = requireBundledModel("anthropic", "claude-haiku-4-5");
		const primarySelector = `${primary.provider}/${primary.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;

		const mock = createMockModel();
		const requestedModels: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				requestedModels.push(`${requested.provider}/${requested.id}`);
				mock.push(
					requested.id === primary.id
						? { throw: "HTTP 502 Bad Gateway" }
						: { content: ["recovered on fallback"] },
				);
				return mock.stream(requested, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [primarySelector]: [fallbackSelector] },
		});
		settings.setDefaultModel(primarySelector);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger transient 502 fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([primarySelector, fallbackSelector]);
		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(false);
	});

	it("suppresses the failing selector on UsageLimit fallback errors", async () => {
		const primary = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = requireBundledModel("anthropic", "claude-haiku-4-5");
		const primarySelector = `${primary.provider}/${primary.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;

		const mock = createMockModel();
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				mock.push(
					requested.id === primary.id
						? { throw: "429 usage_limit_reached" }
						: { content: ["recovered on fallback"] },
				);
				return mock.stream(requested, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [primarySelector]: [fallbackSelector] },
		});
		settings.setDefaultModel(primarySelector);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger 429 fallback");
		await session.waitForIdle();

		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(true);
	});

	it("keeps the active session on fallback across prompts on persistent 502 while a sibling session can still use primary", async () => {
		const primary = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = requireBundledModel("anthropic", "claude-haiku-4-5");
		const primarySelector = `${primary.provider}/${primary.id}`;
		const fallbackSelector = `${fallback.provider}/${fallback.id}`;

		const mock = createMockModel();
		const requestedModels: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				requestedModels.push(`${requested.provider}/${requested.id}`);
				mock.push(
					requested.id === primary.id
						? { throw: "HTTP 502 Bad Gateway" }
						: { content: ["recovered on fallback"] },
				);
				return mock.stream(requested, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [primarySelector]: [fallbackSelector] },
		});
		settings.setDefaultModel(primarySelector);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Prompt 1 hits 502 and falls back");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primarySelector, fallbackSelector]);
		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(false);

		requestedModels.length = 0;
		await session.prompt("Prompt 2 stays on fallback during session cooldown");
		await session.waitForIdle();
		expect(requestedModels).toEqual([fallbackSelector]);

		const siblingRequestedModels: string[] = [];
		const siblingMock = createMockModel();
		let siblingAgent!: Agent;
		siblingAgent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, siblingAgent.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				siblingRequestedModels.push(`${requested.provider}/${requested.id}`);
				siblingMock.push({ content: ["primary works in sibling"] });
				return siblingMock.stream(requested, context, options);
			},
		});
		const siblingSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": true,
			"retry.fallbackChains": { [primarySelector]: [fallbackSelector] },
		});
		siblingSettings.setDefaultModel(primarySelector);
		const siblingSession = new AgentSession({
			agent: siblingAgent,
			sessionManager: SessionManager.inMemory(),
			settings: siblingSettings,
			modelRegistry,
		});
		try {
			await siblingSession.prompt("Sibling uses primary");
			await siblingSession.waitForIdle();
			expect(siblingRequestedModels).toEqual([primarySelector]);
		} finally {
			await siblingSession.dispose();
		}
	});

	it("deduplicates session cooldown across thinking-level aliases and restores after cooldown expiry", async () => {
		const primary = requireBundledModel("anthropic", "claude-opus-4-5");
		const middle = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const last = requireBundledModel("anthropic", "claude-haiku-4-5");
		const primarySelector = `${primary.provider}/${primary.id}`;
		const middleSelector = `${middle.provider}/${middle.id}`;
		const lastSelector = `${last.provider}/${last.id}`;

		let now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		let failPrimaryAndMiddle = true;
		const mock = createMockModel();
		const requestedModels: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				const selector = `${requested.provider}/${requested.id}`;
				requestedModels.push(selector);
				mock.push(
					failPrimaryAndMiddle && (requested.id === primary.id || requested.id === middle.id)
						? { throw: "HTTP 502 Bad Gateway; retry-after: 1s" }
						: { content: ["recovered"] },
				);
				return mock.stream(requested, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 0,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[primarySelector]: [`${middleSelector}:high`, `${middleSelector}:low`, lastSelector],
			},
		});
		settings.setDefaultModel(primarySelector);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Skip B:low after B:high fails");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primarySelector, middleSelector, lastSelector]);

		// Advance past the 1s cooldown: primary is restored and succeeds.
		requestedModels.length = 0;
		failPrimaryAndMiddle = false;
		now += 5_000;
		await session.prompt("Primary restored after cooldown expiry");
		await session.waitForIdle();
		expect(requestedModels).toEqual([primarySelector]);
	});
});
