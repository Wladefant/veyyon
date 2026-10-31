/**
 * The per-family service tier a session holds is what a reload of its file restores, and what a
 * new session starts with.
 *
 * WHY. `setServiceTierFamily` and `newSession` write the live tier map as a `service_tier_change`
 * entry, and a reload rebuilds the map from the last such entry on the branch; with no entry it
 * falls back to the configured `tier.*` settings. No suite drove that round trip, so an entry
 * written empty, an entry not written on a clear, or a new session that started without one all
 * stayed green: `/fast` would turn itself off on `/resume`, a cleared tier would come back from the
 * settings default, and `/new` would drop the tier the previous session ran on.
 *
 * WHAT IT DOES NOT CATCH. The persisted bytes of an empty map: `{}` and `null` restore the same
 * way, so either spelling passes. Fireworks, whose tier is a setting and not part of the map.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";

describe("a service tier survives a reload and carries into a new session", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@service-tier-reload-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
		for (const dir of tempDirs.splice(0)) await dir.remove();
	});

	function persistedSession(settings: Settings): { session: AgentSession; sessionManager: SessionManager } {
		const tempDir = TempDir.createSync("@service-tier-reload-");
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);
		return { session, sessionManager };
	}

	/** A turn on the branch, so the file is written, then the reload under test. */
	async function reloadFromDisk(session: AgentSession, sessionManager: SessionManager): Promise<void> {
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		} as AssistantMessage;
		sessionManager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		sessionManager.appendMessage(reply);
		await sessionManager.flush();
		expect(session.sessionFile).toBeString();
		await session.reload();
	}

	it("restores a tier set during the session", async () => {
		const { session, sessionManager } = persistedSession(Settings.isolated());

		session.setServiceTierFamily("openai", "priority");
		await reloadFromDisk(session, sessionManager);

		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
	});

	it("keeps a cleared tier cleared rather than restoring the configured one", async () => {
		const { session, sessionManager } = persistedSession(Settings.isolated({ "tier.openai": "priority" }));

		session.setServiceTierFamily("openai", "priority");
		session.setServiceTierFamily("openai", undefined);
		await reloadFromDisk(session, sessionManager);

		expect(session.serviceTierByFamily).toEqual({});
	});

	it("starts a new session on the tier the previous one held", async () => {
		const { session, sessionManager } = persistedSession(Settings.isolated());

		session.setServiceTierFamily("anthropic", "priority");
		expect(await session.newSession()).toBe(true);
		await reloadFromDisk(session, sessionManager);

		expect(session.serviceTierByFamily).toEqual({ anthropic: "priority" });
	});
});
