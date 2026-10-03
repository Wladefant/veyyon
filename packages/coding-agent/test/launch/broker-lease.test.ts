import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessStartIdentity } from "@veyyon/utils/process-liveness";
import { acquireBrokerLease, releaseBrokerLease } from "../../src/launch/broker-lease";
import { daemonBrokerLeasePath } from "../../src/launch/paths";
import { hasLiveDaemonProjectPresence } from "../../src/launch/presence";

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
