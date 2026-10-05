import { expect, test } from "bun:test";
import { KernelSessionPool } from "../executor-base";
import type { SessionKernel } from "../kernel-base";

test("cancelled startup releases its late kernel instead of losing ownership", async () => {
	const ready = Promise.withResolvers<SessionKernel>();
	let shutdowns = 0;
	const kernel: SessionKernel = {
		execute: async () => ({ status: "ok" }),
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
