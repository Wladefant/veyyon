import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdk from "@veyyon/coding-agent/sdk";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";

const agent = { name: "task", description: "test", systemPrompt: "test", source: "bundled" } as const;

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("spawns and completes without reading or changing an obsolete lane ledger", async () => {
	const isolated = enterIsolatedConfigRoot("native-lane-lifecycle", { defaultProfile: true });
	const session = createMockSession(async ({ emit }) => {
		emit(yieldSuccessEvent({ ok: true }));
	});
	const createSession = spyOn(sdk, "createAgentSession").mockResolvedValue(createSessionResult(session));
	try {
		const runDir = path.join(isolated.root, "run");
		const ledger = path.join(runDir, "lane-admission.json");
		await fs.mkdir(runDir, { recursive: true });
		await fs.writeFile(ledger, "invalid legacy ledger");
		const result = await runSubprocess({
			cwd: isolated.root,
			agent,
			task: "complete normally",
			index: 0,
			id: "LedgerIndependentSpawn",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			artifactsDir: isolated.root,
		});
		expect(result.terminalOutcome).toBe("completed");
		expect(result.exitCode).toBe(0);
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(await fs.readdir(runDir)).toEqual(["lane-admission.json"]);
		expect(await fs.readFile(ledger, "utf8")).toBe("invalid legacy ledger");
	} finally {
		createSession.mockRestore();
		isolated.restore();
	}
});
