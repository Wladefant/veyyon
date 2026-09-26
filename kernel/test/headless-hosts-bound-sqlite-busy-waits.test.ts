import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { getDbBusyTimeoutMs, setInteractiveHost, TempDir } from "@veyyon/utils";

// WHY: Headless hosts (print/RPC/ACP/eval/SDK, including subagents) share a thread with
// bun:sqlite. A 5-second busy_timeout on SQLite lock contention freezes the event loop
// with zero liveness signal. Headless hosts must bound the synchronous wait to 1s so
// contention fails fast rather than stalling the protocol loop for 5s.
//
// What this suite does NOT catch: Asynchronous retry loops above SQLite that may retry
// multiple times, or WAL checkpoint background operations initiated outside the agent process.

describe("headless host SQLite busy timeout", () => {
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		HistoryStorage.resetInstance();
	});

	afterEach(async () => {
		HistoryStorage.resetInstance();
		if (tempDir) {
			await tempDir.remove().catch(() => {});
			tempDir = null;
		}
	});

	// Integration test exercising the native SQLite engine's busy_timeout: sqlite3_busy_timeout
	// spins in the native SQLite C layer on the platform clock when an exclusive lock is held,
	// so fake JS timers cannot advance native SQLite internal locks.
	it("does not block for 5 seconds on SQLite contention in headless hosts", async () => {

		tempDir = TempDir.createSync("@veyyon-busy-timeout-test-");
		const dbPath = tempDir.join("history.db");
		// Initialize the database schema
		const init = HistoryStorage.open(dbPath);
		HistoryStorage.resetInstance();

		// Hold an exclusive transaction on the database to simulate lock contention
		const locker = new Database(dbPath);
		locker.run("BEGIN EXCLUSIVE");

		const storage = HistoryStorage.open(dbPath);
		const t0 = performance.now();
		let caughtError: Error | null = null;
		try {
			await storage.add("test prompt", "/test/cwd");
		} catch (error) {
			caughtError = error as Error;
		} finally {
			locker.run("ROLLBACK");
			locker.close();
		}

		const elapsed = performance.now() - t0;
		expect(caughtError).not.toBeNull();
		expect(caughtError?.message).toContain("database is locked");
		// In headless hosts, timeout must be bounded (1s busy_timeout + drain overhead < 3000ms).
		// Without the fix, the 5000ms busy_timeout causes this operation to take > 5000ms.
		expect(elapsed).toBeLessThan(3000);
	});

	it("preserves the 5-second busy timeout for interactive hosts", () => {
		const prev = setInteractiveHost(true);
		try {
			expect(getDbBusyTimeoutMs()).toBe(5000);
		} finally {
			setInteractiveHost(prev);
		}
	});
});
