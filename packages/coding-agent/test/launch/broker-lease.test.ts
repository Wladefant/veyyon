import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessStartIdentity, getProcessStartTime } from "@veyyon/utils/process-liveness";
import { acquireBrokerLease, releaseBrokerLease } from "../../src/launch/broker-lease";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerLeasePath } from "../../src/launch/paths";
import { hasLiveDaemonProjectPresence } from "../../src/launch/presence";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function runtime(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-lease-411-"));
	dirs.push(dir);
	return dir;
}

it("reclaims a stale lease when its recorded PID belongs to a different process incarnation", async () => {
	const dir = await runtime();
	const identity = getProcessStartIdentity(process.pid);
	expect(identity).not.toBeNull();
	await fs.writeFile(
		daemonBrokerLeasePath(dir),
		JSON.stringify({ pid: process.pid, processIdentity: `${identity}:old` }),
	);
	const lease = await acquireBrokerLease(dir);
	expect(lease).not.toBeNull();
	if (lease) await releaseBrokerLease(lease);
});

it("keeps a genuinely live owner's lease and preserves it after a competing start", async () => {
	const dir = await runtime();
	const lease = await acquireBrokerLease(dir);
	expect(lease).not.toBeNull();
	const original = await fs.readFile(daemonBrokerLeasePath(dir), "utf8");
	expect(await acquireBrokerLease(dir)).toBeNull();
	expect(await fs.readFile(daemonBrokerLeasePath(dir), "utf8")).toBe(original);
	if (lease) await releaseBrokerLease(lease);
});

it("two competing starts cannot both acquire a stale lease", async () => {
	const dir = await runtime();
	await fs.writeFile(
		daemonBrokerLeasePath(dir),
		JSON.stringify({ pid: process.pid, processIdentity: "previous-incarnation" }),
	);
	const leases = await Promise.all([acquireBrokerLease(dir), acquireBrokerLease(dir)]);
	const winners = leases.filter(lease => lease !== null);
	expect(winners).toHaveLength(1);
	if (winners[0]) await releaseBrokerLease(winners[0]);
});

it("prunes only stale presence and retains a matching live incarnation", async () => {
	const dir = await runtime();
	const clients = path.join(dir, "clients");
	await fs.mkdir(clients);
	const identity = getProcessStartIdentity(process.pid);
	expect(identity).not.toBeNull();
	await fs.writeFile(
		path.join(clients, "stale.json"),
		JSON.stringify({ pid: process.pid, processIdentity: `${identity}:old` }),
	);
	await fs.writeFile(path.join(clients, "live.json"), JSON.stringify({ pid: process.pid, processIdentity: identity }));
	expect(await hasLiveDaemonProjectPresence(dir)).toBe(true);
	expect(await fs.readdir(clients)).toEqual(["live.json"]);
});

it("preserves unverifiable legacy live owners instead of stealing their lease", async () => {
	const dir = await runtime();
	await fs.writeFile(daemonBrokerLeasePath(dir), JSON.stringify({ pid: process.pid }));
	expect(await acquireBrokerLease(dir)).toBeNull();
});

it("recovers legacy PID-only leases and presence when the live process started after the record", async () => {
	const dir = await runtime();
	expect(getProcessStartTime(process.pid)).not.toBeNull();
	const leasePath = daemonBrokerLeasePath(dir);
	await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid }));
	await fs.utimes(leasePath, 1, 1);
	const clients = path.join(dir, "clients");
	await fs.mkdir(clients);
	const presencePath = path.join(clients, "legacy.json");
	await fs.writeFile(presencePath, JSON.stringify({ pid: process.pid }));
	await fs.utimes(presencePath, 1, 1);
	expect(await hasLiveDaemonProjectPresence(dir)).toBe(false);
	expect(await fs.readdir(clients)).toEqual([]);
	const lease = await acquireBrokerLease(dir);
	expect(lease).not.toBeNull();
	if (lease) await releaseBrokerLease(lease);
});

it("two independent processes cannot both retire and acquire the same stale lease", async () => {
	const dir = await runtime();
	await fs.writeFile(daemonBrokerLeasePath(dir), JSON.stringify({ pid: process.pid, processIdentity: "old" }));
	const script = path.join(dir, "contend.ts");
	const modulePath = path.resolve(import.meta.dir, "../../src/launch/broker-lease.ts");
	await fs.writeFile(
		script,
		`import { acquireBrokerLease, releaseBrokerLease } from ${JSON.stringify(modulePath)};
let lease;
console.log("ready");
for await (const chunk of Bun.stdin.stream()) {
	const command = new TextDecoder().decode(chunk).trim();
	if (command === "go") {
		lease = await acquireBrokerLease(process.argv[2]);
		console.log(lease ? "owner" : "busy");
	} else if (command === "release") {
		if (lease) await releaseBrokerLease(lease);
		break;
	}
}`,
	);
	const { env, cleanup } = hermeticSpawnEnv();
	const children = ["a", "b"].map(() =>
		Bun.spawn([process.execPath, script, dir], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
	);
	const readers = children.map(child => child.stdout.getReader());
	// Pipe acknowledgements synchronize real OS processes; no timing guesses.
	const readSignal = async (index: number): Promise<string> => {
		let text = "";
		while (!text.includes("\n")) {
			const chunk = await readers[index]!.read();
			if (chunk.done) throw new Error("Contender exited before acknowledgement");
			text += new TextDecoder().decode(chunk.value);
		}
		return text.trim();
	};
	try {
		expect(await Promise.all([readSignal(0), readSignal(1)])).toEqual(["ready", "ready"]);
		for (const child of children) {
			child.stdin.write("go\n");
			await child.stdin.flush();
		}
		const results = await Promise.all([readSignal(0), readSignal(1)]);
		expect(results.sort()).toEqual(["busy", "owner"]);
		for (const child of children) {
			child.stdin.write("release\n");
			await child.stdin.flush();
			child.stdin.end();
		}
		expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.map(child => child.exited));
		cleanup();
	}
}, 15_000);

it("starts a responsive broker over a stale legacy lease whose PID is an unrelated live process", async () => {
	const dir = await runtime();
	const leasePath = daemonBrokerLeasePath(dir);
	await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid }));
	await fs.utimes(leasePath, 1, 1);
	const client = await createDaemonBrokerClient(dir, { runtimeDir: dir, idleGraceMs: 100 });
	try {
		expect(await client.request({ op: "ping" })).toEqual({ op: "ping", projectDir: dir });
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
	}
}, 15_000);
