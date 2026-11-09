/**
 * WHY THIS SUITE EXISTS.
 * -----------------------
 * When a background daemon under name A terminates (e.g. completes or is stopped) and a
 * replacement daemon is started under the same name A, or when daemon A is restarted
 * (advancing its incarnation generation), clients holding stale references to the earlier
 * incarnation must never accidentally control or follow the replacement (issue #1071).
 *
 * This suite exercises a real supervised daemon broker and tests the end-to-end
 * observable guarantees of guarded identity control:
 *
 * 1. Name reuse / replacement protection:
 *    - Process A (initial) runs under name "worker" with id A.id and generation 1.
 *    - Process A exits.
 *    - Process B (replacement) starts under the same name "worker" with id B.id and generation 1.
 *    - Stale guarded send, stop, wait, and restart specifying A.id / generation 1 MUST be rejected
 *      with /Daemon identity mismatch/ and MUST NOT affect B.
 * 2. Restart generation advancement:
 *    - Process starts under name "service" with id S.id and generation 1.
 *    - Restarting "service" retains S.id and increments generation to 2.
 *    - Stale guarded operations referencing generation 1 MUST be rejected with /Daemon identity mismatch/.
 * 3. Matching guarded control success:
 *    - Guarded send, stop, and wait with matching expectedId and expectedGeneration succeed cleanly.
 * 4. Guardless named controls preserved:
 *    - Ordinary unguarded operations (send, stop, wait, restart with only `name`) continue to work
 *      without restriction.
 * 5. Guarded pending wait rejection on restart:
 *    - A client issues a guarded wait for exit on incarnation generation 1.
 *    - Daemon restarts (generation advances to 2).
 *    - The guarded pending wait rejects with /Daemon identity mismatch/ rather than following B.
 * 6. Bounded stop escalation with unrelated child survives:
 *    - Guarded stop targeting a matched daemon safely terminates it without killing unrelated
 *      neighbour processes.
 *
 * WHAT IT DOES NOT CATCH:
 * Wire protocol encoding/decoding details in isolation (covered in `guarded-protocol.test.ts`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// Separate broker and child processes require real platform clock for polling.
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { shutdownBroker } from "../helpers/daemon-broker";
import { makeToolSession } from "../helpers/tool-session";
import { LaunchTool } from "../../src/tools/shell/launch";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-guarded-control-tests");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("guarded-control");
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];

afterEach(async () => {
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
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

async function connect(projectDir: string, runtimeDir: string, idleGraceMs = 10_000): Promise<DaemonBrokerClient> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs });
	cleanupClients.push(client);
	return client;
}

describe("guarded control never follows a replacement", () => {
	it("stale controls targeting replaced daemon A do not affect replacement B", async () => {
		const projectDir = await tempDir("project-replaced-");
		const runtimeDir = await tempDir("runtime-replaced-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Prepare neutral temp output files to record stdin delivered to A and B
			const outputA = path.join(projectDir, "stdin-a.log");
			const outputB = path.join(projectDir, "stdin-b.log");

			const childScript = (outFile: string) => `
				const fs = require("node:fs");
				process.stdin.on("data", chunk => {
					fs.appendFileSync(${JSON.stringify(outFile)}, chunk);
				});
				process.stdin.resume();
				setInterval(() => {}, 1000);
			`;

			// Start daemon A: long running daemon listening on stdin
			const startA = await client.request({
				op: "start",
				spec: {
					name: "worker",
					application: process.execPath,
					args: ["-e", childScript(outputA)],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(startA.op).toBe("start");
			if (startA.op !== "start") throw new Error("failed start A");
			const daemonA = startA.daemon;
			const idA = daemonA.id;
			const genA = daemonA.generation ?? 1;

			// Stop daemon A cleanly
			const stopA = await client.request({
				op: "stop",
				name: "worker",
				timeoutMs: 3000,
			});
			expect(stopA.op).toBe("stop");

			// Start daemon B under the same name: runs persistently, listening on stdin
			const startB = await client.request({
				op: "start",
				spec: {
					name: "worker",
					application: process.execPath,
					args: ["-e", childScript(outputB)],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(startB.op).toBe("start");
			if (startB.op !== "start") throw new Error("failed start B");
			const daemonB = startB.daemon;
			const idB = daemonB.id;
			expect(idB).not.toBe(idA);

			// Stale guarded stop targeting A must reject with mismatch
			await expect(
				client.request({
					op: "stop",
					name: "worker",
					timeoutMs: 2000,
					expectedId: idA,
					expectedGeneration: genA,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Stale guarded send targeting A must reject with mismatch
			await expect(
				client.request({
					op: "send",
					name: "worker",
					data: "stale payload intended for A\n",
					expectedId: idA,
					expectedGeneration: genA,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Valid matching guarded send targeting B must succeed
			const sendB = await client.request({
				op: "send",
				name: "worker",
				data: "matching payload for B\n",
				expectedId: idB,
				expectedGeneration: daemonB.generation ?? 1,
			});
			expect(sendB.op).toBe("send");

			// Poll until matching bytes arrive in outputB
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				try {
					const content = await fs.readFile(outputB, "utf8");
					if (content.includes("matching payload for B")) break;
				} catch {}
				await delay(50);
			}

			// Assert no stale bytes delivered to B, and matching bytes arrived
			const contentB = await fs.readFile(outputB, "utf8");
			expect(contentB).toContain("matching payload for B");
			expect(contentB).not.toContain("stale payload intended for A");

			// Stale guarded restart targeting A must reject with mismatch
			await expect(
				client.request({
					op: "restart",
					name: "worker",
					expectedId: idA,
					expectedGeneration: genA,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Stale guarded wait targeting A must reject with mismatch
			await expect(
				client.request({
					op: "wait",
					name: "worker",
					for: "exit",
					timeoutMs: 2000,
					expectedId: idA,
					expectedGeneration: genA,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Verify B is still running unharmed
			const listAfter = await client.request({ op: "list" });
			expect(listAfter.op).toBe("list");
			if (listAfter.op === "list") {
				const currentB = listAfter.daemons.find(d => d.name === "worker");
				expect(currentB?.id).toBe(idB);
				expect(currentB?.state).toBe("running");
			}
			// Clean stop B
			await client.request({ op: "stop", name: "worker", timeoutMs: 2000 });
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("restart retains daemon ID and increments generation; stale generation rejects", async () => {
		const projectDir = await tempDir("project-restart-gen-");
		const runtimeDir = await tempDir("runtime-restart-gen-");
		const client = await connect(projectDir, runtimeDir);

		try {
			const startRes = await client.request({
				op: "start",
				spec: {
					name: "service",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(startRes.op).toBe("start");
			if (startRes.op !== "start") throw new Error("failed start");
			const id1 = startRes.daemon.id;
			const gen1 = startRes.daemon.generation;
			expect(gen1).toBe(1);

			// Matching guarded restart
			const restartRes = await client.request({
				op: "restart",
				name: "service",
				expectedId: id1,
				expectedGeneration: 1,
			});
			expect(restartRes.op).toBe("restart");
			if (restartRes.op !== "restart") throw new Error("failed restart");
			expect(restartRes.daemon.id).toBe(id1);
			expect(restartRes.daemon.generation).toBe(2);

			// Stale generation 1 restart must reject
			await expect(
				client.request({
					op: "restart",
					name: "service",
					expectedId: id1,
					expectedGeneration: 1,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Stale generation 1 stop must reject
			await expect(
				client.request({
					op: "stop",
					name: "service",
					timeoutMs: 2000,
					expectedId: id1,
					expectedGeneration: 1,
				}),
			).rejects.toThrow(/Daemon identity mismatch/);

			// Matching guarded stop on generation 2 succeeds
			const stopRes = await client.request({
				op: "stop",
				name: "service",
				timeoutMs: 2000,
				expectedId: id1,
				expectedGeneration: 2,
			});
			expect(stopRes.op).toBe("stop");
			if (stopRes.op === "stop") {
				expect(stopRes.daemon.state).toBe("exited");
			}
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("matching guarded send, stop, and wait succeed cleanly", async () => {
		const projectDir = await tempDir("project-match-guard-");
		const runtimeDir = await tempDir("runtime-match-guard-");
		const client = await connect(projectDir, runtimeDir);

		try {
			const startRes = await client.request({
				op: "start",
				spec: {
					name: "echoer",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(startRes.op).toBe("start");
			if (startRes.op !== "start") throw new Error("failed start");
			const id = startRes.daemon.id;
			const gen = startRes.daemon.generation ?? 1;

			// Guarded send succeeds
			const sendRes = await client.request({
				op: "send",
				name: "echoer",
				data: "test input\n",
				expectedId: id,
				expectedGeneration: gen,
			});
			expect(sendRes.op).toBe("send");

			// Guarded stop succeeds
			const stopRes = await client.request({
				op: "stop",
				name: "echoer",
				timeoutMs: 2000,
				expectedId: id,
				expectedGeneration: gen,
			});
			expect(stopRes.op).toBe("stop");
			if (stopRes.op === "stop") {
				expect(stopRes.daemon.state).toBe("exited");
			}

			// Guarded wait for exit succeeds
			const waitRes = await client.request({
				op: "wait",
				name: "echoer",
				for: "exit",
				timeoutMs: 2000,
				expectedId: id,
				expectedGeneration: gen,
			});
			expect(waitRes.op).toBe("wait");
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("guardless named controls are preserved", async () => {
		const projectDir = await tempDir("project-guardless-");
		const runtimeDir = await tempDir("runtime-guardless-");
		const client = await connect(projectDir, runtimeDir);

		try {
			await client.request({
				op: "start",
				spec: {
					name: "legacy-ctrl",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});

			// Unguarded send
			const sendRes = await client.request({
				op: "send",
				name: "legacy-ctrl",
				data: "hello\n",
			});
			expect(sendRes.op).toBe("send");

			// Unguarded restart
			const restartRes = await client.request({
				op: "restart",
				name: "legacy-ctrl",
			});
			expect(restartRes.op).toBe("restart");

			// Unguarded stop
			const stopRes = await client.request({
				op: "stop",
				name: "legacy-ctrl",
				timeoutMs: 2000,
			});
			expect(stopRes.op).toBe("stop");
			if (stopRes.op === "stop") {
				expect(stopRes.daemon.state).toBe("exited");
			}
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("guarded pending wait rejects when daemon restarts rather than following replacement generation", async () => {
		const projectDir = await tempDir("project-wait-reject-");
		const runtimeDir = await tempDir("runtime-wait-reject-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Gen 1 only prints GEN1_UP, NOT the wait marker.
			// Gen 2 prints MARKER_ONLY_GEN2 when restarted.
			const childScript = `
				if (process.env.RESTARTED === "1") {
					console.log("MARKER_ONLY_GEN2");
				} else {
					console.log("GEN1_UP");
				}
				setInterval(() => {}, 1000);
			`;

			const startRes = await client.request({
				op: "start",
				spec: {
					name: "restarting-job",
					application: process.execPath,
					args: ["-e", childScript],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
					ready: { log: "GEN1_UP", timeoutMs: 5000 },
				},
			});
			expect(startRes.op).toBe("start");
			if (startRes.op !== "start") throw new Error("failed start");
			const id = startRes.daemon.id;
			expect(startRes.daemon.generation).toBe(1);

			// Arm a guarded wait for pattern absent on gen1 (will only print on gen2)
			const pendingWait = client.request({
				op: "wait",
				name: "restarting-job",
				for: "ready",
				pattern: "MARKER_ONLY_GEN2",
				timeoutMs: 10_000,
				expectedId: id,
				expectedGeneration: 1,
			});

			// Give wait loop time to enter polling
			await delay(100);

			// Restart daemon to generation 2, passing RESTARTED=1 so marker is printed
			await client.request({
				op: "restart",
				name: "restarting-job",
				expectedId: id,
				expectedGeneration: 1,
			});

			// The guarded pending wait for generation 1 MUST reject with /Daemon identity mismatch/,
			// not time out and not match the gen2 marker.
			await expect(pendingWait).rejects.toThrow(/Daemon identity mismatch/);

			// Clean stop
			await client.request({ op: "stop", name: "restarting-job", timeoutMs: 2000 });
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("bounded stop escalation on trapped SIGTERM leaves unrelated neighbour unharmed and alive", async () => {
		const projectDir = await tempDir("project-unrelated-");
		const runtimeDir = await tempDir("runtime-unrelated-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Target daemon traps SIGTERM to force broker escalation to SIGKILL.
			// Prints "TARGET_READY" only after the SIGTERM handler is definitely registered.
			const targetScript = `
				process.on("SIGTERM", () => {
					// Deliberately ignore SIGTERM to force SIGKILL escalation
				});
				console.log("TARGET_READY");
				setInterval(() => {}, 1000);
			`;

			// Neighbour daemon logs regular heartbeats and responds to guarded control
			const heartbeatLog = path.join(projectDir, "neighbour-heartbeat.log");
			const neighbourScript = `
				const fs = require("node:fs");
				let count = 0;
				setInterval(() => {
					fs.writeFileSync(${JSON.stringify(heartbeatLog)}, String(++count));
				}, 50);
				console.log("NEIGHBOUR_READY");
			`;

			// Start target daemon with ready condition ensuring SIGTERM trap is active
			const targetRes = await client.request({
				op: "start",
				spec: {
					name: "target",
					application: process.execPath,
					args: ["-e", targetScript],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
					ready: { log: "TARGET_READY", timeoutMs: 5000 },
				},
			});
			expect(targetRes.op).toBe("start");
			if (targetRes.op !== "start") throw new Error("failed start target");

			// Start unrelated neighbour daemon
			const neighbourRes = await client.request({
				op: "start",
				spec: {
					name: "neighbour",
					application: process.execPath,
					args: ["-e", neighbourScript],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
					ready: { log: "NEIGHBOUR_READY", timeoutMs: 5000 },
				},
			});
			expect(neighbourRes.op).toBe("start");
			if (neighbourRes.op !== "start") throw new Error("failed start neighbour");
			const neighbourId = neighbourRes.daemon.id;
			const neighbourGen = neighbourRes.daemon.generation ?? 1;

			// Read initial heartbeat count
			await delay(150);
			const initialHeartbeat = Number(await fs.readFile(heartbeatLog, "utf8"));
			expect(initialHeartbeat).toBeGreaterThan(0);

			// Stop target with a short timeout (1000ms) to trigger escalation.
			// Measure elapsed duration to assert bounded escalation.
			const stopStart = Date.now();
			const stopRes = await client.request({
				op: "stop",
				name: "target",
				timeoutMs: 1000,
				expectedId: targetRes.daemon.id,
				expectedGeneration: targetRes.daemon.generation ?? 1,
			});
			const stopElapsed = Date.now() - stopStart;

			expect(stopRes.op).toBe("stop");
			// Must be bounded: grace (1000ms) + bound (2000ms max) -> under 5000ms
			expect(stopElapsed).toBeGreaterThanOrEqual(900);
			expect(stopElapsed).toBeLessThan(5000);

			// Unrelated neighbour daemon survives: verify by observable heartbeat progression
			await delay(150);
			const laterHeartbeat = Number(await fs.readFile(heartbeatLog, "utf8"));
			expect(laterHeartbeat).toBeGreaterThan(initialHeartbeat);

			// Unrelated neighbour daemon survives: verify by successful guarded exchange
			const waitNeighbour = await client.request({
				op: "wait",
				name: "neighbour",
				for: "ready",
				timeoutMs: 2000,
				expectedId: neighbourId,
				expectedGeneration: neighbourGen,
			});
			expect(waitNeighbour.op).toBe("wait");
			if (waitNeighbour.op === "wait") {
				expect(waitNeighbour.timedOut).toBeFalse();
			}

			// Clean stop neighbour
			await client.request({ op: "stop", name: "neighbour", timeoutMs: 2000 });
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("real broker lists capabilities.guardedIdentity = 1 and LaunchTool details propagates marker", async () => {
		const projectDir = await tempDir("project-caps-");
		const runtimeDir = await tempDir("runtime-caps-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// 1. Direct broker client list assertion
			const listRes = await client.request({ op: "list" });
			expect(listRes.op).toBe("list");
			if (listRes.op === "list") {
				expect(listRes.capabilities).toEqual({ guardedIdentity: 1 });
			}

			// 2. LaunchTool execution propagates capability marker to details
			const session = makeToolSession({ cwd: projectDir });
			const tool = new LaunchTool(session);
			const toolResult = await tool.execute("call-list", { op: "list" });
			expect(toolResult.details?.op).toBe("list");
			expect(toolResult.details?.capabilities).toEqual({ guardedIdentity: 1 });
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);

	it("bounded stop escalation leaves unrelated neighbouring daemon unharmed", async () => {
		const projectDir = await tempDir("project-unrelated-");
		const runtimeDir = await tempDir("runtime-unrelated-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Start target daemon
			const targetRes = await client.request({
				op: "start",
				spec: {
					name: "target",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(targetRes.op).toBe("start");

			// Start unrelated neighbour daemon
			const neighbourRes = await client.request({
				op: "start",
				spec: {
					name: "neighbour",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(neighbourRes.op).toBe("start");
			if (neighbourRes.op !== "start") throw new Error("failed start neighbour");
			const neighbourPid = neighbourRes.daemon.pid;

			// Stop target
			await client.request({
				op: "stop",
				name: "target",
				timeoutMs: 3000,
				expectedId: targetRes.op === "start" ? targetRes.daemon.id : "",
				expectedGeneration: targetRes.op === "start" ? (targetRes.daemon.generation ?? 1) : 1,
			});

			// Verify neighbour is still alive and running
			const listRes = await client.request({ op: "list" });
			expect(listRes.op).toBe("list");
			if (listRes.op === "list") {
				const neighbour = listRes.daemons.find(d => d.name === "neighbour");
				expect(neighbour?.state).toBe("running");
				expect(neighbour?.pid).toBe(neighbourPid);
			}

			// Clean stop neighbour
			await client.request({ op: "stop", name: "neighbour", timeoutMs: 2000 });
		} finally {
			await shutdownBroker(client);
		}
	}, 30_000);
});
