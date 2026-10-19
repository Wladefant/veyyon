/**
 * WHY THIS SUITE EXISTS.
 *
 * Class: a daemon's descendant outlives the process the broker tracks and keeps a TCP port.
 * The broker signalled only the root pid. A stop or restart could therefore leave the port
 * holder alive, and the next generation failed with EADDRINUSE on every automatic restart.
 * A wrapper that exited while its child kept the daemon's inherited pipes open also stalled
 * settlement, because the broker waited for stream closure instead of process death.
 *
 * This suite drives the production broker over its real socket. The daemon is a wrapper run by
 * the Bun executable. It spawns a grandchild Bun process that holds a real loopback TCP port.
 * The grandchild writes a ready file only after it is listening. The wrapper stays alive for
 * 500ms after that, so the broker's descendant sampler can observe it. Each test asserts
 * observable effects only: port release, pid death, the logged restart delay, and spawn
 * timestamps and serialized state. It proves five things:
 *   1. Stop with a live root frees the port and kills the grandchild.
 *   2. Restart with a live root kills the old holder before the new generation spawns.
 *   3. Concurrent explicit restarts serialize, leave one live holder, preserve port access,
 *      and do not increment the automatic restart count.
 *   4. An automatic restart after a wrapper exits (inherited or detached stdio) never spawns
 *      while the old holder is live.
 *   5. A daemon that cannot bind an occupied port backs off on the logged exponential
 *      schedule (2000ms, then 4000ms) and never hot-loops.
 *
 * WHAT IT DOES NOT CATCH:
 * - Escaping descendants observed before sampling. A descendant that detaches and re-parents
 *   entirely inside one sampler interval, before the broker's sampler sees it, cannot be
 *   tracked. The 500ms hold keeps the wrapper alive long enough for the sampler to capture a
 *   detached child that is already listening. A descendant that escapes faster than that is
 *   outside what this suite proves.
 * - The held case: teardown cannot prove the tree dead within its bound. On Unix a grandchild
 *   cannot be made to survive SIGKILL inside a test, so this suite asserts nothing about the
 *   held state, the restart line, or spawn timing for it. That case needs a teardown-bound
 *   seam the broker does not expose.
 * - The binder regression also covers an immediate failure with no descendant: the first
 *   spawn fails with EADDRINUSE, then the timestamp file and exact 2000ms/4000ms logged
 *   schedule prove that a fast root exit settles and retries without hot-looping.
 * - The 30000ms backoff cap. Reaching it needs about 30s of consecutive failures. The suite
 *   asserts only that every logged delay stays at or below the cap and that the first two
 *   match the schedule. The exponential formula itself is covered by the utils backoff tests.
 * - Windows-specific tree termination beyond observable port release and pid death.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getProcessStartIdentity, isToolCallProcessAlive } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import type { DaemonSpec } from "../../src/launch/protocol";

const TEST_PARENT = path.join(os.tmpdir(), "veyyon-launch-port-tree-tests");
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 90_000;

// Wrapper daemon. It spawns a grandchild holder and records its pid. Modes:
//   "keep"            stays alive until a stdin line arrives or the broker stops it.
//   "exit-inherit"    waits for the holder's ready file, stays 500ms, then exits with the
//                     holder still running on inherited stdio.
//   "exit-detached"   as above, with a detached holder and ignored stdio.
// The ready file is removed before spawning, so a later generation cannot see a stale signal.
const ROOT_FIXTURE = [
	'import { spawn } from "node:child_process";',
	'import * as fs from "node:fs";',
	'import { setTimeout as delay } from "node:timers/promises";',
	"",
	"const [holderScript, port, pidFile, mode, readyFile] = process.argv.slice(2);",
	"fs.rmSync(readyFile, { force: true });",
	'const detached = mode === "exit-detached";',
	"const child = spawn(process.execPath, [holderScript, port, readyFile], {",
	'\tstdio: detached ? "ignore" : "inherit",',
	"\tdetached,",
	"\twindowsHide: true,",
	"});",
	'fs.appendFileSync(pidFile, String(child.pid) + "\\n");',
	'process.stdout.write("root recorded holder " + String(child.pid) + "\\n");',
	'if (mode === "keep") {',
	'\tprocess.stdin.once("data", () => process.exit(0));',
	"\tprocess.stdin.resume();",
	"} else {",
	"\tfor (let i = 0; i < 250 && !fs.existsSync(readyFile); i++) await delay(20);",
	"\tawait delay(500);",
	"\tchild.unref();",
	"\tprocess.exit(0);",
	"}",
	"",
].join("\n");

// Grandchild holder. It binds a real loopback TCP port, writes the ready file once it is
// listening, and keeps the port until killed.
const HOLDER_FIXTURE = [
	'import * as fs from "node:fs";',
	'import * as net from "node:net";',
	"",
	"const [port, readyFile] = process.argv.slice(2);",
	"const server = net.createServer(() => {});",
	'server.on("error", error => {',
	'\tprocess.stdout.write("holder listen error " + String(error.code) + "\\n");',
	"\tprocess.exit(3);",
	"});",
	'server.listen(Number(port), "127.0.0.1", () => {',
	'\tfs.writeFileSync(readyFile, "listening");',
	"});",
	"",
].join("\n");

// Binder daemon: records each spawn timestamp, then tries to bind; exits 1 on listen error.
const BINDER_FIXTURE = [
	'import * as fs from "node:fs";',
	'import * as net from "node:net";',
	"",
	"const [port, spawnLog] = process.argv.slice(2);",
	'fs.appendFileSync(spawnLog, String(Date.now()) + "\\n");',
	"const server = net.createServer(() => {});",
	'server.on("error", error => {',
	'\tprocess.stdout.write("listen failed " + String(error.code) + "\\n");',
	"\tprocess.exit(1);",
	"});",
	'server.listen(Number(port), "127.0.0.1");',
	"",
].join("\n");

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
let testRoot = "";
let rootScript = "";
let holderScript = "";
let binderScript = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
	rootScript = path.join(testRoot, "root.mjs");
	holderScript = path.join(testRoot, "holder.mjs");
	binderScript = path.join(testRoot, "binder.mjs");
	await fs.writeFile(rootScript, ROOT_FIXTURE, "utf8");
	await fs.writeFile(holderScript, HOLDER_FIXTURE, "utf8");
	await fs.writeFile(binderScript, BINDER_FIXTURE, "utf8");
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-port-tree");
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupServers: net.Server[] = [];
// Pids read from our own fixture pid files, mapped to their start identity at first sight.
// The identity guards against signalling a reused pid. Only these pids are ever signalled.
const spawnedPids = new Map<number, string | null>();

afterEach(async () => {
	while (cleanupClients.length > 0) {
		const client = cleanupClients.pop();
		if (!client) continue;
		try {
			await client.request({ op: "shutdown" });
		} catch {
			// broker may already be gone
		}
		client.close();
	}
	for (const pid of spawnedPids.keys()) {
		if (!isAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// exited between the liveness check and the kill
		}
	}
	spawnedPids.clear();
	while (cleanupServers.length > 0) cleanupServers.pop()?.close();
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

/** Liveness that treats a Linux zombie as dead and rejects a pid whose start identity changed. */
function isAlive(pid: number): boolean {
	return isToolCallProcessAlive(pid, spawnedPids.get(pid) ?? null);
}

/** A loopback port number that nothing listens on at the moment of the call. */
function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			reject(new Error("probe server has no TCP address"));
			return;
		}
		const port = address.port;
		server.close(() => resolve(port));
	});
	return promise;
}

/** Hold a loopback port from outside the daemon. The caller's cleanup closes it. */
function occupyPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	cleanupServers.push(server);
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			reject(new Error("occupant server has no TCP address"));
			return;
		}
		resolve(address.port);
	});
	return promise;
}

/** True when something accepts a TCP connection on the loopback port within one second. */
function acceptsConnection(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: "127.0.0.1", port });
	const finish = (open: boolean): void => {
		socket.destroy();
		resolve(open);
	};
	socket.setTimeout(1_000, () => finish(false));
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	return promise;
}

/** True when this process can bind the loopback port, meaning no live holder owns it. */
function canBind(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const server = net.createServer();
	server.once("error", () => resolve(false));
	server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	return promise;
}

async function readNumbers(filePath: string): Promise<number[]> {
	const text = await fs.readFile(filePath, "utf8").catch(() => "");
	const numbers = text
		.split("\n")
		.map(line => Number(line.trim()))
		.filter(value => Number.isSafeInteger(value) && value > 0);
	for (const value of numbers) {
		if (!spawnedPids.has(value)) spawnedPids.set(value, getProcessStartIdentity(value));
	}
	return numbers;
}

async function logText(client: DaemonBrokerClient, name: string): Promise<string> {
	const result = await client.request({ op: "logs", name, lines: 1000, head: false, follow: false, timeoutMs: 1_000 });
	if (result.op !== "logs") throw new Error(`expected logs result, got ${result.op}`);
	return result.text;
}

/** Delays the broker logged in its restart lines, in order. */
function restartDelays(text: string): number[] {
	return [...text.matchAll(/restarting in (\d+)ms/g)].map(match => Number(match[1]));
}

function wrapperSpec(name: string, projectDir: string, args: string[], restart: DaemonSpec["restart"]): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args,
		env: {},
		cwd: projectDir,
		pty: false,
		restart,
		persist: false,
		detached: false,
	};
}

async function startWrapper(
	client: DaemonBrokerClient,
	name: string,
	projectDir: string,
	args: string[],
	restart: DaemonSpec["restart"],
): Promise<void> {
	const started = await client.request({ op: "start", spec: wrapperSpec(name, projectDir, args, restart) });
	expect(started.op).toBe("start");
}

async function stopQuietly(client: DaemonBrokerClient, name: string): Promise<void> {
	try {
		await client.request({ op: "stop", name, timeoutMs: 5_000 });
	} catch {
		// already terminal, or the broker is shutting down
	}
}

describe("a restart waits for the port-owning process tree", () => {
	it(
		"stop with a live root frees the port held by the grandchild and kills it",
		async () => {
			const projectDir = await tempDir("project-stop-");
			const runtimeDir = await tempDir("runtime-stop-");
			const pidFile = path.join(projectDir, "holder-pids.txt");
			const readyFile = path.join(projectDir, "holder-ready.txt");
			const port = await freePort();
			const client = await connect(projectDir, runtimeDir);

			await startWrapper(
				client,
				"holder-stop",
				projectDir,
				[rootScript, holderScript, String(port), pidFile, "keep", readyFile],
				"no",
			);
			expect(await waitUntil(() => acceptsConnection(port), WAIT_MS)).toBeTrue();
			const [holderPid] = await readNumbers(pidFile);
			expect(holderPid).toBeDefined();

			const stopped = await client.request({ op: "stop", name: "holder-stop", timeoutMs: 5_000 });
			expect(stopped.op).toBe("stop");
			if (stopped.op === "stop") expect(stopped.daemon.state).toBe("exited");

			expect(await waitUntil(() => !isAlive(holderPid as number), WAIT_MS)).toBeTrue();
			expect(await waitUntil(() => canBind(port), WAIT_MS)).toBeTrue();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"restart with a live root kills the old holder before the next generation records its pid",
		async () => {
			const projectDir = await tempDir("project-restart-");
			const runtimeDir = await tempDir("runtime-restart-");
			const pidFile = path.join(projectDir, "holder-pids.txt");
			const readyFile = path.join(projectDir, "holder-ready.txt");
			const port = await freePort();
			const client = await connect(projectDir, runtimeDir);

			await startWrapper(
				client,
				"holder-restart",
				projectDir,
				[rootScript, holderScript, String(port), pidFile, "keep", readyFile],
				"no",
			);
			expect(await waitUntil(() => acceptsConnection(port), WAIT_MS)).toBeTrue();
			const [firstPid] = await readNumbers(pidFile);
			expect(firstPid).toBeDefined();

			const restarted = await client.request({ op: "restart", name: "holder-restart" });
			expect(restarted.op).toBe("restart");

			expect(await waitUntil(async () => (await readNumbers(pidFile)).length >= 2, WAIT_MS)).toBeTrue();
			const pids = await readNumbers(pidFile);
			const secondPid = pids[1] as number;
			expect(secondPid).not.toBe(firstPid);
			// The new root wrote its pid only after the old holder was dead.
			expect(isAlive(firstPid as number)).toBeFalse();

			expect(await waitUntil(() => acceptsConnection(port), WAIT_MS)).toBeTrue();
			expect(isAlive(secondPid)).toBeTrue();
			expect(await logText(client, "holder-restart")).not.toContain("holder listen error");
			await stopQuietly(client, "holder-restart");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"serializes concurrent restarts so only the final generation keeps the port",
		async () => {
			const projectDir = await tempDir("project-concurrent-restart-");
			const runtimeDir = await tempDir("runtime-concurrent-restart-");
			const pidFile = path.join(projectDir, "holder-pids.txt");
			const readyFile = path.join(projectDir, "holder-ready.txt");
			const port = await freePort();
			const client = await connect(projectDir, runtimeDir);
			const name = "holder-concurrent-restart";

			await startWrapper(
				client,
				name,
				projectDir,
				[rootScript, holderScript, String(port), pidFile, "keep", readyFile],
				"no",
			);
			try {
				expect(await waitUntil(() => acceptsConnection(port), WAIT_MS)).toBeTrue();
				const initialPids = await readNumbers(pidFile);
				expect(initialPids).toHaveLength(1);

				const results = await Promise.all([
					client.request({ op: "restart", name }),
					client.request({ op: "restart", name }),
				]);
				expect(results.map(result => result.op)).toEqual(["restart", "restart"]);
				expect(await waitUntil(() => acceptsConnection(port), WAIT_MS)).toBeTrue();
				const snapshot = await client.request({ op: "describe", name });
				expect(snapshot.op).toBe("describe");
				if (snapshot.op === "describe") {
					expect(snapshot.daemon.state).toBe("running");
					expect(snapshot.daemon.restartCount).toBe(0);
				}
				const pids = await readNumbers(pidFile);
				expect(pids.length).toBeGreaterThanOrEqual(2);
				expect(pids.length).toBeLessThanOrEqual(3);
				const livingPids = pids.filter(pid => isAlive(pid));
				expect(livingPids).toHaveLength(1);
				expect(livingPids[0]).not.toBe(initialPids[0]);
				expect(await acceptsConnection(port)).toBeTrue();
				expect(await logText(client, name)).not.toContain("holder listen error");
			} finally {
				await stopQuietly(client, name);
			}
		},
		TEST_TIMEOUT_MS,
	);


	it.each(["exit-inherit", "exit-detached"] as const)(
		"automatic restart after a %s wrapper never spawns while the old holder is alive",
		async mode => {
			const projectDir = await tempDir(`project-auto-${mode}-`);
			const runtimeDir = await tempDir(`runtime-auto-${mode}-`);
			const pidFile = path.join(projectDir, "holder-pids.txt");
			const readyFile = path.join(projectDir, "holder-ready.txt");
			const port = await freePort();
			const client = await connect(projectDir, runtimeDir);
			const name = `holder-auto-${mode}`;

			await startWrapper(
				client,
				name,
				projectDir,
				[rootScript, holderScript, String(port), pidFile, mode, readyFile],
				"always",
			);
			try {
				expect(await waitUntil(async () => (await readNumbers(pidFile)).length >= 2, WAIT_MS)).toBeTrue();
				const pids = await readNumbers(pidFile);
				// The first holder was dead when the second generation recorded its pid.
				expect(pids[1]).not.toBe(pids[0]);
				expect(isAlive(pids[0] as number)).toBeFalse();

				const text = await logText(client, name);
				expect(text).not.toContain("holder listen error");
				expect(restartDelays(text)[0]).toBe(2_000);
			} finally {
				await stopQuietly(client, name);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a daemon that cannot bind an occupied port backs off on the logged schedule without hot-looping",
		async () => {
			const projectDir = await tempDir("project-eaddrinuse-");
			const runtimeDir = await tempDir("runtime-eaddrinuse-");
			const spawnLog = path.join(projectDir, "spawns.txt");
			const port = await occupyPort();
			const client = await connect(projectDir, runtimeDir);
			const name = "binder";

			await startWrapper(client, name, projectDir, [binderScript, String(port), spawnLog], "always");
			try {
				// Three spawns mean two failures and two logged restart delays.
				const stamp = async (): Promise<number[]> => {
					const text = await fs.readFile(spawnLog, "utf8").catch(() => "");
					return text
						.split("\n")
						.map(line => Number(line.trim()))
						.filter(value => Number.isSafeInteger(value) && value > 0);
				};
				expect(await waitUntil(async () => (await stamp()).length >= 3, WAIT_MS)).toBeTrue();
				const stamps = await stamp();
				const text = await logText(client, name);
				const delays = restartDelays(text);

				expect(text).toContain("listen failed EADDRINUSE");
				// First two failures: attempt 1 gives 1000 * 2 = 2000, attempt 2 gives 4000.
				expect(delays.slice(0, 2)).toEqual([2_000, 4_000]);
				expect(delays.every(logged => logged > 0 && logged <= 30_000)).toBeTrue();
				// The broker starts the timer after the exit, so each gap is at least the logged delay.
				expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(delays[0] as number);
				expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(delays[1] as number);
			} finally {
				await stopQuietly(client, name);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
