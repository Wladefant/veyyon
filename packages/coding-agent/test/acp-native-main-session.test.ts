import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAcpSessionFactory } from "@veyyon/coding-agent/main";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { TempDir } from "@veyyon/utils";

it("an unpinned ACP Main uses the profile default and offers native task routing", async () => {
	const dir = TempDir.createSync("veyyon-acp-native-main-");
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	try {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected bundled Opus 5.5");
		await fs.writeFile(dir.join("config.yml"), "modelRoles:\n  default: anthropic/claude-opus-5-5:high\n");
		const settings = await Settings.loadIsolated({ agentDir: dir.path(), cwd: dir.path() });
		settings.set("async.enabled", false);
		settings.set("advisor.enabled", false);
		settings.set("agent.enabled", true);
		authStorage = await AuthStorage.create(dir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-token");
		const factory = createAcpSessionFactory({
			baseOptions: {
				agentDir: dir.path(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
			},
			settings,
			sessionDir: dir.join("sessions"),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, dir.join("models.yml")),
			parsedArgs: {},
			rawArgs: [],
			createSession: createAgentSession,
		});
		session = await factory(dir.path());
		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-opus-5-5");
		expect(session.agent.state.tools.map(tool => tool.name)).toContain("task");
		expect(session.settings.get("agent.enabled")).toBe(true);
	} finally {
		await session?.dispose();
		authStorage?.close();
		await dir.remove();
	}
}, 30_000);
