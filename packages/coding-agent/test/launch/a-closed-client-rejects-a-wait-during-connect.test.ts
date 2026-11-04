/**
 * WHY THIS TEST EXISTS.
 * Closing a SocketDaemonClient before IPC connect completes can miss the late
 * socket, so a pending wait resolves and keeps an empty broker authenticated.
 * This real-client regression closes that disposal race. It does not test
 * connect retries before a broker exists or cached-client reconnect behavior.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isProcessAlive } from "../../../utils/src/process-liveness";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerLeasePath } from "../../src/launch/paths";

test("a closed independent client rejects its wait and releases a late broker connection", async () => {
	const isolation = enterIsolatedConfigRoot("close-during-connect");
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-close-project-"));
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-close-runtime-"));
	const candidates: number[] = [];
	const client = await createDaemonBrokerClient(project, {
		runtimeDir,
		idleGraceMs: 150,
		adoptSpawnedPid: pid => candidates.push(pid),
	});
	let closingClient: DaemonBrokerClient | undefined;
	let brokerPid: number | undefined;

	try {
		const ping = await client.request({ op: "ping" });
		if (ping.op !== "ping" || ping.pid === undefined) throw new Error("Broker did not report its PID");
		brokerPid = ping.pid;
		expect(candidates).toHaveLength(1);

		const started = await client.request({
			op: "start",
			spec: {
				name: "service",
				application: process.execPath,
				args: ["-e", "require('node:net').createServer().listen(0, '127.0.0.1')"],
				env: {},
				cwd: project,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		if (started.op !== "start") throw new Error("Unexpected start response");

		closingClient = await createDaemonBrokerClient(project, { runtimeDir, idleGraceMs: 150 });
		const pending = closingClient.request({ op: "wait", name: "service", for: "exit", timeoutMs: 600 });
		closingClient.close();
		await expect(pending).rejects.toThrow("Daemon broker client is closed");

		const stopped = await client.request({ op: "stop", name: "service", timeoutMs: 2_000 });
		expect(stopped.op).toBe("stop");
		client.close();

		const leasePath = daemonBrokerLeasePath(runtimeDir);
		const leaseExists = async (): Promise<boolean> =>
			fs.stat(leasePath).then(
				() => true,
				() => false,
			);
		// The broker and its OS process run separately, so fake timers cannot drive their lifecycle.
		const deadline = Date.now() + 1_200;
		while (Date.now() < deadline && (isProcessAlive(brokerPid) || (await leaseExists()))) await delay(50);
		expect(isProcessAlive(brokerPid)).toBeFalse();
		expect(await leaseExists()).toBeFalse();
	} finally {
		closingClient?.close();
		if (brokerPid !== undefined && isProcessAlive(brokerPid)) {
			const cleanupClient = await createDaemonBrokerClient(project, { runtimeDir, idleGraceMs: 150 });
			try {
				await cleanupClient.request({ op: "shutdown" });
			} catch {
				// The broker may exit while cleanup connects.
			} finally {
				cleanupClient.close();
			}
		}
		client.close();
		isolation.restore();
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}, 15_000);
