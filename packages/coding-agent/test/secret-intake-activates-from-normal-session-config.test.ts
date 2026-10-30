/**
 * WHY: A trusted profile config must activate the real session's secret_request tool before any
 * actor binds, while an unconfigured session must not expose it. This closes startup wiring gaps;
 * it does not test Bitwarden actor registration or any real vault operation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

interface Fixture {
	root: TempDir;
	authStorage: AuthStorage;
	sessions: AgentSession[];
}

let fixture: Fixture | undefined;

afterEach(async () => {
	if (!fixture) return;
	for (const session of fixture.sessions.reverse()) await session.dispose();
	fixture.authStorage.close();
	await fixture.root.remove();
	fixture = undefined;
});

async function startSession(configured: boolean): Promise<AgentSession> {
	const root = TempDir.createSync("secret-intake-normal-session-");
	const agentDir = path.resolve(root.join("profile-agent"));
	const cwd = path.resolve(root.join("project"));
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	if (configured) {
		await fs.writeFile(path.join(agentDir, "secret-intake.json"), JSON.stringify({
			version: 1,
			projects: [{
				projectRoot: cwd,
				organizationId: "synthetic-organization",
				collectionId: "synthetic-collection-id",
				vaultCollection: "synthetic-collection",
				operations: [{ tool: "bash", purpose: "synthetic-check", command: "true", envKey: "SYNTHETIC_SECRET" }],
			}],
		}));
	}
	const authStorage = await AuthStorage.create(root.join("auth.db"));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, root.join("models.yml")),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	fixture = { root, authStorage, sessions: [session] };
	return session;
}

describe("secret intake activation from normal session config", () => {
	it("loads the trusted profile config into the real session and refuses tool calls before actor binding", async () => {
		const session = await startSession(true);
		const tool = session.getToolByName("secret_request");
		expect(tool?.name).toBe("secret_request");
		const result = await tool!.execute("unbound-call", { action: "get", requestId: "synthetic-request-id" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Secret request refused" }]);
	});

	it("does not expose secret_request when the profile has no config", async () => {
		const session = await startSession(false);
		expect(session.getToolByName("secret_request")).toBeUndefined();
	});
});
