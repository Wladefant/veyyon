import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { getProcessStartTime } from "@veyyon/utils/process-liveness";
import {
	acquireBrokerLease,
	type BrokerLease,
	type BrokerLeaseClock,
	releaseBrokerLease,
} from "../../src/launch/broker-lease";
import { daemonBrokerEndpoint, daemonBrokerLeasePath, daemonBrokerTokenPath } from "../../src/launch/paths";
import { hasLiveDaemonProjectPresence, pruneDeadDaemonRuntimeDirs } from "../../src/launch/presence";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const STALE = new Date(Date.now() - 30 * 60_000);
let deadPid = 0;

async function scope(
	root: string,
	name: string,
	init: { pid?: number | "dead"; clients?: number[]; stale?: boolean },
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(path.join(dir, "clients"), { recursive: true });
	if (init.pid !== undefined) {
		const pid = init.pid === "dead" ? deadPid : init.pid;
		await Bun.write(path.join(dir, "broker.pid"), JSON.stringify({ pid, instanceId: name }));
	}
	for (const clientPid of init.clients ?? []) {
		await Bun.write(
			path.join(dir, "clients", `${clientPid}-x.json`),
			JSON.stringify({ pid: clientPid, id: `${clientPid}-x`, projectDir: dir }),
		);
	}
	if (init.stale) await fs.utimes(dir, STALE, STALE);
	return dir;
}

interface LiveChildEndpoint {
	pid: number;
	startedAt: number;
	close: () => Promise<void>;
	waitForPing: () => Promise<void>;
	proceedPing: () => void;
}

async function spawnChildEndpointListener(
	runtimeDir: string,
	options: {
		token?: string;
		gatePing?: boolean;
	} = {},
): Promise<LiveChildEndpoint> {
	const { env, cleanup } = hermeticSpawnEnv();
	const token = options.token ?? "test-token";
	const gatePing = options.gatePing ?? false;
	const endpoint = daemonBrokerEndpoint(runtimeDir);
	const childScript = `
import * as net from "node:net";

const endpoint = process.env.CHILD_ENDPOINT!;
const token = process.env.CHILD_TOKEN!;
const gatePing = process.env.CHILD_GATE_PING === "1";

let onProceed: (() => void) | null = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (chunk.includes("proceed") && onProceed) {
		const cb = onProceed;
		onProceed = null;
		cb();
	}
});

const server = net.createServer((socket) => {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffered += chunk;
		const idx = buffered.indexOf("\\n");
		if (idx < 0) return;
		const line = buffered.slice(0, idx);
		buffered = buffered.slice(idx + 1);
		try {
			const req = JSON.parse(line);
			if (req.token === token) {
				const send = () => {
					socket.write(
						JSON.stringify({
							id: req.id,
							ok: true,
							result: { op: "ping", pid: process.pid, projectDir: "/p" },
						}) + "\\n",
					);
				};
				if (gatePing) {
					onProceed = send;
					process.stdout.write("ping\\n");
				} else {
					send();
				}
			} else {
				socket.write(JSON.stringify({ id: req.id, ok: false }) + "\\n");
			}
		} catch {
			socket.destroy();
		}
	});
});

server.listen(endpoint, () => {
	process.stdout.write("ready\\n");
});

process.stdin.on("end", () => {
	server.close(() => process.exit(0));
});
`;

	const child = Bun.spawn([process.execPath, "-e", childScript], {
		env: {
			...env,
			CHILD_ENDPOINT: endpoint,
			CHILD_TOKEN: token,
			CHILD_GATE_PING: gatePing ? "1" : "0",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});

	const reader = child.stdout.getReader();
	let streamBuf = "";
	const readUntil = async (target: string): Promise<void> => {
		while (!streamBuf.includes(target)) {
			const { value, done } = await reader.read();
			if (done) break;
			streamBuf += new TextDecoder().decode(value);
		}
		const idx = streamBuf.indexOf(target);
		if (idx >= 0) {
			streamBuf = streamBuf.slice(idx + target.length);
		}
	};
	await readUntil("ready\n");

	const startedAt = getProcessStartTime(child.pid);
	if (startedAt === null) {
		child.kill();
		await child.exited;
		reader.releaseLock();
		cleanup();
		throw new Error("Child process start time unavailable");
	}

	const waitForPing = async (): Promise<void> => {
		await readUntil("ping\n");
	};

	const proceedPing = (): void => {
		child.stdin.write("proceed\n");
		child.stdin.flush();
	};

	const close = async () => {
		try {
			child.stdin.end();
		} catch {}
		child.kill("SIGTERM");
		await child.exited;
		reader.releaseLock();
		cleanup();
	};

	return {
		pid: child.pid,
		startedAt,
		close,
		waitForPing,
		proceedPing,
	};
}

async function spawnLiveChild(): Promise<{ pid: number; startedAt: number; close: () => Promise<void> }> {
	const { env, cleanup } = hermeticSpawnEnv();
	const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("up\\n"); process.stdin.resume()'], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = child.stdout.getReader();
	await reader.read();
	reader.releaseLock();
	const startedAt = getProcessStartTime(child.pid);
	if (startedAt === null) {
		child.kill();
		await child.exited;
		cleanup();
		throw new Error("Child process start time unavailable");
	}
	return {
		pid: child.pid,
		startedAt,
		close: async () => {
			child.kill("SIGTERM");
			await child.exited;
			cleanup();
		},
	};
}

async function spawnDeadChild(): Promise<number> {
	const { env, cleanup } = hermeticSpawnEnv();
	const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		env,
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited;
	cleanup();
	return proc.pid;
}

interface LiveClientRegistrationProcess {
	pid: number;
	register: () => void;
	waitForAttempting: () => Promise<void>;
	waitForRegistered: () => Promise<void>;
	queryStatus: () => Promise<"waiting" | "registered">;
	close: () => Promise<void>;
}

async function spawnClientRegistrationProcess(
	projectDir: string,
	runtimeDir: string,
): Promise<LiveClientRegistrationProcess> {
	const { env, cleanup } = hermeticSpawnEnv();
	const childScript = `
import { registerDaemonProjectPresence } from "./packages/coding-agent/src/launch/presence";
import { daemonBrokerLeasePath } from "./packages/coding-agent/src/launch/paths";
import { tryWithFileLock } from "@veyyon/utils/file-lock";

let presenceHandle = null;
const projectDir = ${JSON.stringify(projectDir)};
const runtimeDir = ${JSON.stringify(runtimeDir)};
process.stdin.on("data", async (chunk) => {
	if (chunk.includes("register")) {
		process.stdout.write("attempting\\n");
		try {
			presenceHandle = await registerDaemonProjectPresence(projectDir, runtimeDir);
			const probe = await tryWithFileLock(daemonBrokerLeasePath(runtimeDir), async () => true);
			if (!probe.acquired) {
				process.stdout.write("contention_violation:completed_while_lock_held\\n");
			} else {
				process.stdout.write("registered\\n");
			}
		} catch (err) {
			process.stdout.write("error:" + String(err) + "\\n");
		}
	}
	if (chunk.includes("status")) {
		process.stdout.write(presenceHandle !== null ? "status:registered\\n" : "status:waiting\\n");
	}
	if (chunk.includes("close")) {
		try {
			if (presenceHandle) {
				await presenceHandle.close();
				presenceHandle = null;
			}
		} catch {}
		process.stdout.write("closed\\n");
		process.exit(0);
	}
});

process.stdout.write("ready\\n");
`;

	const child = Bun.spawn([process.execPath, "-e", childScript], {
		env: {
			...env,
			CHILD_PROJECT_DIR: projectDir,
			CHILD_RUNTIME_DIR: runtimeDir,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});

	const reader = child.stdout.getReader();
	let streamBuf = "";
	const readUntil = async (target: string): Promise<void> => {
		while (!streamBuf.includes(target)) {
			const { value, done } = await reader.read();
			if (done) break;
			streamBuf += new TextDecoder().decode(value);
		}
		const idx = streamBuf.indexOf(target);
		if (idx >= 0) {
			streamBuf = streamBuf.slice(idx + target.length);
		}
	};

	await readUntil("ready\n");

	const register = (): void => {
		child.stdin.write("register\n");
		child.stdin.flush();
	};

	const waitForAttempting = async (): Promise<void> => {
		await readUntil("attempting\n");
	};

	const waitForRegistered = async (): Promise<void> => {
		while (
			!streamBuf.includes("registered\n") &&
			!streamBuf.includes("contention_violation:") &&
			!streamBuf.includes("error:")
		) {
			const { value, done } = await reader.read();
			if (done) break;
			streamBuf += new TextDecoder().decode(value);
		}
		if (streamBuf.includes("error:")) {
			throw new Error("Child process registration failed: " + streamBuf);
		}
		if (streamBuf.includes("contention_violation:")) {
			throw new Error(
				"Client registration did not participate in broker transition lock (completed while lock held)",
			);
		}
		if (!streamBuf.includes("registered\n")) {
			throw new Error("Child process exited without registering: " + streamBuf);
		}
		const idx = streamBuf.indexOf("registered\n");
		streamBuf = streamBuf.slice(idx + "registered\n".length);
	};

	const queryStatus = async (): Promise<"waiting" | "registered"> => {
		child.stdin.write("status\n");
		child.stdin.flush();
		while (!streamBuf.includes("status:waiting\n") && !streamBuf.includes("status:registered\n")) {
			const { value, done } = await reader.read();
			if (done) break;
			streamBuf += new TextDecoder().decode(value);
		}
		if (streamBuf.includes("status:waiting\n")) {
			const idx = streamBuf.indexOf("status:waiting\n");
			streamBuf = streamBuf.slice(idx + "status:waiting\n".length);
			return "waiting";
		}
		if (streamBuf.includes("status:registered\n")) {
			const idx = streamBuf.indexOf("status:registered\n");
			streamBuf = streamBuf.slice(idx + "status:registered\n".length);
			return "registered";
		}
		throw new Error("Unexpected status response: " + streamBuf);
	};

	const close = async (): Promise<void> => {
		try {
			child.stdin.write("close\n");
			child.stdin.flush();
			child.stdin.end();
		} catch {}
		try {
			child.kill("SIGTERM");
			await child.exited;
		} catch {}
		reader.releaseLock();
		cleanup();
	};

	return {
		pid: child.pid,
		register,
		waitForAttempting,
		waitForRegistered,
		queryStatus,
		close,
	};
}

describe("pruneDeadDaemonRuntimeDirs", () => {
	beforeAll(async () => {
		// A definitely-dead PID: spawn a short-lived process and reap it.
		const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
			env: { ...process.env, HOME: "/dev/null" },
		});
		await proc.exited;
		deadPid = proc.pid;
	});

	it("removes only scopes with a dead broker, no live clients, and past the stale grace", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });

		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true });
		await scope(daemons, "dddddddddddddddd", { clients: [process.pid], stale: true });
		await scope(daemons, "eeeeeeeeeeeeeeee", { pid: "dead" });
		// Machine-global daemon container must never be swept as a project scope.
		await fs.mkdir(path.join(daemons, "global", "some-service"), { recursive: true });
		await fs.utimes(path.join(daemons, "global"), STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		const remaining = new Set(await fs.readdir(daemons));
		expect(remaining.has("bbbbbbbbbbbbbbbb")).toBe(false); // pruned
		expect(remaining.has("aaaaaaaaaaaaaaaa")).toBe(true); // never prunes itself
		expect(remaining.has("cccccccccccccccc")).toBe(true); // live broker
		expect(remaining.has("dddddddddddddddd")).toBe(true); // live client presence
		expect(remaining.has("eeeeeeeeeeeeeeee")).toBe(true); // within stale grace
		expect(remaining.has("global")).toBe(true); // non-scope name skipped
	});

	it("does not sweep sibling machine-global service runtimes", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-global-");
		const globalRoot = path.join(tempDir.path(), "run", "daemons", "global");
		const current = await scope(globalRoot, "current-service", { pid: "dead", stale: true });
		const sibling = await scope(globalRoot, "persistent-service", { pid: "dead", stale: true });

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(sibling)).toBe(true);
	});

	it("never sweeps outside the daemons container when a runtime dir is relocated (issue #8721)", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-tmpdir-");
		// Simulate the smoke test relocating its runtime dir directly under a
		// shared temp root full of unrelated, aged directories.
		const fakeTmp = tempDir.path();
		for (const name of ["tmux-1000", "ssh-XVn1oP", "my-build-tree", "1111222233334444"]) {
			await fs.mkdir(path.join(fakeTmp, name, "src"), { recursive: true });
			await fs.utimes(path.join(fakeTmp, name), STALE, STALE);
		}
		const runtimeDir = path.join(fakeTmp, "veyyon-daemon-smoke-run-xxxx");
		await fs.mkdir(runtimeDir, { recursive: true });

		await pruneDeadDaemonRuntimeDirs(runtimeDir);

		const remaining = new Set(await fs.readdir(fakeTmp));
		expect(remaining.has("tmux-1000")).toBe(true);
		expect(remaining.has("ssh-XVn1oP")).toBe(true);
		expect(remaining.has("my-build-tree")).toBe(true);
		expect(remaining.has("1111222233334444")).toBe(true);
	});

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});

	it("ambiguous legacy live owner authenticated matching PID keeps directory and endpoint even when boot/age says stale", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case1-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "1111222233334444");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const child = await spawnChildEndpointListener(targetScope);
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: child.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			const recordMtime = child.startedAt - 10_000;
			await fs.utimes(leasePath, recordMtime / 1000, recordMtime / 1000);
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			const staleClock: BrokerLeaseClock = {
				now: () => recordMtime + 25 * 3600 * 1000,
				bootTimeMs: () => recordMtime + 20 * 60 * 1000,
			};

			await pruneDeadDaemonRuntimeDirs(current, staleClock);

			expect(await fs.exists(targetScope)).toBe(true);
			expect(await fs.exists(daemonBrokerEndpoint(targetScope))).toBe(true);
			expect(await fs.exists(leasePath)).toBe(true);
		} finally {
			await child.close();
		}
	});

	it("absent endpoint with recent ambiguous live PID keeps directory", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case2-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "2222333344445555");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const child = await spawnLiveChild();
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: child.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			const recordMtime = child.startedAt - 10_000;
			await fs.utimes(leasePath, recordMtime / 1000, recordMtime / 1000);
			await fs.utimes(targetScope, STALE, STALE);

			const recentClock: BrokerLeaseClock = {
				now: () => recordMtime + 30 * 60 * 1000,
				bootTimeMs: () => 0,
			};

			await pruneDeadDaemonRuntimeDirs(current, recentClock);

			expect(await fs.exists(targetScope)).toBe(true);
		} finally {
			await child.close();
		}
	});

	it("dead or reaped owner is pruned", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case3-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "3333444455556666");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const deadPid = await spawnDeadChild();
		const leasePath = daemonBrokerLeasePath(targetScope);
		const raw = { pid: deadPid };
		await fs.writeFile(leasePath, JSON.stringify(raw));
		const recordMtime = Date.now() - 30 * 60 * 1000;
		await fs.utimes(leasePath, recordMtime / 1000, recordMtime / 1000);
		await fs.utimes(targetScope, STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(targetScope)).toBe(false);
	});

	it("authenticated wrong-PID endpoint retires stale record while preserving directory and live endpoint", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case4-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "4444555566667777");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const sleeper = await spawnLiveChild();
		const child = await spawnChildEndpointListener(targetScope);
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: sleeper.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			expect(await fs.exists(targetScope)).toBe(true);
			expect(await fs.exists(daemonBrokerEndpoint(targetScope))).toBe(true);
			expect(await fs.exists(leasePath)).toBe(false);
		} finally {
			await child.close();
			await sleeper.close();
		}
	});

	it("dead recorded PID with live authenticated replacement endpoint retires stale lease and keeps scope", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-dead-record-live-endpoint-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "4444555566668888");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const deadPid = await spawnDeadChild();
		const child = await spawnChildEndpointListener(targetScope);
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: deadPid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			expect(await fs.exists(targetScope)).toBe(true);
			expect(await fs.exists(daemonBrokerEndpoint(targetScope))).toBe(true);
			expect(await fs.exists(leasePath)).toBe(false);
		} finally {
			await child.close();
		}
	});

	it("live fresh broker publication during ping contends under prune lock and succeeds after prune", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-contention-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "4444555566669999");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const sleeper = await spawnLiveChild();
		const child = await spawnChildEndpointListener(targetScope, { gatePing: true });
		const leasePath = daemonBrokerLeasePath(targetScope);
		let freshLease: BrokerLease | null = null;
		try {
			const raw = { pid: sleeper.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			const prunePromise = pruneDeadDaemonRuntimeDirs(current);
			await child.waitForPing();

			const contendedLease = await acquireBrokerLease(targetScope);
			expect(contendedLease).toBeNull();

			child.proceedPing();
			await prunePromise;

			expect(await fs.exists(targetScope)).toBe(true);
			expect(await fs.exists(daemonBrokerEndpoint(targetScope))).toBe(true);
			expect(await fs.exists(leasePath)).toBe(false);

			freshLease = await acquireBrokerLease(targetScope);
			expect(freshLease).not.toBeNull();
			expect(await fs.exists(leasePath)).toBe(true);
			const readLease = JSON.parse(await fs.readFile(leasePath, "utf8"));
			expect(readLease.pid).toBe(process.pid);
		} finally {
			if (freshLease) await releaseBrokerLease(freshLease);
			await child.close();
			await sleeper.close();
		}
	});

	it("identity mismatch with matching numeric authenticated listener retires stale record and keeps scope", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-identity-mismatch-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "444455556666aaaa");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const child = await spawnChildEndpointListener(targetScope);
		const leasePath = daemonBrokerLeasePath(targetScope);
		let freshLease: BrokerLease | null = null;
		try {
			const raw = { pid: child.pid, processIdentity: "mismatched-identity-uuid-0000" };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			expect(await fs.exists(targetScope)).toBe(true);
			expect(await fs.exists(daemonBrokerEndpoint(targetScope))).toBe(true);
			expect(await fs.exists(leasePath)).toBe(false);

			freshLease = await acquireBrokerLease(targetScope);
			expect(freshLease).not.toBeNull();
			expect(await fs.exists(leasePath)).toBe(true);
			const readLease = JSON.parse(await fs.readFile(leasePath, "utf8"));
			expect(readLease.pid).toBe(process.pid);
		} finally {
			if (freshLease) await releaseBrokerLease(freshLease);
			await child.close();
		}
	});

	it("inconclusive older than 24h prunes directory even when bootTimeMs is 0", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case5a-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "5555666677778888");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const child = await spawnLiveChild();
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: child.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			const recordMtime = child.startedAt - 10_000;
			await fs.utimes(leasePath, recordMtime / 1000, recordMtime / 1000);
			await fs.utimes(targetScope, STALE, STALE);

			const ageOnlyClock: BrokerLeaseClock = {
				now: () => recordMtime + 25 * 3600 * 1000,
				bootTimeMs: () => 0,
			};

			await pruneDeadDaemonRuntimeDirs(current, ageOnlyClock);

			expect(await fs.exists(targetScope)).toBe(false);
		} finally {
			await child.close();
		}
	});

	it("inconclusive with boot 15min after record prunes directory even when age is 30min", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-case5b-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "6666777788889999");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });

		const child = await spawnLiveChild();
		try {
			const leasePath = daemonBrokerLeasePath(targetScope);
			const raw = { pid: child.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			const recordMtime = child.startedAt - 10_000;
			await fs.utimes(leasePath, recordMtime / 1000, recordMtime / 1000);
			await fs.utimes(targetScope, STALE, STALE);

			const bootOnlyClock: BrokerLeaseClock = {
				now: () => recordMtime + 30 * 60 * 1000,
				bootTimeMs: () => recordMtime + 15 * 60 * 1000,
			};

			await pruneDeadDaemonRuntimeDirs(current, bootOnlyClock);

			expect(await fs.exists(targetScope)).toBe(false);
		} finally {
			await child.close();
		}
	});

	it("live client registration during ping contends under prune lock and succeeds after prune", async () => {
		using tempDir = TempDir.createSync("@veyyon-daemon-prune-client-contention-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });
		const current = path.join(daemons, "current000000000");
		await fs.mkdir(current, { recursive: true });

		const targetScope = path.join(daemons, "444455556666cccc");
		await fs.mkdir(path.join(targetScope, "clients"), { recursive: true });
		const projectDir = path.join(tempDir.path(), "project-c");
		await fs.mkdir(projectDir, { recursive: true });

		const sleeper = await spawnLiveChild();
		const child = await spawnChildEndpointListener(targetScope, { gatePing: true });
		const leasePath = daemonBrokerLeasePath(targetScope);
		const clientProc = await spawnClientRegistrationProcess(projectDir, targetScope);

		try {
			const raw = { pid: sleeper.pid };
			await fs.writeFile(leasePath, JSON.stringify(raw));
			await fs.writeFile(daemonBrokerTokenPath(targetScope), "test-token");
			await fs.utimes(targetScope, STALE, STALE);

			const prunePromise = pruneDeadDaemonRuntimeDirs(current);
			await child.waitForPing();

			// Prune holds the transition lock. Trigger registration from a real process.
			clientProc.register();
			await clientProc.waitForAttempting();

			// While prune holds the lock, registration must be serialized and waiting.
			// Unblock prune and let it finish.
			child.proceedPing();
			await prunePromise;

			// After prune releases the lock, registration completes without lock violation.
			await clientProc.waitForRegistered();

			const clientsDir = path.join(targetScope, "clients");
			const finalEntries = await fs.readdir(clientsDir);
			expect(finalEntries.length).toBe(1);
			expect(await hasLiveDaemonProjectPresence(targetScope)).toBe(true);
			const statusAfterPrune = await clientProc.queryStatus();
			expect(statusAfterPrune).toBe("registered");
		} finally {
			await clientProc.close();
			await child.close();
			await sleeper.close();
		}
	});
});
