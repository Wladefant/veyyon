import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartTime } from "@veyyon/utils/process-liveness";
import { acquireBrokerLease, releaseBrokerLease } from "../../src/launch/broker-lease";
import { daemonBrokerEndpoint, daemonBrokerLeasePath } from "../../src/launch/paths";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function runtime(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-lease-443-"));
	dirs.push(dir);
	return dir;
}

it("keeps a live legacy owner whose process start time shifted past its record after a clock step", async () => {
	// A forward wall-clock step moves the btime-derived start time after the record's mtime,
	// which is exactly what an mtime of 1 against a live process reproduces.
	expect(getProcessStartTime(process.pid)).not.toBeNull();
	const dir = await runtime();
	const leasePath = daemonBrokerLeasePath(dir);
	const record = JSON.stringify({ pid: process.pid });
	await fs.writeFile(leasePath, record);
	await fs.utimes(leasePath, 1, 1);
	// The owner is a broker: it is listening on the endpoint its lease guards.
	const server = net.createServer(socket => socket.destroy());
	await new Promise<void>(resolve => server.listen(daemonBrokerEndpoint(dir), resolve));
	try {
		expect(await acquireBrokerLease(dir)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

it("still retires a legacy lease whose start time is later than its record when nothing answers on the endpoint", async () => {
	const dir = await runtime();
	const leasePath = daemonBrokerLeasePath(dir);
	await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid }));
	await fs.utimes(leasePath, 1, 1);
	const lease = await acquireBrokerLease(dir);
	expect(lease).not.toBeNull();
	if (lease) await releaseBrokerLease(lease);
});

it("logs why a start exits when the lease lock is contended", async () => {
	const dir = await runtime();
	const leasePath = daemonBrokerLeasePath(dir);
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const result = await withFileLock(leasePath, () => acquireBrokerLease(dir));
		expect(result).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		const [message, context] = warn.mock.calls[0] as [string, { leasePath: string }];
		expect(message).toContain("contended");
		expect(context.leasePath).toBe(leasePath);
	} finally {
		warn.mockRestore();
	}
});
