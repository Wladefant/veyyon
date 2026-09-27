/**
 * A spawn ceiling raised in `config.yml` and applied with `/reload-config` admits lanes already
 * waiting for a slot, at once.
 *
 * WHY THIS SUITE EXISTS. `Settings.reloadConfig()` re-read only the routing keys, so a raised
 * `agent.maxConcurrency` never left the file, and the session kept admitting the old number of
 * lanes while the rest stayed queued (https://github.com/Wladefant/veyyon/issues/176). A second
 * gap sat behind the first: the tree's spawn semaphore learns its ceiling only when a spawner
 * acquires or releases, so even a value that did reach the store left parked lanes waiting for
 * an unrelated lane to finish.
 *
 * The suite drives the real path end to end: a config file on disk, `Settings.reloadConfig()`,
 * a real `AgentSession` (whose constructor registers the tree budget the semaphore keys on, and
 * whose `session/runtime/max-concurrency-runtime` collaborator resizes the semaphore on the
 * setting change) and the semaphore `TaskTool` resolves through `treeSpawnSemaphore`. Nothing
 * acquires or releases between the reload and the assertion, so only the reload can admit the
 * queued lanes.
 *
 * WHAT IT DOES NOT CATCH. The embedded-SDK fallback, where a session has no budget group and
 * `TaskTool` keeps an instance-local semaphore, still applies a new ceiling on its next acquire
 * or release; this suite does not construct that case.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { resetSessionCpuLimitsForTests } from "@veyyon/coding-agent/session/cpu-limit";
import type { Semaphore } from "@veyyon/coding-agent/task/parallel";
import { resetTreeSpawnSemaphoresForTests, treeSpawnSemaphore } from "@veyyon/coding-agent/task/spawn-semaphore";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("spawn-ceiling-reload-");
const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	resetTreeSpawnSemaphoresForTests();
	resetSessionCpuLimitsForTests();
});

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

/** Whether a promise is still unsettled after the microtask queue and a timer turn. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await sleep(5);
	return !settled;
}

interface Fixture {
	file: string;
	settings: Settings;
	semaphore: Semaphore;
}

/** A session loaded from a config file, with the spawn semaphore its task tool would use. */
async function sessionWithCeiling(ceiling: number): Promise<Fixture> {
	const dir = dirs();
	const file = path.join(dir, "config.yml");
	await fs.writeFile(file, `agent:\n  maxConcurrency: ${ceiling}\n`);
	const settings = await Settings.loadReadOnly({ agentDir: dir });
	const sessionManager = SessionManager.inMemory();
	sessions.push(
		new AgentSession({
			agent: new Agent({ initialState: { model: createModel(), systemPrompt: ["s"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: {} as never,
		}),
	);
	const semaphore = treeSpawnSemaphore(sessionManager.getSessionId(), settings.get("agent.maxConcurrency"));
	if (!semaphore) throw new Error("an AgentSession registers a budget group, so its tree has a semaphore");
	return { file, settings, semaphore };
}

describe("a reloaded spawn ceiling", () => {
	it("admits lanes already queued at the old ceiling without waiting for a release", async () => {
		const { file, settings, semaphore } = await sessionWithCeiling(1);
		await semaphore.acquire();
		const second = semaphore.acquire();
		const third = semaphore.acquire();
		expect(await isPending(second)).toBe(true);
		expect(await isPending(third)).toBe(true);

		await fs.writeFile(file, "agent:\n  maxConcurrency: 3\n");
		const result = await settings.reloadConfig();

		expect(result.changed.map(row => row.path)).toEqual(["agent.maxConcurrency"]);
		expect(settings.get("agent.maxConcurrency")).toBe(3);
		expect(await isPending(second)).toBe(false);
		expect(await isPending(third)).toBe(false);
	});

	it("admits no more lanes than the raised ceiling", async () => {
		const { file, settings, semaphore } = await sessionWithCeiling(1);
		await semaphore.acquire();
		const queued = [semaphore.acquire(), semaphore.acquire(), semaphore.acquire()];

		await fs.writeFile(file, "agent:\n  maxConcurrency: 2\n");
		await settings.reloadConfig();

		const pending = await Promise.all(queued.map(isPending));
		expect(pending).toEqual([false, true, true]);
	});

	it("lowering the ceiling admits nothing and lets running lanes finish", async () => {
		const { file, settings, semaphore } = await sessionWithCeiling(2);
		await semaphore.acquire();
		await semaphore.acquire();
		const queued = semaphore.acquire();

		await fs.writeFile(file, "agent:\n  maxConcurrency: 1\n");
		await settings.reloadConfig();
		expect(settings.get("agent.maxConcurrency")).toBe(1);
		expect(await isPending(queued)).toBe(true);

		// One release leaves one lane running, which is already the new ceiling.
		semaphore.release();
		expect(await isPending(queued)).toBe(true);
		semaphore.release();
		expect(await isPending(queued)).toBe(false);
	});
});
