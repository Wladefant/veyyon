import { expect, test } from "bun:test";
import { attachSessionOwner, detachSessionOwner, KernelSessionPool } from "../executor-base";
import { type SessionKernel, UnconfirmedKernelStartupError } from "../kernel-base";

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

function fakeKernel(counter: { shutdowns: number }, release?: Promise<void>, onShutdown?: () => void): SessionKernel {
	return {
		execute: async () => ({ status: "ok", cancelled: false, timedOut: false, stdinRequested: false }),
		isAlive: () => true,
		shutdown: async () => {
			counter.shutdowns++;
			onShutdown?.();
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
	const shutdownStarted = Promise.withResolvers<void>();
	const counter = { shutdowns: 0 };
	const lateKernel = fakeKernel(counter, releaseGate.promise, () => shutdownStarted.resolve());
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
	await shutdownStarted.promise;
	expect(counter.shutdowns).toBe(1);
	let acquired = false;
	const acquiring = pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "b" }).then(session => {
		acquired = true;
		return session;
	});
	await Promise.resolve();
	expect(acquired).toBe(false);
	expect(starts).toBe(1);
	releaseGate.resolve();
	await starting;
	const next = await acquiring;
	expect(next.kernel).toBe(freshKernel);
	expect(starts).toBe(2);
	expect(counter.shutdowns).toBe(1);
	expect(pool.sessions.get("key")).toBe(next);
});


// Bounded race to observe whether unauthenticated reset attempts synchronously reject before baseline hangs on fake shutdown gate.
async function observeOutcome<T>(
	promise: Promise<T>,
	timeoutMs = 150,
): Promise<{ status: "rejected"; error: unknown } | { status: "resolved"; value: T } | { status: "pending" }> {
	let timer: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<{ status: "pending" }>(resolve => {
		timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
	});
	try {
		return await Promise.race([
			promise.then(
				value => ({ status: "resolved" as const, value }),
				error => ({ status: "rejected" as const, error }),
			),
			timeoutPromise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

test("only the primary owner can reset a shared kernel session", async () => {
	const counter = { shutdowns: 0 };
	const release = Promise.withResolvers<void>();
	const shutdownStarted = Promise.withResolvers<void>();
	const kernel = fakeKernel(counter, release.promise, () => shutdownStarted.resolve());
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "primary-reset-owner",
		startKernel: async () => kernel,
	});
	let ownerReset: Promise<void> | undefined;
	try {
		const primary = await pool.acquireSession("shared", "session", process.cwd(), { kernelOwnerId: "owner-a" });
		await pool.acquireSession("shared", "session", process.cwd(), { kernelOwnerId: "owner-b" });

		const firstReset = pool.resetSession("shared", "owner-b");
		const firstOutcome = await observeOutcome(firstReset);
		expect(firstOutcome.status).toBe("rejected");
		if (firstOutcome.status === "rejected") {
			expect(String((firstOutcome.error as Error)?.message ?? firstOutcome.error)).toMatch(/primary kernel owner/);
		}
		expect(pool.sessions.get("shared")).toBe(primary);
		expect(counter.shutdowns).toBe(0);

		ownerReset = pool.resetSession("shared", "owner-a");
		await Promise.race([
			shutdownStarted.promise,
			new Promise<never>((_, rej) => setTimeout(() => rej(new Error("shutdown did not start")), 1000)),
		]);

		const concurrentReset = pool.resetSession("shared", "owner-b");
		const concurrentOutcome = await observeOutcome(concurrentReset);
		expect(concurrentOutcome.status).toBe("rejected");
		if (concurrentOutcome.status === "rejected") {
			expect(String((concurrentOutcome.error as Error)?.message ?? concurrentOutcome.error)).toMatch(
				/primary kernel owner/,
			);
		}

		release.resolve();
		await ownerReset;
		expect(counter.shutdowns).toBe(1);
		expect(pool.sessions.has("shared")).toBe(false);
	} finally {
		release.resolve();
		await ownerReset?.catch(() => {});
	}
}, 5000);

test("disposing primary owner transfers custody to surviving co-owner and refuses reset by departed owner", async () => {
	const counter = { shutdowns: 0 };
	const release = Promise.withResolvers<void>();
	const kernel = fakeKernel(counter, release.promise);
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "departing-primary-owner",
		startKernel: async () => kernel,
	});
	let ownerReset: Promise<void> | undefined;
	try {
		const session = await pool.acquireSession("shared", "session", process.cwd(), { kernelOwnerId: "owner-a" });
		await pool.acquireSession("shared", "session", process.cwd(), { kernelOwnerId: "owner-b" });
		expect(session.primaryOwnerId).toBe("owner-a");
		expect([...session.ownerIds]).toEqual(["owner-a", "owner-b"]);

		// Dispose primary owner A while B remains
		await pool.disposeByOwner("owner-a");
		expect([...session.ownerIds]).toEqual(["owner-b"]);
		expect(session.primaryOwnerId).toBe("owner-b");
		expect(counter.shutdowns).toBe(0);
		expect(pool.sessions.get("shared")).toBe(session);

		// Departed owner A cannot reset B's surviving kernel
		const departedReset = pool.resetSession("shared", "owner-a");
		const departedOutcome = await observeOutcome(departedReset);
		expect(departedOutcome.status).toBe("rejected");
		if (departedOutcome.status === "rejected") {
			expect(String((departedOutcome.error as Error)?.message ?? departedOutcome.error)).toMatch(/primary kernel owner/);
		}
		expect(counter.shutdowns).toBe(0);
		expect(pool.sessions.get("shared")).toBe(session);

		// Surviving owner B can reset the kernel
		ownerReset = pool.resetSession("shared", "owner-b");
		release.resolve();
		await ownerReset;
		expect(counter.shutdowns).toBe(1);
		expect(pool.sessions.has("shared")).toBe(false);
	} finally {
		release.resolve();
		await ownerReset?.catch(() => {});
	}
});

test("detachSessionOwner transfers primaryOwnerId to next surviving owner", () => {
	const session = {
		ownerIds: new Set<string>(["owner-a", "owner-b", "owner-c"]),
		primaryOwnerId: "owner-a" as string | undefined,
	};
	detachSessionOwner(session, "owner-b");
	expect(session.primaryOwnerId).toBe("owner-a");
	expect([...session.ownerIds]).toEqual(["owner-a", "owner-c"]);

	detachSessionOwner(session, "owner-a");
	expect(session.primaryOwnerId).toBe("owner-c");
	expect([...session.ownerIds]).toEqual(["owner-c"]);

	detachSessionOwner(session, "owner-c");
	expect(session.primaryOwnerId).toBeUndefined();
	expect([...session.ownerIds]).toEqual([]);
});

test("attachSessionOwner preserves primaryOwnerId when a later explicit co-owner attaches", () => {
	const session = {
		ownerIds: new Set<string>(),
		hasFallbackOwner: false,
		primaryOwnerId: undefined as string | undefined,
	};
	attachSessionOwner(session, "session-1", "owner-a");
	expect(session.primaryOwnerId).toBe("owner-a");
	expect(session.hasFallbackOwner).toBe(false);
	expect([...session.ownerIds]).toEqual(["owner-a"]);

	attachSessionOwner(session, "session-1", "owner-b");
	expect(session.primaryOwnerId).toBe("owner-a");
	expect(session.hasFallbackOwner).toBe(false);
	expect([...session.ownerIds]).toEqual(["owner-a", "owner-b"]);
});

test("attachSessionOwner replaces fallback owner and assigns primaryOwnerId to the first explicit owner", () => {
	const session = {
		ownerIds: new Set<string>(),
		hasFallbackOwner: false,
		primaryOwnerId: undefined as string | undefined,
	};
	attachSessionOwner(session, "session-fallback", undefined);
	expect(session.primaryOwnerId).toBe("session-fallback");
	expect(session.hasFallbackOwner).toBe(true);

	attachSessionOwner(session, "session-fallback", "owner-first");
	expect(session.primaryOwnerId).toBe("owner-first");
	expect(session.hasFallbackOwner).toBe(false);

	attachSessionOwner(session, "session-fallback", "owner-second");
	expect(session.primaryOwnerId).toBe("owner-first");
	expect([...session.ownerIds]).toEqual(["owner-first", "owner-second"]);
});

test("resetSession retires both failed startup and registered session", async () => {
	const counter = { shutdowns: 0 };
	const unconfirmedKernel = fakeKernel(counter);
	const activeKernel = fakeKernel(counter);
	let startAttempts = 0;
	const pool = new KernelSessionPool({
		languageName: "Python",
		logLabel: "reset-failed-and-active",
		startKernel: async () => {
			startAttempts += 1;
			if (startAttempts === 1) {
				return activeKernel;
			}
			throw new UnconfirmedKernelStartupError(unconfirmedKernel, new Error("startup failed"));
		},
	});

	const session = await pool.acquireSession("shared-key", "sess-1", process.cwd(), { kernelOwnerId: "primary-owner" });
	expect(session.kernel).toBe(activeKernel);
	expect(pool.sessions.get("shared-key")).toBe(session);

	// Trigger replaceSessionKernel which calls startKernel (attempt 2), throwing UnconfirmedKernelStartupError
	// and populating #failedStartups on the pool.
	await expect(pool.replaceSessionKernel(session, process.cwd(), { kernelOwnerId: "primary-owner" })).rejects.toThrow(
		"startup failed",
	);
	// replaceSessionKernel shut down activeKernel once, and retained unconfirmedKernel in #failedStartups
	expect(counter.shutdowns).toBe(1);
	expect(pool.sessions.get("shared-key")).toBe(session);

	// resetSession should retire the failed startup (unconfirmedKernel) AND the active session (activeKernel)
	await pool.resetSession("shared-key", "primary-owner");
	expect(counter.shutdowns).toBe(3);
	expect(pool.sessions.has("shared-key")).toBe(false);
});
