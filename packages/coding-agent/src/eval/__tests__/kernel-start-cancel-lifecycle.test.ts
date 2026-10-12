import { expect, test } from "bun:test";
import { KernelSessionPool } from "../executor-base";
import type { SessionKernel } from "../kernel-base";

test("cancelled startup releases its late kernel instead of losing ownership", async () => {
	const ready = Promise.withResolvers<SessionKernel>();
	let shutdowns = 0;
	const kernel: SessionKernel = {
		execute: async () => ({ status: "ok", cancelled: false, timedOut: false, stdinRequested: false }),
		isAlive: () => true,
		shutdown: async () => {
			shutdowns++;
			return { confirmed: true };
		},
	};
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "cancel-test",
		startKernel: () => ready.promise,
	});
	const abort = new AbortController();
	const acquiring = pool.acquireSession("key", "session", process.cwd(), {
		kernelOwnerId: "lane",
		signal: abort.signal,
	});
	const starting = pool.startingSessions.get("key")?.promise;
	abort.abort(new Error("lane cancelled"));
	await expect(acquiring).rejects.toThrow();
	ready.resolve(kernel);
	await starting;
	expect(shutdowns).toBe(1);
	expect(pool.sessions.size).toBe(0);
	expect(pool.startingSessions.size).toBe(0);
});

function fakeKernel(counter: { shutdowns: number }, release?: Promise<void>): SessionKernel {
	return {
		execute: async () => ({ status: "ok", cancelled: false, timedOut: false, stdinRequested: false }),
		isAlive: () => true,
		shutdown: async () => {
			counter.shutdowns++;
			await release;
			return { confirmed: true };
		},
	};
}

test("a cancelled waiter keeps the kernel while another waiter of the same owner is still starting it", async () => {
	const ready = Promise.withResolvers<SessionKernel>();
	const counter = { shutdowns: 0 };
	const kernel = fakeKernel(counter);
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "same-owner-test",
		startKernel: () => ready.promise,
	});
	const abort = new AbortController();
	const first = pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "lane", signal: abort.signal });
	const second = pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "lane" });
	abort.abort(new Error("first call cancelled"));
	await expect(first).rejects.toThrow();
	ready.resolve(kernel);
	const session = await second;
	expect(session.kernel).toBe(kernel);
	expect(counter.shutdowns).toBe(0);
	expect(pool.sessions.get("key")).toBe(session);
	expect([...session.ownerIds]).toEqual(["lane"]);
});

test("a caller arriving while an abandoned startup is being released gets a fresh kernel", async () => {
	const first = Promise.withResolvers<SessionKernel>();
	const releaseGate = Promise.withResolvers<void>();
	const counter = { shutdowns: 0 };
	const lateKernel = fakeKernel(counter, releaseGate.promise);
	const freshKernel = fakeKernel(counter);
	let starts = 0;
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "release-window-test",
		startKernel: () => (++starts === 1 ? first.promise : Promise.resolve(freshKernel)),
	});
	const abort = new AbortController();
	const cancelled = pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "a", signal: abort.signal });
	const starting = pool.startingSessions.get("key")?.promise;
	abort.abort(new Error("lane cancelled"));
	await expect(cancelled).rejects.toThrow();
	first.resolve(lateKernel);
	await Bun.sleep(0);
	expect(counter.shutdowns).toBe(1);
	const next = await pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "b" });
	expect(next.kernel).toBe(freshKernel);
	releaseGate.resolve();
	await starting;
	expect(counter.shutdowns).toBe(1);
	expect(pool.sessions.get("key")).toBe(next);
});
