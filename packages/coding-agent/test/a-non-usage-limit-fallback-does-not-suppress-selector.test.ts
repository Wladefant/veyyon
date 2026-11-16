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
});
