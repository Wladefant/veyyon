import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

export interface TestAgentSessionOptions {
	/** System prompt of the agent. Defaults to `["Test"]`. */
	systemPrompt?: string[];
	/** Overrides applied to the session's isolated settings. */
	settings?: Partial<Record<SettingPath, unknown>>;
}

export interface TestAgentSession {
	authStorage: AuthStorage;
	session: AgentSession;
}

/**
 * A real `AgentSession` on the registry's `anthropic/claude-sonnet-4-5`, with no tools and no messages, an auth store at
 * `<dir>/testauth.db`, a session file under `dir` and isolated settings. The caller closes `authStorage` and disposes
 * `session`.
 */
export async function createTestAgentSession(
	dir: string,
	options: TestAgentSessionOptions = {},
): Promise<TestAgentSession> {
	const authStorage = await AuthStorage.create(path.join(dir, "testauth.db"));
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: options.systemPrompt ?? ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(dir, dir),
			settings: Settings.isolated(options.settings),
			modelRegistry,
		});
		return { authStorage, session };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
