/**
 * WHY: the saved switch, the session-only switch, the scoped Ctrl+P cycle and the available-model
 * cycle each repeated the steps of a model switch inline, four copies that a new step had to reach
 * one at a time. They now share one switch in `ModelSelection`.
 *
 * THE CLASS. A switch path that skips a step every switch takes: the agent runs the new model, the
 * session file records it under the path's role, a suppressed selector for it is lifted, model usage
 * puts it first, a thinking level the path pins is applied, and a prompt that names the model is
 * rebuilt for it. The cases are swept against the public methods of `ModelSelection`, so a new switch
 * method fails here until it has a case.
 *
 * WHAT IT DOES NOT CATCH. Dropping an active retry fallback is not observable from the session and is
 * not checked here. The order of the steps is not checked.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { formatModelStringWithRouting } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SessionScopedModel } from "@veyyon/coding-agent/session/agent-session-types";
import { ModelSelection } from "@veyyon/coding-agent/session/runtime/model-selection";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** One way a caller switches models, and what it records. */
interface SwitchPath {
	name: string;
	/** The `ModelSelection` method the path runs. */
	method: string;
	/** The role the session file records the change under; undefined is the default role. */
	role: string | undefined;
	/**
	 * The thinking level the path pins, checked after the switch; undefined pins none. Medium, because
	 * an unpinned switch to the target resolves to High, so a dropped pin shows.
	 */
	pinned: Effort | undefined;
	/** Scoped models the session is created with. */
	scoped(start: Model, target: Model): SessionScopedModel[];
	switchTo(session: AgentSession, target: Model): Promise<unknown>;
}

const NO_SCOPE = (): SessionScopedModel[] => [];

const SWITCHES = [
	{
		name: "a saved switch",
		method: "setModel",
		role: "default",
		pinned: Effort.Medium,
		scoped: NO_SCOPE,
		switchTo: (session, target) => session.setModel(target, "default", { thinkingLevel: Effort.Medium }),
	},
	{
		name: "a saved switch to a role slot",
		method: "setModel",
		role: "smol",
		pinned: undefined,
		scoped: NO_SCOPE,
		switchTo: (session, target) => session.setModel(target, "smol"),
	},
	{
		name: "a session-only switch",
		method: "setModelTemporary",
		role: "temporary",
		pinned: Effort.Medium,
		scoped: NO_SCOPE,
		switchTo: (session, target) => session.setModelTemporary(target, Effort.Medium),
	},
	{
		name: "an ephemeral session-only switch",
		method: "setModelTemporary",
		role: EPHEMERAL_MODEL_CHANGE_ROLE,
		pinned: undefined,
		scoped: NO_SCOPE,
		switchTo: (session, target) => session.setModelTemporary(target, undefined, { ephemeral: true }),
	},
	{
		name: "the scoped cycle",
		method: "cycle",
		role: undefined,
		pinned: Effort.Medium,
		scoped: (start, target) => [
			{ model: start },
			{ model: target, thinkingLevel: Effort.Medium, explicitThinkingLevel: true },
		],
		switchTo: session => session.cycleModel("forward"),
	},
	{
		name: "the available-model cycle",
		method: "cycle",
		role: undefined,
		pinned: undefined,
		scoped: NO_SCOPE,
		switchTo: session => session.cycleModel("forward"),
	},
] as SwitchPath[];

/** Public `ModelSelection` methods that switch no model. */
const NOT_SWITCHES = ["available"];

describe("every model switch takes every switch step", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-model-switch-steps-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		AgentStorage.resetInstance();
		authStorage.close();
		tempDir.removeSync();
	});

	/** A reasoning model and the available model before it, so a forward cycle from the first lands on it. */
	function startAndTarget(): [Model, Model] {
		const available = registry.getAvailable();
		const index = available.findIndex((model, i) => i > 0 && model.reasoning === true);
		if (index < 1) throw new Error("expected a reasoning model after another available model");
		return [available[index - 1], available[index]];
	}

	it("has a case for every public switch method", () => {
		const methods = Object.getOwnPropertyNames(ModelSelection.prototype).filter(
			name =>
				name !== "constructor" &&
				typeof Object.getOwnPropertyDescriptor(ModelSelection.prototype, name)?.value === "function",
		);
		expect(methods.filter(name => !SWITCHES.some(route => route.method === name)).sort()).toEqual(NOT_SWITCHES);
		expect([...new Set(SWITCHES.map(route => route.method))].sort()).toEqual(
			methods.filter(name => !NOT_SWITCHES.includes(name)).sort(),
		);
	});

	it.each(SWITCHES)("$name takes every step of a switch", async route => {
		const [start, target] = startAndTarget();
		// Model usage lands in the agent dir's storage, ordered at one-second resolution, so a shared
		// agent dir ties with another file's usage written the same second.
		const agentDir = tempDir.path();
		const settings = await Settings.loadIsolated({
			agentDir,
			cwd: agentDir,
			inMemory: true,
			overrides: { "compaction.enabled": false, includeModelInPrompt: true },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: start, systemPrompt: ["initial"], tools: [], messages: [], thinkingLevel: Effort.Low },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			toolRegistry: new Map(),
			thinkingLevel: Effort.Low,
			thinkingSource: "model-default",
			scopedModels: route.scoped(start, target),
			rebuildSystemPrompt: async () => ({
				systemPrompt: [`model:${session?.model ? `${session.model.provider}/${session.model.id}` : ""}`],
			}),
		});
		const selector = `${target.provider}/${target.id}`;
		registry.suppressSelector(formatModelStringWithRouting(target), Date.now() + 60_000);

		await route.switchTo(session, target);

		expect(modelsAreEqual(session.model, target)).toBe(true);
		const changes = session.sessionManager.getEntries().filter(entry => entry.type === "model_change");
		expect(changes.at(-1)).toMatchObject({ model: selector, role: route.role });
		expect(registry.isSelectorSuppressed(formatModelStringWithRouting(target))).toBe(false);
		expect(AgentStorage.forAgentDir(settings.getAgentDir())?.getModelUsageOrder()[0]).toBe(selector);
		if (route.pinned !== undefined) expect(session.thinkingLevel).toBe(route.pinned);
		expect(session.agent.state.systemPrompt).toEqual([`model:${selector}`]);
	});
});
