// The same-process queue must wait beyond the filesystem retry budget without
// stealing a live transaction. These tests do not model cross-process sharing violations.
import { afterEach, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import {
	acquireLaneAdmission,
	getLaneAdmissionLedgerPath,
	type LaneAdmissionAcquireResult,
	releaseLaneAdmission,
} from "@veyyon/coding-agent/task/lane-admission";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const acquire = (owner: string) => acquireLaneAdmission({ owner, kind: "external" });

async function holdTransaction() {
	const ledger = getLaneAdmissionLedgerPath();
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const read = fsp.readFile;
	const spy = vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof read>) => {
		if (args[0] === ledger) {
			spy.mockRestore();
			entered.resolve();
			await resume.promise;
		}
		return read(...args);
	}) as typeof read);
	const holder = acquire("holder");
	await entered.promise;
	return { holder, resume: resume.resolve };
}

function trackWaiters() {
	vi.useFakeTimers();
	let count = 0;
	const schedule = globalThis.setTimeout;
	const wait = (...args: Parameters<typeof schedule>) => {
		const handle = schedule(...args);
		if (args[1] === 45_000) count++;
		return handle;
	};
	vi.spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(wait, { __promisify__: schedule.__promisify__ }));
	return () => count;
}

async function release(admission: LaneAdmissionAcquireResult) {
	if (!admission.admitted || !admission.slot_id || !admission.lease_token) {
		throw new Error(`Admission failed: ${admission.reason}`);
	}
	expect(await releaseLaneAdmission({ slotId: admission.slot_id, leaseToken: admission.lease_token })).toMatchObject({
		released: true,
	});
	return admission.slot_id;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("admits an eight-lane burst after an eight-second ledger stall", async () => {
	const isolated = enterIsolatedConfigRoot("lane-ledger-burst", { defaultProfile: true });
	try {
		const { holder, resume } = await holdTransaction();
		const queued = trackWaiters();
		const waiters = Array.from({ length: 8 }, (_, i) => acquire(`waiter-${i}`));
		const outcomes = Promise.allSettled([holder, ...waiters]);
		try {
			expect(queued()).toBe(8);
			vi.advanceTimersByTime(8_000);
		} finally {
			resume();
			await outcomes;
		}
		const slots = await Promise.all((await Promise.all([holder, ...waiters])).map(release));
		expect(new Set(slots).size).toBe(9);
	} finally {
		isolated.restore();
	}
}, 15_000);

it("reports a stuck transaction at the queue deadline without clearing the holder", async () => {
	const isolated = enterIsolatedConfigRoot("lane-ledger-timeout", { defaultProfile: true });
	try {
		const { holder, resume } = await holdTransaction();
		const queued = trackWaiters();
		const first = acquire("deadline-waiter");
		const failure = first.then(() => "unexpected admission", error => String(error));
		try {
			expect(queued()).toBe(1);
			vi.advanceTimersByTime(45_000);
			const detail = await failure;
			expect(detail).toContain("no progress for 45000 ms");
			expect(detail).toContain(`PID ${process.pid}`);
			expect(detail).toContain("acquire (holding)");
			await fsp.access(`${getLaneAdmissionLedgerPath()}.lock/info`);
		} finally {
			resume();
			await Promise.allSettled([holder, first]);
		}
		await release(await holder);
		await release(await acquire("after-timeout"));
	} finally {
		isolated.restore();
	}
}, 15_000);
