import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartTime } from "@veyyon/utils/process-liveness";
import { acquireBrokerLease, type BrokerLeaseClock, releaseBrokerLease } from "../../src/launch/broker-lease";
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

type Handlers = { onConnect?: (socket: net.Socket) => void; onLine?: (socket: net.Socket, line: string) => void };

/** A listener on the broker endpoint. */
async function listen(dir: string, handlers: Handlers): Promise<() => Promise<void>> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		let buffered = "";
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", chunk => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline >= 0) handlers.onLine?.(socket, buffered.slice(0, newline));
		});
		handlers.onConnect?.(socket);
	});
	await new Promise<void>(resolve => server.listen(daemonBrokerEndpoint(dir), resolve));
	return () =>
		new Promise<void>(resolve => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		});
}

/** What a real broker answers to an authenticated ping. */
function brokerPing(pid: number | undefined): Handlers {
	return {
		onLine: (socket, line) => {
			const request = JSON.parse(line) as { id: string; token: string };
			const ok = request.token === "test-token";
			const result = ok
				? { id: request.id, ok, result: { op: "ping", projectDir: "/p", pid } }
				: { id: request.id, ok };
			socket.write(`${JSON.stringify(result)}\n`);
		},
	};
}

/** A real live process the lease can name; resolves once it is running. */
async function liveChild(): Promise<{ pid: number; startedAt: number; kill: () => void }> {
	const child = Bun.spawn([process.execPath, "-e", 'console.log("up"); setInterval(() => {}, 1000)'], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	await child.stdout.getReader().read();
	const startedAt = getProcessStartTime(child.pid);
	if (startedAt === null) throw new Error("child start time unavailable");
	return { pid: child.pid, startedAt, kill: () => child.kill() };
}

/** Writes a legacy PID-only record whose mtime is `mtimeMs`, plus the runtime token the ping needs. */
async function legacyLease(dir: string, pid: number, mtimeMs: number): Promise<{ leasePath: string; record: string }> {
	const leasePath = daemonBrokerLeasePath(dir);
	const record = JSON.stringify({ pid });
	await fs.writeFile(leasePath, record);
	await fs.utimes(leasePath, mtimeMs / 1_000, mtimeMs / 1_000);
	await fs.writeFile(daemonBrokerTokenPath(dir), "test-token");
	return { leasePath, record };
}

/** Boot far in the past, so the record never predates it; isolates the endpoint and age rules. */
const NEVER_REBOOTED = { bootTimeMs: () => 0 };
/** A record written 10 s before the child started: the start time is later than the record, as after a clock step. */
const justBeforeStart = (startedAt: number) => startedAt - 10_000;

async function expectReclaimed(dir: string, clock: BrokerLeaseClock) {
	const lease = await acquireBrokerLease(dir, clock);
	expect(lease).not.toBeNull();
	if (lease) await releaseBrokerLease(lease);
}

it("keeps a live legacy owner whose process start time shifted past its record after a clock step", async () => {
	// A forward wall-clock step moves the btime-derived start time after the record's mtime,
	// which is exactly what an mtime of 1 against a live process reproduces.
	expect(getProcessStartTime(process.pid)).not.toBeNull();
	const dir = await runtime();
	const { leasePath, record } = await legacyLease(dir, process.pid, 1_000);
	const close = await listen(dir, brokerPing(process.pid));
	try {
		expect(await acquireBrokerLease(dir, NEVER_REBOOTED)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		await close();
	}
});

it("keeps a live legacy owner with an ambiguous start time when its endpoint is absent", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const { leasePath, record } = await legacyLease(dir, child.pid, justBeforeStart(child.startedAt));
		expect(await acquireBrokerLease(dir, NEVER_REBOOTED)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		child.kill();
	}
});

it("keeps a live legacy owner that stopped listening but is still running", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const { leasePath, record } = await legacyLease(dir, child.pid, justBeforeStart(child.startedAt));
		const close = await listen(dir, brokerPing(child.pid));
		await close();
		expect(await acquireBrokerLease(dir, NEVER_REBOOTED)).toBeNull();
		expect(await fs.readFile(leasePath, "utf8")).toBe(record);
	} finally {
		child.kill();
	}
});

it("keeps a live legacy owner when the endpoint closes the connection without answering", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const { leasePath, record } = await legacyLease(dir, child.pid, justBeforeStart(child.startedAt));
		const close = await listen(dir, { onConnect: socket => socket.end() });
		try {
			expect(await acquireBrokerLease(dir, NEVER_REBOOTED)).toBeNull();
			expect(await fs.readFile(leasePath, "utf8")).toBe(record);
		} finally {
			await close();
		}
	} finally {
		child.kill();
	}
});

it("bounds the ping by one absolute deadline when a peer trickles bytes", async () => {
	const dir = await runtime();
	const child = await liveChild();
	let trickle: NodeJS.Timeout | undefined;
	try {
		const { leasePath, record } = await legacyLease(dir, child.pid, justBeforeStart(child.startedAt));
		// A real wall-clock delay is the thing under test: the peer sends one byte every 100 ms, forever.
		const close = await listen(dir, {
			onConnect: socket => {
				trickle = setInterval(() => socket.write("x"), 100);
			},
		});
		try {
			const startedAt = performance.now();
			expect(await acquireBrokerLease(dir, NEVER_REBOOTED)).toBeNull();
			expect(performance.now() - startedAt).toBeLessThan(1_500);
			expect(await fs.readFile(leasePath, "utf8")).toBe(record);
		} finally {
			clearInterval(trickle);
			await close();
		}
	} finally {
		child.kill();
	}
});

it("reclaims a live legacy lease when an authenticated broker answers as a different PID", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		await legacyLease(dir, child.pid, justBeforeStart(child.startedAt));
		const close = await listen(dir, brokerPing(child.pid + 1));
		try {
			await expectReclaimed(dir, NEVER_REBOOTED);
		} finally {
			await close();
		}
	} finally {
		child.kill();
	}
});

it("reclaims a live legacy lease whose record predates the current boot", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const mtimeMs = justBeforeStart(child.startedAt);
		await legacyLease(dir, child.pid, mtimeMs);
		// The reused PID belongs to this boot; the record was written an hour before it.
		await expectReclaimed(dir, { bootTimeMs: () => mtimeMs + 60 * 60 * 1_000 });
	} finally {
		child.kill();
	}
});

it("reclaims an inconclusive legacy lease once it is older than the maximum age, and not before", async () => {
	const dir = await runtime();
	const child = await liveChild();
	try {
		const mtimeMs = justBeforeStart(child.startedAt);
		const { leasePath, record } = await legacyLease(dir, child.pid, mtimeMs);
		const day = 24 * 60 * 60 * 1_000;
		// An unrelated listener that answers garbage proves nothing either way.
		const close = await listen(dir, { onLine: socket => socket.end("not a broker\n") });
		try {
			expect(await acquireBrokerLease(dir, { ...NEVER_REBOOTED, now: () => mtimeMs + day - 1_000 })).toBeNull();
			expect(await fs.readFile(leasePath, "utf8")).toBe(record);
			await expectReclaimed(dir, { ...NEVER_REBOOTED, now: () => mtimeMs + day + 1_000 });
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
