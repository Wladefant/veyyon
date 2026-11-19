/**
 * WHY: overlapping native lanes used to publish a separate ledger replacement for each heartbeat.
 * Exercise the actual ledger and rotation on two ticks. This does not simulate Windows disk stalls.
 */
import { expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import {
	acquireNativeHostLaneWait,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
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
		await realRename(source, target);
		if (target !== ledgerPath) return;
		const ledger = JSON.parse(await fsp.readFile(ledgerPath, "utf8")) as { reservations: LaneReservation[] };
		const snapshot = ledger.reservations.map(({ slotId, lastHeartbeatAt }) => ({ slotId, lastHeartbeatAt }));
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
