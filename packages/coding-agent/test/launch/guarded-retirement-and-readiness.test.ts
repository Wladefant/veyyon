/**
 * PR #1072 regressions: readiness sends must not serialize behind start, and
 * accepted side effects must reply before the broker announces retirement.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { DaemonBroker } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint, daemonBrokerTokenPath, managedDaemonLogPath } from "../../src/launch/paths";
import {
	DAEMON_BROKER_RETIRING_ID,
	type DaemonSpec,
	encodeDaemonOperation,
} from "../../src/launch/protocol";
import { waitUntil } from "../helpers/daemon-broker";


let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-guarded-retire-ready-tests");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("guarded-retire-ready");
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];
const cleanupBrokers: { broker: DaemonBroker; run: Promise<void> }[] = [];
const cleanupSockets: net.Socket[] = [];
const cleanupPids: number[] = [];
afterEach(async () => {
	while (cleanupSockets.length > 0) {
		const s = cleanupSockets.pop();
		try {
			s?.destroy();
		} catch {
			// ignore
		}
	}
	while (cleanupClients.length > 0) {
		const c = cleanupClients.pop();
		try {
			c?.close();
		} catch {
			// ignore
		}
	}
	while (cleanupBrokers.length > 0) {
		const tracked = cleanupBrokers.pop();
		if (!tracked) continue;
		try {
			await Promise.race([tracked.broker.shutdown(), delay(3_000)]);
		} catch {
			// ignore
		}
		try {
			await Promise.race([tracked.run, delay(3_000)]);
		} catch {
			// ignore
		}
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}
	while (cleanupPids.length > 0) {
		const pid = cleanupPids.pop();
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// ignore
			}
		}
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
): Promise<{ broker: DaemonBroker; client: DaemonBrokerClient; token: string }> {
	const token = "testtoken" + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(daemonBrokerTokenPath(runtimeDir), token, { encoding: "utf8", mode: 0o600 });
	const broker = new DaemonBroker(projectDir, runtimeDir, token, 10_000);
	const run = broker.run();
	cleanupBrokers.push({ broker, run });
	const ready = await waitUntil(async () => {
		try {
			const socket = net.createConnection(daemonBrokerEndpoint(runtimeDir));
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.destroy();
			return true;
		} catch {
			return false;
		}
	}, 5_000);
	if (!ready) throw new Error("broker endpoint did not become ready");
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
	cleanupClients.push(client);
	return { broker, client, token };
}
describe("guarded retirement and readiness regressions", () => {
	it("allows a guarded send to satisfy readiness while start waits", async () => {
		const projectDir = await tempDir("ready-project-");
		const runtimeDir = await tempDir("ready-runtime-");
		const { client } = await startInProcessBroker(projectDir, runtimeDir);
		const spec: DaemonSpec = {
			name: "stdin-ready-service",
			application: process.execPath,
			args: ["-e", `
				process.stdin.setEncoding("utf8");
				process.stdin.on("data", chunk => {
					if (chunk.includes("go")) process.stdout.write("READY\\\\n");
				});
				process.stdin.resume();
				setInterval(() => {}, 1000);
			`],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
			ready: { log: "READY", timeoutMs: 4_000 },
		};
		const startPromise = client.request({ op: "start", spec });
		let daemonId: string | undefined;
		let daemonGen: number | undefined;
		const admitted = await waitUntil(async () => {
			try {
				const result = await client.request({ op: "list" });
				if (result.op !== "list") return false;
				const daemon = result.daemons.find(item => item.name === spec.name);
				if (!daemon || daemon.state !== "starting") return false;
				daemonId = daemon.id;
				daemonGen = daemon.generation;
				return true;
			} catch {
				return false;
			}
		}, 5_000);
		expect(admitted).toBeTrue();
		expect(daemonId).toBeDefined();
		expect(daemonGen).toBeDefined();
		expect((await client.request({
			op: "send",
			name: spec.name,
			data: "go\n",
			expectedId: daemonId,
			expectedGeneration: daemonGen,
		})).op).toBe("send");
		const startResult = await Promise.race([
			startPromise,
			delay(10_000).then(() => {
				throw new Error("start request deadlocked waiting for readiness");
			}),
		]);
		expect(startResult.op).toBe("start");
		if (startResult.op === "start") {
			expect(startResult.readyTimedOut).toBeFalse();
			expect(startResult.daemon.state).toBe("ready");
		}
	}, 20_000);

	it("replies to accepted detached sends before retirement notice", async () => {
		const projectDir = await tempDir("retire-project-");
		const runtimeDir = await tempDir("retire-runtime-");
		const { broker, client, token } = await startInProcessBroker(projectDir, runtimeDir);
		const marker = path.join(projectDir, "signal-count");
		const startResult = await client.request({
			op: "start",
			spec: {
				name: "detached-service",
				application: process.execPath,
				args: ["-e", `
					const fs = require("node:fs");
					process.on("SIGHUP", () => fs.appendFileSync(${JSON.stringify(marker)}, "signal\\n"));
					process.stdout.write("started\\\\n");
					setInterval(() => {}, 1000);
				`],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: true,
				detached: true,
			},
		});
		expect(startResult.op).toBe("start");
		if (startResult.op !== "start") return;
		if (startResult.daemon.pid) cleanupPids.push(startResult.daemon.pid);
		const endpoint = daemonBrokerEndpoint(runtimeDir);
		const endpointReady = await waitUntil(async () => {
			try {
				const socket = net.createConnection(endpoint);
				await new Promise<void>((resolve, reject) => {
					socket.once("connect", resolve);
					socket.once("error", reject);
				});
				socket.destroy();
				return true;
			} catch {
				return false;
			}
		}, 5_000);
		expect(endpointReady).toBeTrue();
		const rawSocket = net.connect(endpoint);
		cleanupSockets.push(rawSocket);
		await new Promise<void>((resolve, reject) => {
			rawSocket.once("connect", resolve);
			rawSocket.once("error", reject);
		});
		const incomingLines: string[] = [];
		let socketBuffer = "";
		rawSocket.on("data", chunk => {
			socketBuffer += chunk.toString("utf8");
			for (;;) {
				const newlineIdx = socketBuffer.indexOf("\n");
				if (newlineIdx < 0) break;
				const line = socketBuffer.slice(0, newlineIdx).trim();
				socketBuffer = socketBuffer.slice(newlineIdx + 1);
				if (line) incomingLines.push(line);
			}
		});
		const logTarget = managedDaemonLogPath(path.join(runtimeDir, "daemons", "detached-service"));
		const statHold = Promise.withResolvers<void>();
		const statEntered = Promise.withResolvers<void>();
		const realStat = fs.stat.bind(fs);
		const statSpy = spyOn(fs, "stat").mockImplementation((async (
			targetPath: Parameters<typeof fs.stat>[0],
			opts?: Parameters<typeof fs.stat>[1],
		) => {
			if (path.resolve(String(targetPath)) === path.resolve(logTarget)) {
				statEntered.resolve();
				await statHold.promise;
			}
			return opts === undefined ? realStat(targetPath) : realStat(targetPath, opts);
		}) as typeof fs.stat);
		try {
			const sendReqId = `req-${crypto.randomUUID()}`;
			const operation = encodeDaemonOperation({
				op: "send",
				name: "detached-service",
				signal: "SIGHUP",
				expectedId: startResult.daemon.id,
				expectedGeneration: startResult.daemon.generation,
			});
			rawSocket.write(JSON.stringify({ id: sendReqId, token, operation }) + "\n");
			await Promise.race([
				statEntered.promise,
				delay(5_000).then(() => {
					throw new Error("send did not reach detached output refresh");
				}),
			]);
			const shutdownPromise = broker.shutdown({
				owner: "broker-shutdown",
				reason: "test retirement race",
				at: Date.now(),
			});
			await delay(50);
			statHold.resolve();
			await shutdownPromise;
			await waitUntil(() => incomingLines.length >= 2, 2_000);
			const ids = incomingLines.map(line => {
				try {
					return JSON.parse(line).id;
				} catch {
					return undefined;
				}
			});
			const replyIndex = ids.indexOf(sendReqId);
			const noticeIndex = ids.indexOf(DAEMON_BROKER_RETIRING_ID);
			expect(replyIndex).toBeGreaterThanOrEqual(0);
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(replyIndex).toBeLessThan(noticeIndex);
			expect(await fs.readFile(marker, "utf8")).toBe("signal\n");
		} finally {
			statHold.resolve();
			statSpy.mockRestore();
			if (startResult?.daemon?.pid) {
				try {
					process.kill(startResult.daemon.pid, "SIGKILL");
				} catch {
					// ignore
				}
			}
		}
	}, 20_000);
});
