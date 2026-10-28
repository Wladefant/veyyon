/**
 * WHY: a session on a websocket Codex model opens its socket at startup, and the first turn rides that
 * socket. The upgrade is the only request whose `x-codex-routing-hint` the backend reads for the
 * connection, so the prewarm has to state the tier the session's turns send. `createAgentSession`
 * handed the prewarm no tier, so a session configured for priority opened its socket as
 * `model=<model>` and every turn on it went out under a hint that omitted the tier its body set.
 *
 * Class closed: the startup prewarm states the tier the session resolves for its model, from the
 * configured `tier.openai` setting, for every OpenAI tier value and for none. The suite drives the real
 * `createAgentSession` and reads the upgrade headers of the socket it opens.
 *
 * Not caught: a tier changed after startup (`/fast`), which reaches the next socket only when the
 * session opens one; how the backend routes on the hint is not observable offline.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

const ROUTING_HINT = "x-codex-routing-hint";
const originalWebSocket = global.WebSocket;
const open: Array<{ session: AgentSession; authStorage: AuthStorage; tempDir: TempDir }> = [];

afterEach(async () => {
	for (const entry of open.splice(0)) {
		await entry.session.dispose();
		entry.authStorage.close();
		entry.tempDir.removeSync();
	}
	global.WebSocket = originalWebSocket;
});

/** A Codex access token naming an account, so the prewarm can key its socket. */
function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

/** Records the upgrade headers of every socket opened; no socket ever opens, so nothing is sent. */
function recordUpgrades(): Array<Record<string, string>> {
	const upgrades: Array<Record<string, string>> = [];
	class RecordingWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = RecordingWebSocket.CONNECTING;
		binaryType = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;

		constructor(_url: string, options?: { headers?: Record<string, string> }) {
			upgrades.push({ ...(options?.headers ?? {}) });
		}

		send(): void {}

		close(): void {
			this.readyState = RecordingWebSocket.CLOSED;
		}
	}
	global.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;
	return upgrades;
}

async function startCodexSession(tier: string): Promise<Array<Record<string, string>>> {
	const bundled = requireBundledModel("openai-codex", "gpt-5.5");
	const model: Model = { ...bundled, baseUrl: "https://codex.example/backend-api", preferWebsockets: true };
	const upgrades = recordUpgrades();
	const tempDir = TempDir.createSync("veyyon-codex-prewarm-tier-");
	const agentDir = tempDir.join("profile");
	const cwd = tempDir.join("project");
	for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorage.setRuntimeApiKey(model.provider, codexToken());
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "secrets.enabled": false, "compaction.enabled": false, "tier.openai": tier }),
		model,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
	});
	open.push({ session, authStorage, tempDir });
	// The prewarm runs in the background; bound the wait so a prewarm that never opens fails here.
	const deadline = Date.now() + 5_000;
	while (upgrades.length === 0 && Date.now() < deadline) await sleep(10);
	return upgrades;
}

describe("a Codex session's startup prewarm", () => {
	it.each(["priority", "flex", "scale"])("states the configured %s tier in its routing hint", async tier => {
		const upgrades = await startCodexSession(tier);
		expect(upgrades).toHaveLength(1);
		expect(upgrades[0]?.[ROUTING_HINT]).toBe(`model=gpt-5.5;tier=${tier}`);
	});

	it.each(["none", "auto", "default"])("states the model alone when the configured tier is %s", async tier => {
		const upgrades = await startCodexSession(tier);
		expect(upgrades).toHaveLength(1);
		expect(upgrades[0]?.[ROUTING_HINT]).toBe("model=gpt-5.5");
	});
});
