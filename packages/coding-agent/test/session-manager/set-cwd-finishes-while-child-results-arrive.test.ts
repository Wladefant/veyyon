import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SetCwdTool } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";
import { makeToolSessionAt } from "../helpers/tool-session";
import { makeAssistantMessage } from "./helpers";

class GrowingJournalStorage extends FileSessionStorage {
	journal?: string;
	publishes = 0;
	beforePublish?: () => void;

	override renameSync(source: string, target: string): void {
		// The storage has staged the entire replacement and was about to rename it.
		if (target === this.journal && source.endsWith(".tmp")) {
			this.publishes++;
			this.beforePublish?.();
		}
		super.renameSync(source, target);
	}
}

it("finishes set_cwd on a large journal while real child outcomes keep arriving", async () => {
	using temp = TempDir.createSync("veyyon-growing-cwd-journal-");
	const dir = temp.path();
	const source = path.join(dir, "source");
	const destination = path.join(dir, "destination");
	fs.mkdirSync(source);
	fs.mkdirSync(destination);
	const storage = new GrowingJournalStorage();
	const manager = SessionManager.create(source, dir, storage);
	const auth = await AuthStorage.create(path.join(dir, "auth.db"));
	const model = createMockModel();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
		isSpawned: true,
	});
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const parent = registry.register({ id: "parent", displayName: "parent", kind: "main", session });
	const reported: string[] = [];
	const pending: Promise<void>[] = [];
	try {
		manager.appendMessage(makeAssistantMessage());
		const chunk = "x".repeat(256 * 1024);
		for (let i = 0; i < 128; i++) manager.appendCustomEntry("seed-history", { i, chunk });
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected the large session journal");
		expect(fs.statSync(file).size).toBeGreaterThan(32 * 1024 * 1024);

		storage.journal = file;
		storage.beforePublish = () => {
			// Keep reporting during every retry. Cap the source so the unfixed
			// version reaches an assertion instead of hanging the test process.
			if (storage.publishes > 3) return;
			for (let i = 0; i < 2; i++) {
				const id = `child-${reported.length}`;
				registry.register({
					id,
					displayName: id,
					kind: "sub",
					parentId: parent.id,
					session: null,
					status: "parked",
				});
				reported.push(id);
				// Prune writes the same terminal-outcome entry as the incident, then flushes.
				pending.push(lifecycle.prune(id));
			}
		};
		const tool = new SetCwdTool(makeToolSessionAt(source, { setCwd: session.setCwd.bind(session) }));
		const result = await tool.execute("cwd-change", { path: destination });
		await Promise.all(pending);
		expect(result.details?.cwd).toBe(destination);
		expect(storage.publishes).toBe(1);
		expect(reported).toHaveLength(2);

		const reopened = await SessionManager.open(file, dir, undefined, { suppressBreadcrumb: true });
		try {
			expect(reopened.getCwd()).toBe(destination);
			const outcomes = reopened
				.getEntries()
				.flatMap(entry =>
					entry.type === "custom_message" && entry.customType === "agent-terminal-outcome" ? [entry.details] : [],
				);
			expect(outcomes).toEqual(reported.map(agentId => expect.objectContaining({ agentId, outcome: "stalled" })));
		} finally {
			await reopened.close();
		}
	} finally {
		storage.beforePublish = undefined;
		await Promise.allSettled(pending);
		await lifecycle.dispose();
		await session.dispose();
		auth.close();
	}
}, 15_000);
