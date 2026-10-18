/**
 * WHY THIS SUITE EXISTS.
 * The broker can confuse a live orphan or a healthy listener on a reused PID
 * with the child it started, then restart into EADDRINUSE. These tests drive
 * broker recovery and real child processes to pin PID-plus-start identity,
 * configured HTTP health, and the restart delay. They do not test native
 * descendant discovery or services that provide no readiness target.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getProcessStartIdentity, getProcessStartTime } from "@veyyon/utils/process-liveness";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { managedDaemonDir, managedDaemonMetaPath } from "../../src/launch/paths";
import type { DaemonSnapshot, DaemonSpec } from "../../src/launch/protocol";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-launch-owner-identity-tests");
let testRoot = "";
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupDirs: string[] = [];
const cleanupChildren: Bun.Subprocess[] = [];
const cleanupServers: http.Server[] = [];

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "suite-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-owner-identity");
});

afterEach(async () => {
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
	while (cleanupChildren.length > 0) {
		const child = cleanupChildren.pop();
		if (!child) continue;
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	while (cleanupServers.length > 0) {
		const server = cleanupServers.pop();
		if (!server?.listening) continue;
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

afterAll(async () => {
	if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(testRoot, prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(50);
	}
	return condition();
}

async function connect(projectDir: string, runtimeDir: string): Promise<DaemonBrokerClient> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 10_000 });
	cleanupClients.push(client);
	return client;
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// The broker may have already stopped after the last request.
	}
	client.close();
}

async function reservePort(): Promise<number> {
	const server = http.createServer();
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP server did not expose its bound port");
	const port = address.port;
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	return port;
}

async function startHealthServer(status: number): Promise<{ port: number; server: http.Server }> {
	const server = http.createServer((request, response) => {
		if (request.url === "/health") {
			response.writeHead(status);
			response.end("health");
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Health server did not expose its bound port");
	cleanupServers.push(server);
	return { port: address.port, server };
}

async function healthStatus(port: number): Promise<number | undefined> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
		await response.body?.cancel();
		return response.status;
	} catch {
		return undefined;
	}
}

async function startOwnedHealthProcess(port: number, status = 200): Promise<Bun.Subprocess> {
	const source = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.VEYYON_TEST_PORT), fetch(request) { const path = new URL(request.url).pathname; return new Response(path === "/health" ? "health" : "missing", { status: path === "/health" ? Number(process.env.VEYYON_TEST_STATUS) : 404 }); } });`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		env: { VEYYON_TEST_PORT: String(port), VEYYON_TEST_STATUS: String(status) },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanupChildren.push(child);
	return child;
}


function daemonSpec(
	name: string,
	projectDir: string,
	port: number,
	options: { detached?: boolean; restart?: DaemonSpec["restart"]; ready?: boolean } = {},
): DaemonSpec {
	const ready =
		options.ready === false
			? undefined
			: {
					port,
					host: "127.0.0.1",
					timeoutMs: 2_000,
					// The baseline parser drops this field, which leaves recovery without an HTTP health target.
					healthPath: "/health",
				};
	return {
		name,
		application: process.execPath,
		args: [],
		env: {},
		cwd: projectDir,
		pty: false,
		ready,
		restart: options.restart ?? "always",
		persist: options.detached ?? true,
		detached: options.detached ?? true,
	};
}

async function seedRecoveredDaemon(
	runtimeDir: string,
	projectDir: string,
	name: string,
	port: number,
	pid: number,
	processStartIdentity: string,
	processStartTime: number,
): Promise<void> {
	const dir = managedDaemonDir(runtimeDir, name);
	await fs.mkdir(dir, { recursive: true });
	const now = Date.now();
	const spec = daemonSpec(name, projectDir, port, { detached: true });
	const snapshot: DaemonSnapshot = {
		name,
		id: `seed-${name}`,
		state: "ready",
		pid,
		createdAt: now - 5_000,
		startedAt: now - 4_000,
		readyAt: now - 3_000,
		restartCount: 0,
		outputBytes: 0,
		owner: "test-seed",
		persist: true,
		detached: true,
	};
	await fs.writeFile(
		managedDaemonMetaPath(dir),
		JSON.stringify({ daemon: snapshot, spec, processStartIdentity, processStartTime }),
		"utf8",
	);
}

async function describeDaemon(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const result = await client.request({ op: "describe", name });
	if (result.op !== "describe") throw new Error(`Expected describe result, got ${result.op}`);
	return result.daemon;
}

describe("daemon restart needs owner identity and health", () => {
	it("keeps the same healthy detached child after broker recovery", async () => {
		const projectDir = await tempDir("project-owned-orphan-");
		const runtimeDir = await tempDir("runtime-owned-orphan-");
		const port = await reservePort();
		const child = await startOwnedHealthProcess(port);
		const listening = await waitUntil(() => healthStatus(port).then(status => status === 200), 5_000);
		expect(listening).toBeTrue();
		const identity = getProcessStartIdentity(child.pid);
		const startTime = getProcessStartTime(child.pid);
		if (identity === null || startTime === null) throw new Error("The platform did not provide a process-start identity and creation time");
		await seedRecoveredDaemon(runtimeDir, projectDir, "owned-orphan", port, child.pid, identity, startTime);
		const client = await connect(projectDir, runtimeDir);

		try {
			const daemon = await describeDaemon(client, "owned-orphan");
			expect(daemon.state).toBe("ready");
			expect(daemon.pid).toBe(child.pid);
			expect(await healthStatus(port)).toBe(200);
			const metadata = JSON.parse(await fs.readFile(managedDaemonMetaPath(managedDaemonDir(runtimeDir, "owned-orphan")), "utf8")) as {
				processStartIdentity?: string;
				processStartTime?: number;
			};
			expect(metadata.processStartIdentity).toBe(identity);
			expect(metadata.processStartTime).toBe(startTime);
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("does not adopt or kill a healthy listener when the recorded PID incarnation differs", async () => {
		const projectDir = await tempDir("project-reused-pid-");
		const runtimeDir = await tempDir("runtime-reused-pid-");
		const port = await reservePort();
		const child = await startOwnedHealthProcess(port);
		const listening = await waitUntil(() => healthStatus(port).then(status => status === 200), 5_000);
		expect(listening).toBeTrue();
		const identity = getProcessStartIdentity(child.pid);
		const startTime = getProcessStartTime(child.pid);
		if (identity === null || startTime === null) throw new Error("The platform did not provide a process-start identity and creation time");
		await seedRecoveredDaemon(runtimeDir, projectDir, "reused-pid", port, child.pid, `${identity}:stale`, startTime);
		const client = await connect(projectDir, runtimeDir);

		try {
			const daemon = await describeDaemon(client, "reused-pid");
			expect(daemon.state).toBe("failed");
			expect(daemon.exitReason).toContain("identity");
			expect(await healthStatus(port)).toBe(200);
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("does not adopt or kill a healthy listener when the recorded creation time differs", async () => {
		const projectDir = await tempDir("project-stale-start-time-");
		const runtimeDir = await tempDir("runtime-stale-start-time-");
		const port = await reservePort();
		const child = await startOwnedHealthProcess(port);
		const listening = await waitUntil(() => healthStatus(port).then(status => status === 200), 5_000);
		expect(listening).toBeTrue();
		const identity = getProcessStartIdentity(child.pid);
		const startTime = getProcessStartTime(child.pid);
		if (identity === null || startTime === null) throw new Error("The platform did not provide a process-start identity and creation time");
		await seedRecoveredDaemon(runtimeDir, projectDir, "stale-start-time", port, child.pid, identity, startTime + 1);
		const client = await connect(projectDir, runtimeDir);

		try {
			const daemon = await describeDaemon(client, "stale-start-time");
			expect(daemon.state).toBe("failed");
			expect(daemon.exitReason).toContain("creation time");
			expect(await healthStatus(port)).toBe(200);
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("stops EADDRINUSE retries when an unowned configured health target is already healthy", async () => {
		const projectDir = await tempDir("project-eaddrinuse-");
		const runtimeDir = await tempDir("runtime-eaddrinuse-");
		const target = await startHealthServer(200);
		const attemptsPath = path.join(projectDir, "attempts.log");
		const source = [
			'const fs = require("node:fs");',
			'fs.appendFileSync(process.env.VEYYON_ATTEMPTS_FILE, "spawn\\n");',
			'const net = require("node:net");',
			'const server = net.createServer();',
			'server.once("error", error => { fs.appendFileSync(process.env.VEYYON_ATTEMPTS_FILE, `${error.code}\\n`); process.exit(1); });',
			'server.listen(Number(process.env.VEYYON_TEST_PORT), "127.0.0.1");',
		].join("\n");
		const client = await connect(projectDir, runtimeDir);

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "occupied-port",
					application: process.execPath,
					args: ["-e", source],
					env: { VEYYON_TEST_PORT: String(target.port), VEYYON_ATTEMPTS_FILE: attemptsPath },
					cwd: projectDir,
					pty: false,
					ready: { log: "OWNED_READY", port: target.port, host: "127.0.0.1", healthPath: "/health", timeoutMs: 2_000 },
					restart: "always",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");
			const hitEaddrinuse = await waitUntil(async () => {
				const attempts = await fs.readFile(attemptsPath, "utf8").catch(() => "");
				return attempts.includes("EADDRINUSE");
			}, 5_000);
			expect(hitEaddrinuse).toBeTrue();
			const stopped = await waitUntil(async () => (await describeDaemon(client, "occupied-port")).state === "failed", 3_000);
			expect(stopped).toBeTrue();
			await delay(1_200);
			const daemon = await describeDaemon(client, "occupied-port");
			expect(daemon.state).toBe("failed");
			expect(daemon.restartCount).toBe(0);
			const attempts = await fs.readFile(attemptsPath, "utf8");
			expect(attempts.match(/^spawn$/gm)?.length).toBe(1);
			expect(await healthStatus(target.port)).toBe(200);
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("holds the restart count during the first backoff window for rapid failures", async () => {
		const projectDir = await tempDir("project-fast-exit-");
		const runtimeDir = await tempDir("runtime-fast-exit-");
		const client = await connect(projectDir, runtimeDir);

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "fast-exit",
					application: process.execPath,
					args: ["-e", "process.exit(1)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");
			const enteredBackoff = await waitUntil(async () => (await describeDaemon(client, "fast-exit")).state === "restarting", 5_000);
			expect(enteredBackoff).toBeTrue();
			const first = await describeDaemon(client, "fast-exit");
			await delay(250);
			const stillWaiting = await describeDaemon(client, "fast-exit");
			expect(stillWaiting.restartCount).toBe(first.restartCount);
			const restarted = await waitUntil(async () => (await describeDaemon(client, "fast-exit")).restartCount > first.restartCount, 3_000);
			expect(restarted).toBeTrue();
			await client.request({ op: "stop", name: "fast-exit", timeoutMs: 2_000 });
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});
