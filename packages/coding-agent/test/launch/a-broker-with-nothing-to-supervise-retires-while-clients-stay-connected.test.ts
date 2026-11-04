/**
 * WHY THIS SUITE EXISTS.
 *
 * Every veyyon process keeps its connection to a project's daemon broker open for its whole life, and
 * the broker counted a connected client as a reason to stay up. A broker spawned for one `launch list`
 * therefore lived as long as the session that spawned it, one per project directory the session had
 * used, each holding 15-30 MB with nothing to supervise.
 *
 * The class it closes: a broker kept alive by an idle connection rather than by a process it runs. A
 * broker now retires after the idle grace once nothing it started depends on it, whoever is connected;
 * a connected client reaches the next broker on its next request, and a request the retiring broker
 * left unanswered is answered by the next one rather than failed.
 *
 * Covered: retirement with a client connected; the same client's next request; a process that ends on
 * its own re-arming retirement; no retirement while a `last-client-exit` process runs or while a
 * request is being answered; a request pending when its broker shuts down answered by the next broker.
 *
 * Not covered: the client waiting for the retiring broker to release its lease before it spawns the
 * next one. Without that wait a replacement spawned in the window between the old broker closing its
 * socket and releasing its lease exits at once; the window is a few milliseconds, which no test here
 * can hit on demand.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isProcessAlive } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerLeasePath } from "../../src/launch/paths";
import type { DaemonSpec } from "../../src/launch/protocol";

const GRACE_MS = 300;
const TEST_PARENT = path.join(os.tmpdir(), "veyyon-broker-retirement");
let testRoot = "";
let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const cleanupClients: DaemonBrokerClient[] = [];

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("broker-retirement");
});

afterEach(() => {
	// A broker with no client stops what it runs and exits after the grace.
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

// Cross-process integration: the broker and its processes run outside this process, so fake timers
// cannot advance them and progress is observed by polling.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(25);
	}
	return condition();
}

interface Broker {
	projectDir: string;
	runtimeDir: string;
	client: DaemonBrokerClient;
}

async function connect(): Promise<Broker> {
	const projectDir = await fs.mkdtemp(path.join(testRoot, "project-"));
	const runtimeDir = await fs.mkdtemp(path.join(testRoot, "runtime-"));
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: GRACE_MS });
	cleanupClients.push(client);
	await client.request({ op: "ping" });
	return { projectDir, runtimeDir, client };
}

/** Pid of the broker holding the lease, read from the lease file it writes. */
async function brokerPid(runtimeDir: string): Promise<number> {
	const claim: unknown = JSON.parse(await fs.readFile(daemonBrokerLeasePath(runtimeDir), "utf8"));
	if (typeof claim !== "object" || claim === null || !("pid" in claim) || typeof claim.pid !== "number") {
		throw new Error("broker lease holds no pid");
	}
	return claim.pid;
}

function spec(projectDir: string, name: string, script: string, detached = false): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", script],
		env: {},
		cwd: projectDir,
		pty: false,
		restart: "no",
		persist: detached,
		detached,
	};
}

const RUNS_UNTIL_STOPPED = "setInterval(() => {}, 1000)";

describe("a broker with nothing to supervise retires while clients stay connected", () => {
	it("retires after the grace with a client connected, and that client's next request reaches a new broker", async () => {
		const { runtimeDir, client } = await connect();
		const first = await brokerPid(runtimeDir);

		expect(await waitUntil(() => !isProcessAlive(first), 5_000)).toBeTrue();

		const pinged = await client.request({ op: "ping" });
		expect(pinged.op).toBe("ping");
		const second = await brokerPid(runtimeDir);
		expect(second).not.toBe(first);
		expect(isProcessAlive(second)).toBeTrue();
	}, 20_000);

	it("stays up while a connected client's last-client-exit process runs, and retires once it is stopped", async () => {
		const { projectDir, runtimeDir, client } = await connect();
		const pid = await brokerPid(runtimeDir);
		await client.request({ op: "start", spec: spec(projectDir, "held", RUNS_UNTIL_STOPPED) });

		await delay(GRACE_MS * 4);
		expect(isProcessAlive(pid)).toBeTrue();
		const listed = await client.request({ op: "list" });
		expect(listed.op === "list" && listed.daemons.find(daemon => daemon.name === "held")?.state).toBe("running");
		expect(await brokerPid(runtimeDir)).toBe(pid);

		await client.request({ op: "stop", name: "held", timeoutMs: 5_000 });
		expect(await waitUntil(() => !isProcessAlive(pid), 5_000)).toBeTrue();
	}, 20_000);

	it("retires once the last process it supervised ends on its own while the client is idle", async () => {
		const { projectDir, runtimeDir, client } = await connect();
		const pid = await brokerPid(runtimeDir);
		await client.request({
			op: "start",
			spec: spec(projectDir, "brief", "setTimeout(() => process.exit(0), 600)"),
		});

		expect(await waitUntil(() => !isProcessAlive(pid), 6_000)).toBeTrue();
	}, 20_000);

	it("does not retire while it is answering a request, whatever it supervises", async () => {
		const { projectDir, runtimeDir, client } = await connect();
		const pid = await brokerPid(runtimeDir);
		// A detached process outlives its broker, so it holds nothing up; only the request in flight does.
		await client.request({ op: "start", spec: spec(projectDir, "outliving", RUNS_UNTIL_STOPPED, true) });
		try {
			const waited = await client.request({ op: "wait", name: "outliving", for: "exit", timeoutMs: GRACE_MS * 5 });
			expect(waited.op === "wait" && waited.timedOut).toBeTrue();
			expect(await brokerPid(runtimeDir)).toBe(pid);
			expect(isProcessAlive(pid)).toBeTrue();
		} finally {
			await client.request({ op: "stop", name: "outliving", timeoutMs: 5_000 });
		}
	}, 20_000);

	it("answers a request pending when its broker shuts down from the next broker", async () => {
		const { projectDir, runtimeDir, client } = await connect();
		const pid = await brokerPid(runtimeDir);
		await client.request({ op: "start", spec: spec(projectDir, "held", RUNS_UNTIL_STOPPED) });
		const waiting = client.request({ op: "wait", name: "held", for: "exit", timeoutMs: 15_000 });

		process.kill(pid, "SIGTERM");

		const waited = await waiting;
		expect(waited.op).toBe("wait");
		if (waited.op !== "wait") return;
		expect(waited.timedOut).toBeFalse();
		expect(waited.daemon.state).toBe("exited");
		expect(waited.daemon.terminatedBy).toBe("os-signal");
		const next = await brokerPid(runtimeDir);
		expect(next).not.toBe(pid);
		expect(isProcessAlive(next)).toBeTrue();
	}, 30_000);
});
