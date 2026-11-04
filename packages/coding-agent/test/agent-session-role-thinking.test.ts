import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { ANY_MODEL_EFFORT_KEY } from "@veyyon/coding-agent/config/effort-resolver";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AUTO_THINKING, clampAutoThinkingEffort, resolveProvisionalAutoLevel } from "@veyyon/coding-agent/thinking";
import * as autoThinkingClassifier from "@veyyon/coding-agent/thinking/auto-classifier";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession model effort behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		defaultModel?: string;
		helpers?: Record<string, { model?: string; thinkingLevel?: string }>;
		initialThinkingSource?: "selector" | "session";
		initialConfiguredThinkingLevel?: Effort | "off";
		runtimeApiKeys?: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const runtimeApiKeys = options.runtimeApiKeys ?? {};
		for (const provider in runtimeApiKeys) {
			authStorage.setRuntimeApiKey(provider, runtimeApiKeys[provider]);
		}
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		sessionSettings = Settings.isolated(options.helpers ? { "agent.helpers": options.helpers } : {});
		if (options.defaultModel) sessionSettings.setDefaultModel(options.defaultModel);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: options.initialConfiguredThinkingLevel ?? options.initialThinkingLevel,
			thinkingSource: options.initialThinkingSource,
		});
	}

	/**
	 * A selector's effort applies until the user chooses a session override.
	 * The override survives model switches, and clearing it reveals the active
	 * selector pin immediately instead of waiting for another model switch.
	 */
	it("keeps session effort above selector pins and restores the pin when cleared", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const pinnedModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({ initialModelId: defaultModel.id, initialThinkingLevel: Effort.High });

		await session.setModel(pinnedModel, "default", { thinkingLevel: "off" });
		expect(session.model?.id).toBe(pinnedModel.id);
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		await session.setModel(defaultModel);
		expect(session.thinkingLevel).toBe(Effort.High);

		await session.setModel(pinnedModel, "default", { thinkingLevel: "off" });
		expect(session.thinkingLevel).toBe(Effort.High);

		session.setThinkingLevel(undefined);
		expect(session.thinkingLevel).toBe("off");
	});

	/**
	 * A session that starts from a selector suffix must remember that selector
	 * beneath a later temporary override. Default should reveal it immediately.
	 */
	it("restores an initial selector pin after clearing a later session override", async () => {
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		await createSession({
			initialModelId: nextModel.id,
			initialThinkingLevel: Effort.Low,
			initialThinkingSource: "selector",
			initialConfiguredThinkingLevel: "off",
		});

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
		session.setThinkingLevel(undefined);

		expect(session.sessionThinkingOverride).toBeUndefined();
		expect(session.thinkingLevel).toBe("off");
	});

	it("activates auto thinking when a model switch carries an explicit :auto selector", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const autoModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({ initialModelId: defaultModel.id, initialThinkingLevel: Effort.High });

		await session.setModel(autoModel, "default", { thinkingLevel: AUTO_THINKING });
		expect(session.model?.id).toBe(autoModel.id);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("preserves current thinking when switching to a model with no selector effort", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const pinnedModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({ initialModelId: defaultModel.id, initialThinkingLevel: Effort.Low });

		await session.setModel(pinnedModel, "default", { thinkingLevel: Effort.High });
		expect(session.thinkingLevel).toBe(Effort.High);

		// `medium` is supported on both ladders (4-6 dropped `minimal`), so the
		// selection survives the switch unclamped.
		session.setThinkingLevel(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		await session.setModel(defaultModel);
		expect(session.model?.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("preserves the default model's explicit effort when replacing an unresolved default model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			defaultModel: "anthropic/nonexistent-model:off",
		});

		await session.setModel(nextModel, "default", { persist: true });

		expect(sessionSettings.get("defaultModel")).toBe(`${nextModel.provider}/${nextModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-xhigh.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-xhigh.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("clamps max selections down to the ladder ceiling on models without a max tier", async () => {
		// Budget-mode sonnet-4-5 tops out at xhigh; a max request must clamp down.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-max-clamp.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-max-clamp.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.getAvailableThinkingLevels()).not.toContain("max");
	});

	it("cycles through off and auto before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-cycle-thinking.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-cycle-thinking.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(agent.state.disableReasoning).toBe(true);
		expect(session.cycleThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(agent.state.disableReasoning).toBe(false);
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("cycles through max as the final tier on a max-capable model", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-cycle-max.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-cycle-max.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		const available = session.getAvailableThinkingLevels();
		expect(available.at(-1)).toBe(Effort.Max);

		session.setThinkingLevel(Effort.XHigh);
		expect(session.cycleThinkingLevel()).toBe(Effort.Max);
		expect(session.thinkingLevel).toBe(Effort.Max);
		// max is the last tier: the wheel wraps back to off.
		expect(session.cycleThinkingLevel()).toBe("off");
	});

	it("keeps auto configured while applying the classifier result as the effective level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			defaultModel: `${model.provider}/${model.id}`,
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		await session.prompt("Implement a focused parser fix");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("keeps auto active on resume (pending until the next turn reclassifies)", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-auto-resume.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-auto-resume.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		await session.prompt("Implement a focused parser fix");

		expect(session.isAutoThinking).toBe(true);
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		// Resumes in auto and pending — not frozen to the last resolved level, and
		// not pre-seeded; the next user turn reclassifies.
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("keeps a manual concrete pin (not auto) on resume even when the global default is auto", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-manual-resume.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-manual-resume.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// User pins a concrete level mid-session; it must survive resume as-is and
		// must not be reinterpreted as `auto` just because the global default is auto.
		session.setThinkingLevel(Effort.Low);
		expect(session.isAutoThinking).toBe(false);
		await session.prompt("Pinned concrete turn");
		expect(classifierSpy).not.toHaveBeenCalled();
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("persists a concrete pin that matches the auto-resolved effort so resume stays concrete", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-pin-eq.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-pin-eq.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		// Auto resolves to medium.
		await session.prompt("Implement a focused parser fix");
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);

		// User then pins the *same* effort: selector changes auto -> medium even though
		// the effort is unchanged, so it must persist as a concrete pin (entry + the
		// saved default), not silently stay `configured: "auto"`.
		//
		// The pin has to land in `defaultEffort`'s any-model row, because that is the
		// setting the resolver reads. Writing the retired `defaultThinkingLevel` enum
		// instead looked identical here (this profile has no `defaultEffort` object,
		// the one case where the legacy key is still consulted) and was discarded on
		// the next read for every profile that had one.
		session.setThinkingLevel(Effort.Medium, true);
		expect(session.isAutoThinking).toBe(false);
		expect(sessionSettings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.Medium });
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("persists onto the row that governs the selected model, not one it shadows", async () => {
		// The session is the only thing that knows which model the pin was made on.
		// Persisting `*` while the selected model has its own row writes a value
		// `resolveEffort` never reaches, so the pin would be as invisible as the
		// retired-key write it replaced -- silently reverting on the next resume.
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const selector = `${model.provider}/${model.id}`;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-pin-row.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-pin-row.yml"));
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultEffort", { [selector]: Effort.Low, [ANY_MODEL_EFFORT_KEY]: Effort.Minimal });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});

		session.setThinkingLevel(Effort.High, true);

		expect(sessionSettings.get("defaultEffort")).toEqual({
			[selector]: Effort.High,
			[ANY_MODEL_EFFORT_KEY]: Effort.Minimal,
		});
	});

	it("falls back to a concrete auto level when classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			defaultModel: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		const fallback = resolveProvisionalAutoLevel(model);
		await session.prompt("Investigate a regression");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(fallback);
		expect(session.autoResolvedThinkingLevel()).toBe(fallback);
		expect(session.agent.state.thinkingLevel).toBe(fallback);
	});

	it("skips classification for synthetic turns", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			defaultModel: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		session.setThinkingLevel(AUTO_THINKING);
		const provisional = resolveProvisionalAutoLevel(model);
		await session.prompt("Synthetic maintenance turn", { synthetic: true });

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("maps ultrathink prompts to the model's highest supported level, clamped below max", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			defaultModel: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		// sonnet-4-5 has no max tier, so the ultrathink jump clamps to xhigh.
		const expected = clampAutoThinkingEffort(model, Effort.Max);
		expect(expected).toBe(Effort.XHigh);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(expected);
		expect(session.autoResolvedThinkingLevel()).toBe(expected);
	});

	it("resolves ultrathink to max on max-capable models", async () => {
		const model = getAnthropicModelOrThrow("claude-opus-4-7");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			defaultModel: `${model.provider}/${model.id}`,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(Effort.Max);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Max);
	});

	it("keeps auto effectively off for non-reasoning models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-reasoning-auto.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-reasoning-auto.yml"));
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		expect(session.isAutoThinking).toBe(true);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();

		await session.prompt("Implement a tiny change");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("applies a helper selector's effort to a temporary pick of the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getBundledModel("google-antigravity", "gemini-3.5-flash");
		if (!temporaryModel) throw new Error("Expected google-antigravity model gemini-3.5-flash to exist");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			helpers: { plan: { model: `${temporaryModel.provider}/${temporaryModel.id}:high` } },
			runtimeApiKeys: {
				[temporaryModel.provider]: "test-key",
			},
		});

		const helperResolved = session.resolveHelperModel("plan");
		expect(helperResolved?.model.id).toBe(temporaryModel.id);
		expect(helperResolved?.thinkingLevel).toBe(Effort.High);

		const selectorThinkingLevel = session.resolveTemporaryModelThinkingLevel(temporaryModel);
		await session.setModelTemporary(temporaryModel, selectorThinkingLevel);

		expect(session.model?.provider).toBe(temporaryModel.provider);
		expect(session.model?.id).toBe(temporaryModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);
	});
});
