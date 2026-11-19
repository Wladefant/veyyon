/**
 * WHY: a burst of same-process callers (twenty subagent spawns reserving host lanes at once)
 * exhausted their retries against each other, and a release that could not remove its lock
 * directory left the lock behind forever. That leftover's owner record names a live process (the
 * one that gave it up), and liveness is the only proof of abandonment, so every later acquire in
 * that process failed until it exited. On Windows, concurrent reads of the owner record make the
 * release rename fail with EPERM, so the burst produced the leak.
 *
 * Class closed: same-process contenders take turns instead of spending retries on each other, and
 * no release failure (sharing violation, persistent error, exhausted busy budget), async or sync,
 * can block the process that owned the lock. A transient Windows sharing violation no longer fails
 * the release at all. A holder that never releases still makes its in-process successor fail
 * within the retry budget rather than hang.
 * Gap: a lock leaked by ANOTHER live process still blocks until that process exits; that is the
 * exclusivity contract, not this defect.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, acquireFileLock, withFileLockSync } from "../src/file-lock";
import { withLogRedaction } from "../src/logger";
import { removeWithRetries } from "../src/temp";

const { getLockPath } = __internalsForTesting;
const roots: string[] = [];
const restores: Array<() => void> = [];

async function target(name: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-leak-"));
	roots.push(root);
	return path.join(root, `${name}.json`);
}

function denied(): Error {
	return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

afterAll(async () => {
	for (const root of roots) await removeWithRetries(root).catch(() => {});
});

describe("contenders in one process", () => {
	// The budget covers one holder's turn but not the whole burst: without the in-process queue, the
	// late contenders spend it waiting on the early ones and fail.
	test.each([20, 40])("lets %i concurrent callers in one process all take it within a per-turn budget", async n => {
		const file = await target(`burst-${n}`);
		let inside = 0;
		let maxInside = 0;
		let done = 0;
		await Promise.all(
			Array.from({ length: n }, () =>
				acquireFileLock(file, { retries: 10, retryDelayMs: 5 }).then(async handle => {
					inside += 1;
					maxInside = Math.max(maxInside, inside);
					await fs.stat(file).catch(() => {});
					inside -= 1;
					done += 1;
					await handle.release();
				}),
			),
		);
		expect(done).toBe(n);
		expect(maxInside).toBe(1);
		expect(fsSync.existsSync(getLockPath(file))).toBe(false);
	});

	test("a holder that never releases makes the next in-process caller fail within its budget", async () => {
		const file = await target("hung-holder");
		const held = await acquireFileLock(file, { queueContext: { owner: "HoldingLane", site: "test/acquire" } });
		const started = Date.now();
		try {
			await expect(acquireFileLock(file, { retries: 5, retryDelayMs: 10 })).rejects.toThrow(
				/queue made no progress for 50ms \(owner=HoldingLane, site=test\/acquire, ageMs=\d+, phase=holding; reap not attempted\)/,
			);
		} finally {
			await held.release();
		}
		expect(Date.now() - started).toBeLessThan(2_000);
		const next = await acquireFileLock(file, { retries: 1, retryDelayMs: 0 });
		await next.release();
	});

	test("short waiters timing out do not renew another waiter's budget", async () => {
		const file = await target("hung-holder-with-churn");
		const held = await acquireFileLock(file);
		const started = performance.now();
		const longWait = acquireFileLock(file, { retries: 50, retryDelayMs: 10 }).then(
			async handle => {
				await handle.release();
				throw new Error("Waiter acquired the lock while the holder still had it");
			},
			(error: unknown) => ({ error, elapsed: performance.now() - started }),
		);
		try {
			for (let attempt = 0; attempt < 10; attempt++) {
				await expect(acquireFileLock(file, { retries: 1, retryDelayMs: 100 })).rejects.toThrow(
					"in-process queue made no progress",
				);
			}
			const { error, elapsed } = await longWait;
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("in-process queue made no progress");
			expect(elapsed).toBeLessThan(900);
		} finally {
			await held.release();
		}
		const next = await acquireFileLock(file, { retries: 10, retryDelayMs: 10 });
		await next.release();
	});
});

describe("a lock whose release failed", () => {
	test("is reaped by the next async acquire in the process that owned it", async () => {
		const file = await target("async-leak");
		const lockPath = getLockPath(file);
		const handle = await acquireFileLock(file);
		const realRename = fs.rename;
		const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (String(source) === lockPath) throw denied();
			return realRename(source, destination);
		});
		restores.push(() => rename.mockRestore());
		const output: string[] = [];
		await withLogRedaction(
			line => {
				output.push(line);
				return line;
			},
			() => handle.release(),
		);
		const failure = output.find(line => line.includes("could not remove the lock"));
		expect(failure).toContain("EPERM");
		expect(failure).toContain("can retry cleanup only after the error clears");
		rename.mockRestore();
		expect(fsSync.existsSync(lockPath)).toBe(true);

		const next = await acquireFileLock(file, { retries: 1, retryDelayMs: 0 });
		await next.release();
		expect(fsSync.existsSync(lockPath)).toBe(false);
	});

	test("a sync reap retires the old owner's token", async () => {
		const file = await target("sync-leak");
		const lockPath = getLockPath(file);
		const realRename = fsSync.renameSync;
		const rename = spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
			if (String(source) === lockPath) throw denied();
			return realRename(source, destination);
		});
		restores.push(() => rename.mockRestore());
		withFileLockSync(file, () => {});
		rename.mockRestore();
		expect(fsSync.existsSync(lockPath)).toBe(true);
		const ownerInfo = await fs.readFile(path.join(lockPath, "info"));
		expect(__internalsForTesting.isLockStaleSync(lockPath, 0)).toBe(true);

		let ran = false;
		withFileLockSync(
			file,
			() => {
				ran = true;
			},
			{ retries: 1, retryDelayMs: 0 },
		);
		expect(ran).toBe(true);
		expect(fsSync.existsSync(lockPath)).toBe(false);
		await fs.mkdir(lockPath);
		await fs.writeFile(path.join(lockPath, "info"), ownerInfo);
		expect(__internalsForTesting.isLockStaleSync(lockPath, 0)).toBe(false);
	});

	test.if(process.platform === "win32")(
		"is not left behind when a Windows sharing violation clears within the release budget",
		async () => {
			const file = await target("transient");
			const lockPath = getLockPath(file);
			const handle = await acquireFileLock(file);
			const realRename = fs.rename;
			let refusals = 0;
			const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (String(source) === lockPath && refusals < 3) {
					refusals += 1;
					throw denied();
				}
				return realRename(source, destination);
			});
			restores.push(() => rename.mockRestore());
			await handle.release();
			expect(refusals).toBe(3);
			expect(fsSync.existsSync(lockPath)).toBe(false);
		},
	);
});
