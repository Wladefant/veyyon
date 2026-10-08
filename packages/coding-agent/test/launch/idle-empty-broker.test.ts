import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isProcessAlive } from "../../../utils/src/process-liveness";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { closeDaemonClients, daemonClientForProject } from "../../src/launch/client";
import { daemonBrokerLeasePath } from "../../src/launch/paths";
import { registerDaemonProjectPresence } from "../../src/launch/presence";

test("an empty broker exits while its Main stays alive and its cached client reconnects", async () => {
	const isolation = enterIsolatedConfigRoot("idle-empty-broker");
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-idle-project-"));
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-idle-runtime-"));
	const presence = await registerDaemonProjectPresence(project, runtimeDir);
	const candidates: number[] = [];
	const client = await daemonClientForProject(project, {
		runtimeDir,
		idleGraceMs: 150,
		adoptSpawnedPid: pid => candidates.push(pid),
	});
	try {
		const first = await client.request({ op: "ping" });
		expect(first.op).toBe("ping");
		const replies = await Promise.all(Array.from({ length: 12 }, () => client.request({ op: "ping" })));
		expect(replies.every(reply => reply.op === "ping" && first.op === "ping" && reply.pid === first.pid)).toBeTrue();
		expect(candidates.length).toBe(1);
		const deadline = Date.now() + 5000;
		// The broker runs in another process, so fake timers cannot drive its OS lifecycle.
		while (
			Date.now() < deadline &&
			(await fs.stat(daemonBrokerLeasePath(runtimeDir)).then(
				() => true,
				() => false,
			))
		)
			await Bun.sleep(50);
		expect(
			await fs.stat(daemonBrokerLeasePath(runtimeDir)).then(
				() => true,
				() => false,
			),
		).toBeFalse();
		if (first.op !== "ping" || first.pid === undefined) throw new Error("Broker did not report its PID");
		const exitDeadline = Date.now() + 5000;
		while (Date.now() < exitDeadline && isProcessAlive(first.pid)) await Bun.sleep(50);
		expect(isProcessAlive(first.pid)).toBeFalse();
		expect(await daemonClientForProject(project)).toBe(client);
		expect((await client.request({ op: "ping" })).op).toBe("ping");
		expect(candidates.length).toBe(2);
	} finally {
		await client.request({ op: "shutdown" }).catch(() => {});
		await closeDaemonClients();
		await presence.close();
		isolation.restore();
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}, 30000);

test("a shared client preserves a daemon outside Main's startup project through idle sockets and pending waits", async () => {
	const isolation = enterIsolatedConfigRoot("idle-running-broker");
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-running-project-"));
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-running-runtime-"));
	const startupProject = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-startup-project-"));
	const presence = await registerDaemonProjectPresence(startupProject);
	const client = await daemonClientForProject(project, { runtimeDir, idleGraceMs: 100 });
	try {
		const started = await client.request({
			op: "start",
			spec: {
				name: "service",
				application: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				env: {},
				cwd: project,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		if (started.op !== "start") throw new Error("Unexpected start response");
		const pid = started.daemon.pid;
		expect(pid).toBeDefined();
		const waiting = await client.request({ op: "wait", name: "service", for: "exit", timeoutMs: 600 });
		expect(waiting.op === "wait" && waiting.timedOut).toBeTrue();
		// Separate broker and child processes require the real platform clock.
		await Bun.sleep(600);
		const described = await client.request({ op: "describe", name: "service" });
		expect(described.op === "describe" && described.daemon.pid === pid).toBeTrue();
		expect(pid !== undefined && isProcessAlive(pid)).toBeTrue();
	} finally {
		await client.request({ op: "shutdown" }).catch(() => {});
		await closeDaemonClients();
		await presence.close();
		isolation.restore();
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(runtimeDir, { recursive: true, force: true });
		await fs.rm(startupProject, { recursive: true, force: true });
	}
}, 30000);
