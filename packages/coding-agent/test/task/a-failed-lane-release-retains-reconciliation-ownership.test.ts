/**
 * WHY: persistent ledger faults must bound teardown without freeing held capacity.
 * Real filesystem and retry timers are intentional; this does not simulate power loss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as laneModule from "@veyyon/coding-agent/task/lane-admission";
import {
	acquireLaneAdmission,
	acquireNativeHostLaneWait,
	acquireSubagentHostLane,
	getLaneAdmissionLedgerPath,
	getLaneAdmissionStatus,
} from "@veyyon/coding-agent/task/lane-admission";
import { logger } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

describe("persistent lane release recovery", () => {
	let isolated: IsolatedConfigRoot;
	beforeEach(() => {
		isolated = enterIsolatedConfigRoot("persistent-lane-release", { defaultProfile: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		isolated.restore();
	});

	it("escalates persistent corrupt-ledger release without borrowing an ended worker's fence", async () => {
		const lease = await acquireSubagentHostLane({
			agentId: "persistent-release",
			owner: "persistent-release",
			cap: 1,
		});
		const ledgerPath = getLaneAdmissionLedgerPath();
		const original = fs.readFileSync(ledgerPath, "utf8");
		const log = vi.spyOn(logger, "error");
		fs.writeFileSync(ledgerPath, "{");
		const release = lease!.release();
		// Real filesystem failures and retry timers must settle together; this deadline detects the former infinite loop.
		const deadline = new AbortController();
		let outcome: unknown;
		try {
			outcome = await Promise.race([
				release.then(
					() => "released",
					error => error,
				),
				delay(1_000, "unbounded", { signal: deadline.signal }),
			]);
		} finally {
			deadline.abort();
			fs.writeFileSync(ledgerPath, original);
			await release.catch(() => {});
		}
		expect(outcome).toMatchObject({ code: "lane_release_reconciliation_required" });
		expect(log.mock.calls).toEqual([
			[
				"Host lane release requires reconciliation",
				{
					operation: "lane-release",
					stage: "durable-release",
					errorCode: "lane_release_reconciliation_required",
				},
			],
		]);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);
		expect((await acquireLaneAdmission({ owner: "must-stay-full", kind: "native" })).admitted).toBe(false);
		const recovered = await acquireSubagentHostLane({
			agentId: "persistent-release",
			owner: "persistent-release",
			cap: 1,
		});
		expect(recovered!.slotId).not.toBe(lease!.slotId);
		await lease!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);
		await recovered!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("bounds cancelled acquisition compensation and permits fenced recovery after ledger repair", async () => {
		const controller = new AbortController();
		const realAcquire = laneModule.laneAdmissionDriver.acquire;
		let ledgerPath = "";
		let original = "";
		vi.spyOn(laneModule.laneAdmissionDriver, "acquire").mockImplementationOnce(async options => {
			const admitted = await realAcquire(options);
			ledgerPath = getLaneAdmissionLedgerPath();
			original = fs.readFileSync(ledgerPath, "utf8");
			fs.writeFileSync(ledgerPath, "{");
			controller.abort();
			return admitted;
		});
		const acquire = acquireNativeHostLaneWait({
			owner: "persistent-compensation",
			cap: 1,
			signal: controller.signal,
		});
		const deadline = new AbortController();
		let outcome: unknown;
		try {
			outcome = await Promise.race([
				acquire.then(
					() => "cancelled",
					error => error,
				),
				delay(1_000, "unbounded", { signal: deadline.signal }),
			]);
		} finally {
			deadline.abort();
			fs.writeFileSync(ledgerPath, original);
			await acquire.catch(() => {});
		}
		expect(outcome).toMatchObject({ code: "lane_release_reconciliation_required" });
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);
		const recovered = await acquireNativeHostLaneWait({
			owner: "persistent-compensation",
			cap: 1,
			waitIfFull: false,
		});
		expect(recovered).not.toBeNull();
		await recovered!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});

	it("bounds failed atomic replacements and retries the retained handle after access recovers", async () => {
		const lease = await acquireNativeHostLaneWait({ owner: "unwritable-release", cap: 1 });
		const ledgerPath = getLaneAdmissionLedgerPath();
		const original = fs.readFileSync(ledgerPath, "utf8");
		const realRename = fsp.rename;
		const rename = vi.spyOn(fsp, "rename").mockImplementation(async (source, target) => {
			if (String(target) === ledgerPath) {
				const error = new Error("synthetic denied replacement") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return realRename(source, target);
		});
		await expect(lease!.release()).rejects.toMatchObject({ code: "lane_release_reconciliation_required" });
		expect(fs.readFileSync(ledgerPath, "utf8")).toBe(original);
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(1);
		rename.mockRestore();
		await lease!.release();
		expect((await getLaneAdmissionStatus()).active_lanes).toBe(0);
	});
});
