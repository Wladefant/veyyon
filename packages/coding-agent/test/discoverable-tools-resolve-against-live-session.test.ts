/**
 * Discoverable tools must resolve against the live session once created,
 * and must never throw if queried pre-session.
 *
 * Refs Wladefant/veyyon#99
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SearchToolBm25Tool } from "@veyyon/coding-agent/tools/search/search-tool-bm25";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";

useIsolatedAgentDir();

describe("discoverable tools resolution", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-discovery-session-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("returns empty array and does not throw before session is assigned", () => {
		let session: AgentSession | undefined;
		const toolSession = {
			cwd: registryDir,
			getDiscoverableTools: (filter?: { source?: "builtin" | "mcp" | "custom" }) => session?.getDiscoverableTools(filter) ?? [],
			isToolDiscoveryEnabled: () => session?.isToolDiscoveryEnabled() ?? false,
		} as unknown as ToolSession;

		// Prior to fix, calling getDiscoverableTools before session is assigned threw a TypeError.
		expect(() => toolSession.getDiscoverableTools?.()).not.toThrow();
		expect(toolSession.getDiscoverableTools?.()).toEqual([]);

		// Instantiating SearchToolBm25Tool and querying its description pre-session must not throw
		const searchTool = new SearchToolBm25Tool(toolSession);
		expect(() => searchTool.description).not.toThrow();
	});

	it(
		"drives real sdk session creation, calls discovery path, and gets a non-empty inventory",
		async () => {
			const settings = Settings.isolated({ "tools.discoveryMode": "all" });
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
				enableMCP: false,
			});
			sessions.push(session);

			// Discovery must be enabled
			expect(session.isToolDiscoveryEnabled()).toBe(true);

			// The inventory must be non-empty
			const discoverable = session.getDiscoverableTools();
			expect(discoverable.length).toBeGreaterThan(0);

			// search_tool_bm25 must be registered and active
			expect(session.getActiveToolNames()).toContain("search_tool_bm25");
			const searchTool = session.getToolByName("search_tool_bm25");
			expect(searchTool).toBeDefined();

			// The description must reflect the non-empty inventory (not 0 tools)
			const desc = searchTool!.description;
			expect(desc).toBeDefined();
			expect(desc.length).toBeGreaterThan(0);
			expect(desc).toContain(`Total discoverable tools available: ${discoverable.length}`);
		},
		30_000,
	);
});
