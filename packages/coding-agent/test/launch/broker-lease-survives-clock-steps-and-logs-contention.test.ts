import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartTime } from "@veyyon/utils/process-liveness";
import { acquireBrokerLease, releaseBrokerLease } from "../../src/launch/broker-lease";
import { daemonBrokerEndpoint, daemonBrokerLeasePath, daemonBrokerTokenPath } from "../../src/launch/paths";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function runtime(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-lease-443-"));
	dirs.push(dir);
	return dir;
}

/** A listener on the broker endpoint; `reply` decides what each connection gets back. */
async function listen(dir: string, onLine: (socket: net.Socket, line: string) => void): Promise<() => Promise<void>> {
	const server = net.createServer(socket => {
		let buffered = "";
		socket.on("error", () => {});
		socket.on("data", chunk => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline >= 0) onLine(socket, buffered.slice(0, newline));
		});
	});
	await new Promise<void>(resolve => server.listen(daemonBrokerEndpoint(dir), resolve));
	return () => new Promise<void>(resolve => server.close(() => resolve()));
}

/** What a real broker answers to an authenticated ping. */
function brokerPing(pid: number | undefined): (socket: net.Socket, line: string) => void {
	return (socket, line) => {
		const request = JSON.parse(line) as { id: string; token: string };
		const ok = request.token === "test-token";
		const result = ok ? { id: request.id, ok, result: { op: "ping", projectDir: "/p", pid } } : { id: request.id, ok };
		socket.write(`${JSON.stringify(result)}\n`);
	};
}

/** A real live process the lease can name. */
async function liveChild(): Promise<{ pid: number; kill: () => void }> {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
	await Bun.sleep(200);
	return { pid: child.pid, kill: () => child.kill() };
}

async function agedLegacyLease(dir: string, pid: number): Promise<{ leasePath: string; record: string }> {
	const leasePath = daemonBrokerLeasePath(dir);
	const record = JSON.stringify({ pid });
	await fs.writeFile(leasePath, record);
	await fs.utimes(leasePath, 1, 1);
	await fs.writeFile(daemonBrokerTokenPath(dir), "test-token");
	return { leasePath, record };
}

it("keeps a live legacy owner whose process start time shifted past its record after a clock step", async () => {
	// A forward wall-clock step moves the btime-derived start time after the record's mtime,
	// which is exactly what an mtime of 1 against a live process reproduces.
	expect(getProcessStartTime(process.pid)).not.toBeNull();
	const dir = await runtime();
	const { leasePath, record } = await agedLegacyLease(dir, process.pid);
	const close = await listen(dir, brokerPing(process.pid));
	try {
		expect(await acquireBrokerLease(dir)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		await close();
	}
});

it("never takes over a live legacy owner with an ambiguous start time when its endpoint is absent", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const { leasePath, record } = await agedLegacyLease(dir, child.pid);
		expect(await acquireBrokerLease(dir)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		child.kill();
	}
});

it("never takes over a live legacy owner that stopped listening but is still running", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const { leasePath, record } = await agedLegacyLease(dir, child.pid);
		const close = await listen(dir, brokerPing(child.pid));
		await close();
		expect(await acquireBrokerLease(dir)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		child.kill();
	}
});

it("reclaims a stale legacy lease when an unrelated listener, not the recorded owner, holds the endpoint", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		await agedLegacyLease(dir, child.pid);
		// Unrelated server: replies, but is neither authenticated nor the recorded PID.
		const close = await listen(dir, socket => socket.end("not a broker\n"));
		try {
			const lease = await acquireBrokerLease(dir);
			expect(lease).not.toBeNull();
			if (lease) await releaseBrokerLease(lease);
		} finally {
			await close();
		}
	} finally {
		child.kill();
	}
});

it("reclaims a stale legacy lease when the endpoint answers as a different broker PID", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		await agedLegacyLease(dir, child.pid);
		const close = await listen(dir, brokerPing(child.pid + 1));
		try {
			const lease = await acquireBrokerLease(dir);
			expect(lease).not.toBeNull();
			if (lease) await releaseBrokerLease(lease);
		} finally {
			await close();
		}
	} finally {
		child.kill();
	}
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
