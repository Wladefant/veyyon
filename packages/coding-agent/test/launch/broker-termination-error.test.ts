/**
 * WHY THIS SUITE EXISTS.
 * -----------------------
 * In PR #103, `terminate_tree` returns Err when target PID equals self or an
 * ancestor, or when ancestry is unverifiable. When mapped through napi,
 * `Process.prototype.terminate` rejects.
 *
 * This suite proves that rejection does not leave daemon records in an invalid
 * state or abort daemon recovery:
 *
 * 1. #stopRecord error recovery: When `processRef.terminate` rejects (e.g. kill
 *    guard refusal or native error), `#stopRecord` catches the error, logs a
 *    debug message, and continues into fallback child process teardown and
 *    force-settle, transitioning the daemon to `exited` rather than leaving it
 *    stuck in `stopping`.
 *
 * 2. Broker recovery sweep resilience: When a replacement broker recovers
 *    unmanaged daemons left behind by a previous broker, a rejection from
 *    `processRef.terminate` is caught, logged, and does not abort recovery. The
 *    daemon transitions cleanly to `exited` with `broker-recovery` attribution,
 *    its completion record is retained, and subsequent daemon directories in
 *    the sweep are still recovered.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

let terminateShouldReject = false;
let terminateCallCount = 0;

mock.module("@veyyon/utils/native-process", () => ({
	processHandle: (pid: number) => ({
		status: () => "running",
		groupId: () => 1,
		terminate: async () => {
			terminateCallCount++;
			if (terminateShouldReject) {
				throw new Error(`refusing termination of protected or unverified pid ${pid}`);
			}
			return true;
		},
	}),
	processHandlesByPath: () => [],
}));

import { DaemonBroker } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	daemonBrokerTokenPath,
	managedDaemonDir,
	managedDaemonMetaPath,
	managedDaemonsRoot,
} from "../../src/launch/paths";
import type { DaemonSnapshot, DaemonSpec } from "../../src/launch/protocol";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-launch-termination-err");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-term-err");
	terminateShouldReject = false;
	terminateCallCount = 0;
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupBrokers: DaemonBroker[] = [];

afterEach(async () => {
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
	while (cleanupBrokers.length > 0) {
		const broker = cleanupBrokers.pop();
		if (broker) await broker.shutdown().catch(() => {});
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(testRoot, prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function startInProcessBroker(
	projectDir: string,
	runtimeDir: string,
): Promise<{ broker: DaemonBroker; client: DaemonBrokerClient }> {
	const token = "testtoken" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(daemonBrokerTokenPath(runtimeDir), token, { encoding: "utf8", mode: 0o600 });
	const broker = new DaemonBroker(projectDir, runtimeDir, token, 10_000);
	cleanupBrokers.push(broker);
	void broker.run();
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
	cleanupClients.push(client);
	return { broker, client };
}

describe("daemon termination error resilience", () => {
	it("settles daemon cleanly to exited when processRef.terminate rejects during stop", async () => {
		const projectDir = await tempDir("project-stop-refuse-");
		const runtimeDir = await tempDir("runtime-stop-refuse-");

		const { client } = await startInProcessBroker(projectDir, runtimeDir);

		// Start a process
		const startRes = await client.request({
			op: "start",
			spec: {
				name: "refusal-victim",
				application: process.execPath,
				args: ["-e", "process.stdin.resume();"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		expect(startRes.op).toBe("start");

		// Arm the mock to reject terminate calls with kill-guard refusal
		terminateShouldReject = true;
		const callsBefore = terminateCallCount;

		// Issue operator stop; processRef.terminate will throw
		const stopRes = await client.request({ op: "stop", name: "refusal-victim", timeoutMs: 1_000 });
		expect(stopRes.op).toBe("stop");
		if (stopRes.op === "stop") {
			expect(stopRes.daemon.state).toBe("exited");
			expect(stopRes.daemon.terminatedBy).toBe("operator-stop");
		}

		expect(terminateCallCount).toBeGreaterThan(callsBefore);

		// Verify list also shows the daemon in exited state, not stuck in stopping
		const listed = await client.request({ op: "list" });
		expect(listed.op).toBe("list");
		if (listed.op === "list") {
			const daemon = listed.daemons.find(d => d.name === "refusal-victim");
			expect(daemon?.state).toBe("exited");
		}
	}, 20_000);

	it("recovers unmanaged daemons cleanly without aborting when processRef.terminate rejects", async () => {
		const projectDir = await tempDir("project-recovery-refuse-");
		const runtimeDir = await tempDir("runtime-recovery-refuse-");

		// Seed two unmanaged daemon directories that need termination during recovery
		const daemonsDir = managedDaemonsRoot(runtimeDir);
		await fs.mkdir(daemonsDir, { recursive: true });

		for (const name of ["refuse-daemon-1", "refuse-daemon-2"]) {
			const daemonDir = managedDaemonDir(runtimeDir, name);
			await fs.mkdir(daemonDir, { recursive: true });
			const spec: DaemonSpec = {
				name,
				application: process.execPath,
				args: ["-e", "process.stdin.resume();"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};
			const snapshot: DaemonSnapshot = {
				name,
				id: `seed-id-${name}`,
				owner: "test-seed",
				state: "running",
				pid: 88888,
				createdAt: Date.now() - 5000,
				startedAt: Date.now() - 4000,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
			};
			await fs.writeFile(managedDaemonMetaPath(daemonDir), JSON.stringify({ daemon: snapshot, spec }), "utf8");
		}

		// Arm the mock before the replacement broker starts its recovery sweep
		terminateShouldReject = true;

		// Start broker; recovery sweep runs #recoverRecords
		const { client } = await startInProcessBroker(projectDir, runtimeDir);

		const listed = await client.request({ op: "list" });
		expect(listed.op).toBe("list");
		if (listed.op === "list") {
			// Both daemons should have been recovered despite terminate throwing
			const d1 = listed.daemons.find(d => d.name === "refuse-daemon-1");
			const d2 = listed.daemons.find(d => d.name === "refuse-daemon-2");

			expect(d1).toBeDefined();
			expect(d1?.state).toBe("exited");
			expect(d1?.terminatedBy).toBe("broker-recovery");
			expect(d1?.pid).toBeUndefined();

			expect(d2).toBeDefined();
			expect(d2?.state).toBe("exited");
			expect(d2?.terminatedBy).toBe("broker-recovery");
			expect(d2?.pid).toBeUndefined();

			// Both completions must be recorded
			const c1 = listed.completions.find(c => c.name === "refuse-daemon-1");
			const c2 = listed.completions.find(c => c.name === "refuse-daemon-2");
			expect(c1?.terminatedBy).toBe("broker-recovery");
			expect(c2?.terminatedBy).toBe("broker-recovery");
		}
	}, 20_000);
});
