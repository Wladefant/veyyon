/**
 * Shared test utilities for coding-agent tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake } from "@veyyon/utils";
import { e2eApiKey } from "../../../ai/test/oauth";

export { e2eApiKey };

/**
 * Options for creating a test session.
 */
export interface TestSessionOptions {
	/** Use in-memory session (no file persistence) */
	inMemory?: boolean;
	/** Custom system prompt */
	systemPrompt?: string | string[];
	/** Custom settings overrides */
	settingsOverrides?: Record<string, unknown>;
}

/**
 * Resources returned by createTestSession that need cleanup.
 */
export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => Promise<void>;
}

/**
 * Create an AgentSession for testing with proper setup and cleanup.
 * Use this for e2e tests that need real LLM calls.
 */
export async function createTestSession(options: TestSessionOptions = {}): Promise<TestSessionContext> {
	const tempDir = path.join(os.tmpdir(), `veyyon-test-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const toolSession: ToolSession = {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(options.settingsOverrides),
	};
	const tools = await createTools(toolSession);

	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
		initialState: {
			model,
			systemPrompt: Array.isArray(options.systemPrompt)
				? options.systemPrompt
				: [options.systemPrompt ?? "You are a helpful assistant. Be extremely concise."],
			tools,
		},
	});

	const sessionManager = options.inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
	const settings = Settings.isolated(options.settingsOverrides);

	const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});

	// Must subscribe to enable session persistence
	session.subscribe(() => {});

	const cleanup = async () => {
		await session.dispose();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}
