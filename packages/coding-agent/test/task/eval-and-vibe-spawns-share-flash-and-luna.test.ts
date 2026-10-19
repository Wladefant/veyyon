/**
 * WHY: the Flash and Luna split only reached the `task` tool, because eval `agent()` and vibe
 * worker spawns resolved their model without a spawn identity, so every one of them kept Flash
 * first (https://github.com/Wladefant/superboard/issues/560).
 *
 * Drives each entry point through its real spawn path and counts the first model choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runEvalAgent } from "@veyyon/coding-agent/eval/agent-bridge";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { VibeSessionRegistry } from "@veyyon/coding-agent/session/vibe-runtime";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const FLASH = "google-antigravity/gemini-3.8-flash";
const LUNA = "openai-codex/gpt-6-luna";
const FALLBACK = "anthropic/claude-sonnet-4";

function definition(name: string): AgentDefinition {
	return { name, description: `${name} agent`, systemPrompt: "Execute the assignment.", source: "bundled" };
}

const idleWorker = {
	isStreaming: false,
	model: undefined,
	subscribe: () => () => {},
	prompt: async () => true,
	steer: async () => {},
	waitForIdle: async () => {},
	getLastAssistantMessage: () => ({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
	abort: async () => {},
	dispose: async () => {},
} as unknown as AgentSession;

describe("eval agent() and vibe workers deterministically use configured first choice", () => {
	let tempDir: TempDir;
	let chains: string[][];
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("eval-vibe-share-");
		chains = [];
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [definition("task"), definition("deep"), definition("qa-verifier")],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			chains.push([...(options.modelOverride ?? [])]);
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: idleWorker,
				status: "idle",
			});
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment ?? options.task,
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function openSession(sessionId: string, taskDepth = 0): ToolSession {
		const row = { model: [FLASH, LUNA, FALLBACK] };
		const settings = Settings.isolated({
			"async.enabled": false,
			"agent.isolation.mode": "none",
			"agent.agents": {
				task: { enabled: true, ...row, agents: row },
				deep: { enabled: true, ...row, agents: row },
				"qa-verifier": { enabled: true, ...row, agents: row },
			},
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return makeToolSession({
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			asyncJobManager: manager,
			taskDepth,
			maxNestedSpawnDepth: 3,
			getSessionId: () => sessionId,
			getSessionFile: () => tempDir.join("parent.jsonl"),
			getArtifactsDir: () => tempDir.path(),
			getSessionSpawns: () => "*",
			getModelString: () => FALLBACK,
		});
	}

	function expectDeterministicFirst(): void {
		const counts: Record<string, number> = {};
		for (const chain of chains) counts[chain[0]] = (counts[chain[0]] ?? 0) + 1;
		for (const chain of chains) expect(chain.slice(2)).toEqual([FALLBACK]);
		expect(counts[FLASH]).toBe(100);
		expect(counts[LUNA] ?? 0).toBe(0);
	}

	for (const agent of ["task", "qa-verifier"]) {
		for (const taskDepth of [0, 1]) {
			it(`eval agent(${agent}) at session depth ${taskDepth} deterministically uses configured first choice`, async () => {
				const session = openSession(`eval-${agent}-${taskDepth}`, taskDepth);
				for (let index = 0; index < 100; index++) {
					await runEvalAgent({ agent, prompt: "Inspect the requested behavior." }, { session });
				}
				expect(chains).toHaveLength(100);
				expectDeterministicFirst();
			}, 60000);
		}
	}

	it("a vibe worker on the deep agent deterministically uses configured first choice", async () => {
		const session = openSession("vibe-good");
		for (let index = 0; index < 100; index++) {
			const { jobId } = await VibeSessionRegistry.global().spawn(session, {
				cli: "good",
				name: `Vibe${index}`,
				prompt: "Inspect the requested behavior.",
			});
			await session.asyncJobManager?.getJob(jobId)?.promise;
		}
		expect(chains).toHaveLength(100);
		expectDeterministicFirst();
	}, 120000);
});
