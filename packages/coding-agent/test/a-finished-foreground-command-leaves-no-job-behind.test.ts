/**
 * A foreground `bash` call runs as a managed job so it can move to the background, and every job
 * that finished used to stay in the job manager for the five-minute retention window with its output,
 * its abort controller and its eviction timer. A command whose result went back inline is never read
 * through the manager again, so a session that ran a few thousand commands held a few thousand dead
 * jobs: 3,211 of each per 3,200 commands in a soak.
 *
 * The class: a job whose caller consumed its result itself stays in the manager after it settles.
 * The suite drives the real `BashTool` foreground path under the default retention for each way a
 * foreground call can end with its result inline (exit 0, non-zero exit, timeout), and the manager's
 * `release` for each place a settled job can still be held when it is released (running, watched,
 * zero retention). The negative controls are a command that moves to the background, which must stay
 * readable, and a released job, which must never be delivered.
 *
 * Not caught: a new foreground consumer of a managed job that returns the result inline and does not
 * call `release`. Its jobs fall back to the retention window, which bounds them in time but not count.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { removeSyncWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

useIsolatedGlobalSettings();

let artifactCounter = 0;

function makeSession(cwd: string, manager: AsyncJobManager, overrides: Record<string, unknown>): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return makeToolSession({
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		asyncJobManager: manager,
		settings: Settings.isolated(overrides),
	});
}

const FOREGROUND = { "bash.autoBackground.enabled": false, "bash.stallDetection.enabled": false };

describe("a foreground bash call that returns its result inline", () => {
	let tempDir: string;
	let manager: AsyncJobManager;
	let delivered: string[];

	beforeAll(async () => {
		const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-release-warm-"));
		const warm = new AsyncJobManager({ onJobComplete: async () => {} });
		await new BashTool(makeSession(warmDir, warm, FOREGROUND)).execute("warm", { command: "true" });
		removeSyncWithRetries(warmDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-release-"));
		delivered = [];
		// The production retention: a job that is retained at all outlives every assertion here.
		manager = new AsyncJobManager({ onJobComplete: async jobId => void delivered.push(jobId) });
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1_000 });
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	// A non-zero exit returns an error result inline; a timeout throws.
	const endings: { name: string; command: string; timeout: number; throws: boolean; isError: boolean }[] = [
		{ name: "exits 0", command: "echo finished", timeout: 30, throws: false, isError: false },
		{ name: "exits non-zero", command: "echo failing; exit 3", timeout: 30, throws: false, isError: true },
		{ name: "times out", command: "sleep 5", timeout: 1, throws: true, isError: true },
	];

	for (const ending of endings) {
		it(`leaves no job in the manager once it ${ending.name}`, async () => {
			const tool = new BashTool(makeSession(tempDir, manager, FOREGROUND));
			const run = tool.execute(`call-${ending.name}`, { command: ending.command, timeout: ending.timeout });
			if (ending.throws) await expect(run).rejects.toThrow();
			else {
				const result = await run;
				expect(result.details?.async).toBeUndefined();
				expect(result.isError === true).toBe(ending.isError);
			}
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1_000 });

			expect(manager.getAllJobs()).toEqual([]);
			expect(delivered).toEqual([]);
		});
	}

	it("keeps a command that moved to the background readable after it finishes", async () => {
		const tool = new BashTool(
			makeSession(tempDir, manager, {
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 0,
				"bash.stallDetection.enabled": false,
			}),
		);
		const result = await tool.execute("background", { command: "echo later", timeout: 30 });
		const jobId = result.details?.async?.jobId;
		if (jobId === undefined) throw new Error("expected the command to move to the background");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(manager.getJob(jobId)?.resultText).toContain("later");
		expect(delivered).toEqual([jobId]);
	});
});

describe("AsyncJobManager.release", () => {
	it("evicts a job released while running as soon as it settles, without delivering it", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({ onJobComplete: async jobId => void delivered.push(jobId) });
		const finish = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "running", () => finish.promise);
		manager.release(jobId);
		expect(manager.getJob(jobId)?.status).toBe("running");

		finish.resolve("output");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		expect(manager.getJob(jobId)).toBeUndefined();
		expect(delivered).toEqual([]);
	});

	it("evicts a settled job at once", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const jobId = manager.register("bash", "settled", async () => "output");
		manager.acknowledgeDeliveries([jobId]);
		await manager.waitForAll();
		expect(manager.getJob(jobId)?.status).toBe("completed");

		manager.release(jobId);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	it("evicts a job a poll watched when the poll lets it go", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const finish = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "watched", () => finish.promise);
		manager.watchJobs([jobId]);
		manager.release(jobId);
		finish.resolve("output");
		await manager.waitForAll();
		expect(manager.getJob(jobId)?.status).toBe("completed");

		manager.unwatchJobs([jobId]);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	for (const outcome of ["completes", "fails"] as const) {
		it(`evicts a released job that ${outcome} under zero retention`, async () => {
			const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
			const finish = Promise.withResolvers<string>();
			const jobId = manager.register("bash", outcome, () => finish.promise);
			manager.release(jobId);
			if (outcome === "completes") finish.resolve("output");
			else finish.reject(new Error("exit 1"));
			await manager.waitForAll();

			expect(manager.getJob(jobId)).toBeUndefined();
		});
	}
});
