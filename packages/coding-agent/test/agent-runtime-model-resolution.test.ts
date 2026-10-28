import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { createMockSession, yieldSuccessEvent } from "./helpers/agent-session";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/**
 * A child that reports one retry fallback and then yields.
 *
 * The fallback event is the subject: `result.resolvedModel` is set from it, which is how the parent
 * learns which model actually served the child after the primary failed at runtime. The yield is
 * only there so the run finishes as a completion rather than as three missing-yield reminders.
 */
function createYieldingSession(): AgentSession {
	return createMockSession(
		({ emit }) => {
			emit({
				type: "retry_fallback_applied",
				from: "primary/bad-runtime-model",
				to: "fallback/working-model",
				role: "agent:issue-2750",
			} as unknown as AgentSessionEvent);
			emit(yieldSuccessEvent(undefined));
		},
		// No `read`: this child's only tool is the one it answers with.
		{ activeToolNames: ["yield"] },
	);
}

/**
 * A throwaway artifacts directory for the agent transcript.
 *
 * Required, not cosmetic. With no `artifactsDir`, `runSubprocess` routes the subtask transcript to
 * `getSessionsDir()`, which on a developer machine resolves inside the REAL `~/.veyyon` profile; the
 * real-data tripwire then refuses the open and `runSubprocess` fails before it ever creates the child
 * session, so every assertion about what the child received reads `undefined` for a reason that has nothing
 * to do with model resolution. That is exactly how these three tests went red.
 */
const artifactDirs: string[] = [];
function isolatedArtifactsDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "veyyon-issue-2750-"));
	artifactDirs.push(dir);
	return dir;
}

describe("agent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("passes ordered agent candidates as a child retry fallback chain", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
				setToolNotifier: () => {},
			} as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["global/inherited-model"],
			},
		});
		settings.setDefaultModel("primary/bad-runtime-model");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [primary, fallback],
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			artifactsDir: isolatedArtifactsDir(),
		});

		// The chain is keyed by the primary's own selector and listed first, ahead of the inherited chains.
		const chainKeys = Object.keys(childFallbackChains ?? {});
		expect(chainKeys[0]).toBe("primary/bad-runtime-model");
		expect(childFallbackChains?.["primary/bad-runtime-model"]).toEqual(["fallback/working-model"]);
		expect(childFallbackChains?.default).toEqual(["global/inherited-model"]);
		expect(result.modelOverride).toEqual(["primary/bad-runtime-model", "fallback/working-model"]);
		expect(result.resolvedModel).toBe("fallback/working-model");
	});

	it.each([{ tail: [] }, { tail: ["missing/unavailable-model"] }])("keeps the child boundary when no later candidate resolves (%j)", async ({ tail }) => {
		const primary = model("primary", "only-model");
		let childFallbackKey: string | undefined;
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackKey = options.modelPatternFallbackKey;
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
				setToolNotifier: () => {},
			} as never;
		});
		const settings = Settings.isolated({
			"retry.modelFallback": true,
			"retry.fallbackChains": { "primary/*": ["global/inherited-model"] },
		});
		await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "closed-child-chain",
			modelOverride: ["primary/only-model", ...tail],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [primary],
				getAvailable: () => [primary],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			artifactsDir: isolatedArtifactsDir(),
		});
		expect(childFallbackKey).toBe("primary/only-model");
		expect(childFallbackChains?.["primary/only-model"]).toEqual([]);
		expect(settings.get("retry.fallbackChains")).toEqual({ "primary/*": ["global/inherited-model"] });
	});

	it("preserves upstream routing selectors in the child retry fallback chain", async () => {
		const routedModel = model("openrouter", "z-ai/glm-4.7");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
				setToolNotifier: () => {},
			} as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750-routed",
			modelOverride: ["openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@fireworks"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [routedModel],
				getAvailable: () => [routedModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			artifactsDir: isolatedArtifactsDir(),
		});

		expect(childFallbackChains?.["openrouter/z-ai/glm-4.7@cerebras"]).toEqual(["openrouter/z-ai/glm-4.7@fireworks"]);
	});

	it("fails closed when every explicit agent model selector is absent from the catalog", async () => {
		const defaultModel = model("zai", "glm-5.2");
		const createSessionSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => ({
			session: createYieldingSession(),
			extensionsResult: {},
			setToolUIContext: () => {},
			setToolNotifier: () => {},
		}) as never);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id: "missing-chain",
			modelOverride: ["openai-codex/gpt-5.5:auto"],
			parentActiveModelPattern: "openai-codex/gpt-5.5",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAll: () => [defaultModel],
				getAvailable: () => [defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			artifactsDir: isolatedArtifactsDir(),
		});

		expect(result.error).toContain("openai-codex/gpt-5.5:auto: not found in the model catalog");
		expect(createSessionSpy).not.toHaveBeenCalled();
	});
});
