import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdk from "@veyyon/coding-agent/sdk";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import { reserveNativeLane } from "@veyyon/coding-agent/task/native-lane-capacity";
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

it("rejects a spawn at the process cap and reuses slots after successful and failed turns", async () => {
	const isolated = enterIsolatedConfigRoot("native-lane-cap", { defaultProfile: true });
	const slots: Array<() => void> = [];
	let failNextPrompt = true;
	const createSession = spyOn(sdk, "createAgentSession").mockImplementation(async () =>
		createSessionResult(
			createMockSession(async ({ emit }) => {
				if (failNextPrompt) {
					failNextPrompt = false;
					throw new Error("test prompt failure");
				}
				emit(yieldSuccessEvent({ ok: true }));
			}),
		),
	);
	const spawn = (id: string) =>
		runSubprocess({
			cwd: isolated.root,
			agent,
			task: "exercise the process cap",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [], getApiKey: async () => "k" } as never,
			enableLsp: false,
			artifactsDir: isolated.root,
		});
	try {
		for (let index = 0; index < 100; index++) slots.push(reserveNativeLane(`holder-${index}`, isolated.root));
		const refused = await spawn("PastCapacity");
		expect(refused.terminalOutcome).toBe("startup-failed");
		expect(refused.error).toContain("100 active native agent lanes");
		expect(createSession).not.toHaveBeenCalled();

		slots.pop()?.();
		expect((await spawn("FailedTurn")).exitCode).toBe(1);
		expect((await spawn("NextTurn")).terminalOutcome).toBe("completed");
		expect((await spawn("FinalTurn")).terminalOutcome).toBe("completed");
		expect(createSession).toHaveBeenCalledTimes(3);
		await expect(fs.lstat(path.join(isolated.root, "run", "lane-admission.json.lock"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		for (const release of slots) release();
		createSession.mockRestore();
		isolated.restore();
	}
});

it("counts a retained turn with its original lane until both holders leave", () => {
	const slots: Array<() => void> = [];
	try {
		for (let index = 0; index < 100; index++) slots.push(reserveNativeLane(`holder-${index}`, "/transcript"));
		const original = slots[0]!;
		const retained = reserveNativeLane("holder-0", "/transcript");
		slots.push(retained);
		expect(() => reserveNativeLane("holder-0", "/other-transcript")).toThrow("100 active native agent lanes");
		original();
		original();
		expect(() => reserveNativeLane("next", "/transcript")).toThrow("100 active native agent lanes");
		retained();
		slots.push(reserveNativeLane("next", "/transcript"));
	} finally {
		for (const release of slots) release();
	}
});
