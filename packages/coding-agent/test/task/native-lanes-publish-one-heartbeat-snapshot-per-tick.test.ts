/**
 * WHY: overlapping native lanes used to publish a separate ledger replacement for each heartbeat.
 * Exercise the actual ledger across held writes, release, and separate cohorts. This does not simulate Windows disk stalls.
 */
import { expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import {
	acquireNativeHostLaneWait,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
	type LaneAdmissionLedger,
	type LaneReservation,
	type NativeHostLaneLease,
} from "@veyyon/coding-agent/task/lane-admission";
import { TempDir } from "@veyyon/utils";

type HeartbeatSnapshot = Pick<LaneReservation, "slotId" | "lastHeartbeatAt">[];

it("publishes one snapshot for all due native lanes and leaves released lanes out of the next snapshot", async () => {
	using dir = TempDir.createSync("@veyyon-heartbeat-batch-");
	const globalConfigRoot = dir.path();
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);
	const interval = 30_000;
	const start = Date.now();
	const handles: NativeHostLaneLease[] = [];
	const realRename = fsp.rename;
	const seen: HeartbeatSnapshot[] = [];
	let nextSnapshot = Promise.withResolvers<HeartbeatSnapshot>();

	vi.useFakeTimers();
	const clock = vi.spyOn(Date, "now").mockReturnValue(start);
	const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
		if (target !== ledgerPath) return realRename(source, target);
		const ledger = JSON.parse(await fsp.readFile(source, "utf8")) as LaneAdmissionLedger;
		const snapshot = ledger.reservations.map(({ slotId, lastHeartbeatAt }) => ({ slotId, lastHeartbeatAt }));
		await realRename(source, target);
		if (!snapshot.some(row => row.lastHeartbeatAt === Date.now() && row.lastHeartbeatAt !== start)) return;
		seen.push(snapshot);
		nextSnapshot.resolve(snapshot);
	});
	try {
		for (const owner of ["probe-a", "probe-b", "probe-c"]) {
			const lease = await acquireNativeHostLaneWait({ owner, globalConfigRoot, waitIfFull: false });
			if (!lease) throw new Error("Expected a live native lease");
			handles.push(lease);
		}

		const firstTick = start + interval;
		clock.mockReturnValue(firstTick);
		vi.advanceTimersByTime(interval);
		const first = handles.map(({ slotId }) => ({ slotId, lastHeartbeatAt: firstTick }));
		expect(await nextSnapshot.promise).toEqual(first);

		// Do not count the explicit fenced release as a heartbeat write.
		clock.mockReturnValue(firstTick + 1);
		await handles[0]!.release();
		nextSnapshot = Promise.withResolvers<HeartbeatSnapshot>();
		const secondTick = start + 2 * interval;
		clock.mockReturnValue(secondTick);
		vi.advanceTimersByTime(interval);
		const second = handles.slice(1).map(({ slotId }) => ({ slotId, lastHeartbeatAt: secondTick }));
		expect(await nextSnapshot.promise).toEqual(second);
		clock.mockReturnValue(secondTick + 1);
		await Promise.all(handles.slice(1).map(lease => lease.release()));
		expect(seen).toEqual([first, second]);
		expect((await getLaneAdmissionStatus({ globalConfigRoot })).reservations).toEqual([]);
	} finally {
		rename.mockRestore();
		clock.mockRestore();
		vi.useRealTimers();
		await Promise.all(handles.map(lease => lease.release()));
	}
}, 15_000);

it("skips a tick while its write is pending and checks every lease fence on the next tick", async () => {
	using dir = TempDir.createSync("@veyyon-heartbeat-fence-");
	using otherDir = TempDir.createSync("@veyyon-heartbeat-other-");
	const globalConfigRoot = dir.path();
	const ledgerPath = getLaneAdmissionLedgerPath(globalConfigRoot);
	const otherLedgerPath = getLaneAdmissionLedgerPath(otherDir.path());
	const interval = 30_000;
	const start = Date.now();
	const handles: NativeHostLaneLease[] = [];
	const realRename = fsp.rename;
	const held = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const next = Promise.withResolvers<void>();
	const seen: number[] = [];
	let fencedRow: LaneReservation | undefined;
	const otherTick = Promise.withResolvers<void>();

	const readLedger = async (target: string): Promise<LaneAdmissionLedger> =>
		JSON.parse(await fsp.readFile(target, "utf8")) as LaneAdmissionLedger;
	vi.useFakeTimers();
	const clock = vi.spyOn(Date, "now").mockReturnValue(start);
	const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
		if (target === otherLedgerPath) {
			const heartbeat = (await readLedger(String(source))).reservations[0]?.lastHeartbeatAt;
			await realRename(source, target);
			if (heartbeat === start + 2 * interval) otherTick.resolve();
			return;
		}
		if (target !== ledgerPath) return realRename(source, target);
		const heartbeat = (await readLedger(String(source))).reservations[0]?.lastHeartbeatAt;
		if (heartbeat !== undefined && heartbeat > start) {
			seen.push(heartbeat);
			if (seen.length === 1) {
				held.resolve();
				await resume.promise;
			}
		}
		await realRename(source, target);
		if (heartbeat === start + 3 * interval) next.resolve();
	});
	try {
		for (const [owner, root, cadence] of [
			["probe-live", globalConfigRoot, interval],
			["probe-fenced", globalConfigRoot, interval],
			["probe-other", otherDir.path(), 2 * interval],
		] as const) {
			const lease = await acquireNativeHostLaneWait({
				owner,
				globalConfigRoot: root,
				heartbeatIntervalMs: cadence,
				waitIfFull: false,
			});
			if (!lease) throw new Error("Expected a live native lease");
			handles.push(lease);
		}
		const ledger = await readLedger(ledgerPath);
		fencedRow = ledger.reservations[1]!;
		fencedRow.leaseToken = "fixture-other-lease";
		await fsp.writeFile(ledgerPath, JSON.stringify(ledger));

		clock.mockReturnValue(start + interval);
		vi.advanceTimersByTime(interval);
		await held.promise;
		expect((await readLedger(otherLedgerPath)).reservations[0]?.lastHeartbeatAt).toBe(start);
		clock.mockReturnValue(start + 2 * interval);
		vi.advanceTimersByTime(interval);
		await otherTick.promise;
		resume.resolve();
		const afterHold = await getLaneAdmissionStatus({ globalConfigRoot });
		expect(afterHold.reservations.map(row => row.lastHeartbeatAt)).toEqual([start + interval, start]);

		clock.mockReturnValue(start + 3 * interval);
		vi.advanceTimersByTime(interval);
		await next.promise;
		const afterNext = await getLaneAdmissionStatus({ globalConfigRoot });
		expect(afterNext.reservations.map(row => row.lastHeartbeatAt)).toEqual([start + 3 * interval, start]);
		expect(seen).toEqual([start + interval, start + 3 * interval]);
		const otherStatus = await getLaneAdmissionStatus({ globalConfigRoot: otherDir.path() });
		expect(otherStatus.reservations[0]?.lastHeartbeatAt).toBe(start + 2 * interval);
	} finally {
		resume.resolve();
		rename.mockRestore();
		clock.mockRestore();
		vi.useRealTimers();
		if (fencedRow) {
			await handles[0]!.release();
			const ledger = await readLedger(ledgerPath);
			const row = ledger.reservations.find(row => row.slotId === fencedRow?.slotId);
			if (row) row.leaseToken = handles[1]!.leaseToken;
			await fsp.writeFile(ledgerPath, JSON.stringify(ledger));
		}
		await Promise.all(handles.map(lease => lease.release()));
	}
}, 15_000);

it("keeps two cadences on one ledger and the same cadence on two ledgers independent", async () => {
	using dir = TempDir.createSync("@veyyon-heartbeat-ledger-");
	using otherDir = TempDir.createSync("@veyyon-heartbeat-ledger-");
	const root = dir.path();
	const otherRoot = otherDir.path();
	const interval = 30_000;
	const start = Date.now();
	const tick = start + interval;
	const handles: NativeHostLaneLease[] = [];
	const realMkdir = fsp.mkdir;

	vi.useFakeTimers();
	const clock = vi.spyOn(Date, "now").mockReturnValue(start);
	// Track the real directory operations that a tick starts before it enters the ledger lock queue.
	const setups: Promise<string | undefined>[] = [];
	const mkdir = vi.spyOn(fsp, "mkdir").mockImplementation((dir, options) => {
		const pending = realMkdir(dir, options);
		setups.push(pending);
		return pending;
	});
	try {
		for (const [owner, globalConfigRoot, heartbeatIntervalMs] of [
			["probe-fast", root, interval],
			["probe-slow", root, 2 * interval],
			["probe-other-fast", otherRoot, interval],
		] as const) {
			const lease = await acquireNativeHostLaneWait({
				owner,
				globalConfigRoot,
				heartbeatIntervalMs,
				waitIfFull: false,
			});
			if (!lease) throw new Error("Expected a live native lease");
			handles.push(lease);
		}
		setups.length = 0;
		clock.mockReturnValue(tick);
		vi.advanceTimersByTime(interval);
		await Promise.all(setups);
		// These status reads take the same locks, after any heartbeats submitted by this tick.
		const [main, other] = await Promise.all([
			getLaneAdmissionStatus({ globalConfigRoot: root }),
			getLaneAdmissionStatus({ globalConfigRoot: otherRoot }),
		]);
		expect(main.reservations.map(({ slotId, lastHeartbeatAt }) => ({ slotId, lastHeartbeatAt }))).toEqual([
			{ slotId: handles[0]!.slotId, lastHeartbeatAt: tick },
			{ slotId: handles[1]!.slotId, lastHeartbeatAt: start },
		]);
		expect(other.reservations.map(({ slotId, lastHeartbeatAt }) => ({ slotId, lastHeartbeatAt }))).toEqual([
			{ slotId: handles[2]!.slotId, lastHeartbeatAt: tick },
		]);
	} finally {
		mkdir.mockRestore();
		clock.mockRestore();
		vi.useRealTimers();
		await Promise.all(handles.map(lease => lease.release()));
	}
}, 15_000);
