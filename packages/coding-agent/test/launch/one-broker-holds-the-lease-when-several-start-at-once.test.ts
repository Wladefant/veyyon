/**
 * WHY: clients that find no broker each spawn one, and the broker's PID lease selects the one that
 * runs. The lease was created empty and its claim written afterwards, and a candidate that read it
 * in between took the empty file for a stale one, removed it and took the lease as well. Two brokers
 * then ran for one runtime directory.
 *
 * The class this closes: a reader of the lease path seeing anything but a whole claim. The race is
 * driven with candidates in one process, so every claim names a live pid and only an incomplete file
 * can make a second candidate win; the remaining cases pin the stale-lease and release contract the
 * publication change must keep.
 *
 * What it does NOT catch: two candidates that both find the same DEAD owner. Removing a stale lease is
 * not atomic with the read that judged it stale, and that race is stated in the module, not closed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { acquireBrokerLease, type BrokerLease, releaseBrokerLease } from "@veyyon/coding-agent/launch/broker-lease";
import { daemonBrokerLeasePath } from "@veyyon/coding-agent/launch/paths";
import { TempDir } from "@veyyon/utils";

let runtime: TempDir;

beforeEach(async () => {
	runtime = await TempDir.create("veyyon-broker-lease-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await runtime.remove();
});

/**
 * Make every file content write take three turns of the event loop, as a loaded disk does, whether it
 * goes through `fs.writeFile` or an open handle. A candidate that creates the lease before writing its
 * claim is then visible to the others while still empty.
 */
async function slowContentWrites(): Promise<void> {
	const probe = await fs.open(runtime.join("probe"), "w");
	const handlePrototype: { writeFile: (...args: unknown[]) => Promise<void> } = Object.getPrototypeOf(probe);
	await probe.close();
	await fs.rm(runtime.join("probe"));
	const handleWrite = handlePrototype.writeFile;
	spyOn(handlePrototype, "writeFile").mockImplementation(async function (this: unknown, ...args: unknown[]) {
		for (let turn = 0; turn < 3; turn++) await nextMacrotask();
		return handleWrite.apply(this, args);
	});
	const pathWrite = fs.writeFile;
	spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		for (let turn = 0; turn < 3; turn++) await nextMacrotask();
		return pathWrite(...args);
	});
}

async function leaseClaim(): Promise<unknown> {
	return JSON.parse(await fs.readFile(daemonBrokerLeasePath(runtime.path()), "utf8"));
}

/** The pid of a process that has exited and been reaped. */
function deadPid(): number {
	const pid = spawnSync("true").pid;
	if (pid === undefined) throw new Error("could not spawn `true` for a dead pid");
	return pid;
}

describe("the broker lease", () => {
	it("goes to exactly one of sixteen candidates that start at once, and names it", async () => {
		const outcomes = await Promise.all(Array.from({ length: 16 }, () => acquireBrokerLease(runtime.path())));
		const winners = outcomes.filter((lease): lease is BrokerLease => lease !== null);

		expect(winners.length).toBe(1);
		expect(await leaseClaim()).toEqual({ pid: process.pid, instanceId: winners[0]!.instanceId });
		expect(await fs.readdir(runtime.path())).toEqual(["broker.pid"]);
	});

	it("goes to exactly one candidate while writing a claim takes several turns of the event loop", async () => {
		await slowContentWrites();
		const outcomes = await Promise.all(Array.from({ length: 16 }, () => acquireBrokerLease(runtime.path())));
		const winners = outcomes.filter((lease): lease is BrokerLease => lease !== null);

		expect(winners.length).toBe(1);
		expect(await leaseClaim()).toEqual({ pid: process.pid, instanceId: winners[0]!.instanceId });
	});

	it("is refused while a running process holds it, and left as it was", async () => {
		const held = await acquireBrokerLease(runtime.path());

		expect(await acquireBrokerLease(runtime.path())).toBeNull();
		expect(await leaseClaim()).toEqual({ pid: process.pid, instanceId: held?.instanceId });
	});

	it("is taken from a dead owner and from a file that holds no claim", async () => {
		const leasePath = daemonBrokerLeasePath(runtime.path());
		const stale = {
			deadOwner: JSON.stringify({ pid: deadPid(), instanceId: "dead-owner" }),
			empty: "",
			truncated: '{"pid":',
		};
		const taken: Record<string, boolean> = {};
		for (const [name, before] of Object.entries(stale)) {
			await fs.writeFile(leasePath, before);
			const lease = await acquireBrokerLease(runtime.path());
			taken[name] =
				lease !== null &&
				JSON.stringify(await leaseClaim()) === JSON.stringify({ pid: process.pid, instanceId: lease.instanceId });
			if (lease) await releaseBrokerLease(lease);
		}

		expect(taken).toEqual({ deadOwner: true, empty: true, truncated: true });
	});

	it("is removed on release only while it is still the releasing broker's", async () => {
		const leasePath = daemonBrokerLeasePath(runtime.path());
		const first = await acquireBrokerLease(runtime.path());
		if (!first) throw new Error("the first candidate did not take the lease");
		const successor = JSON.stringify({ pid: process.pid, instanceId: "successor" });
		await fs.writeFile(leasePath, successor);

		await releaseBrokerLease(first);
		expect(await fs.readFile(leasePath, "utf8")).toBe(successor);

		await fs.rm(leasePath);
		const second = await acquireBrokerLease(runtime.path());
		if (!second) throw new Error("the second candidate did not take the lease");
		await releaseBrokerLease(second);
		expect(await fs.readdir(runtime.path())).toEqual([]);
	});
});
