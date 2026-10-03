import * as fs from "node:fs/promises";
import { atomicWriteFile, isEnoent } from "@veyyon/utils";
import { tryWithFileLock, withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartIdentity, getProcessStartTime, isProcessInstanceAlive } from "@veyyon/utils/process-liveness";
import { daemonBrokerLeasePath } from "./paths";

export interface BrokerLease {
	path: string;
	instanceId: string;
}

/** Preserve unknown owners unless identity or a legacy creation-time comparison proves PID reuse. */
export function daemonOwnerIsAlive(raw: unknown, recordMtimeMs?: number): boolean {
	if (typeof raw !== "object" || raw === null || !("pid" in raw) || typeof raw.pid !== "number") return false;
	const identity = "processIdentity" in raw && typeof raw.processIdentity === "string" ? raw.processIdentity : null;
	if (!isProcessInstanceAlive(raw.pid, identity)) return false;
	if (identity !== null || recordMtimeMs === undefined) return true;
	const startedAt = getProcessStartTime(raw.pid);
	// Linux btime is second-granular. A two-second margin also protects coarse
	// legacy filesystem timestamps; inconclusive observations keep the owner.
	return startedAt === null || startedAt <= recordMtimeMs + 2_000;
}

export async function acquireBrokerLease(runtimeDir: string): Promise<BrokerLease | null> {
	const leasePath = daemonBrokerLeasePath(runtimeDir);
	// Serialize observation, stale retirement and publication. A bare wx retry can
	// delete a winner's freshly published lease when two starters observe a corpse.
	const result = await tryWithFileLock(leasePath, async () => {
		try {
			const text = await fs.readFile(leasePath, "utf8");
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				// No writer using this transition lock can still be publishing.
			}
			if (daemonOwnerIsAlive(raw, (await fs.stat(leasePath)).mtimeMs)) return null;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const instanceId = crypto.randomUUID();
		await atomicWriteFile(
			leasePath,
			JSON.stringify({ pid: process.pid, processIdentity: getProcessStartIdentity(process.pid), instanceId }),
		);
		return { path: leasePath, instanceId };
	});
	return result.acquired ? result.value : null;
}

export async function releaseBrokerLease(lease: BrokerLease): Promise<void> {
	await withFileLock(lease.path, async () => {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(lease.path, "utf8"));
			if (typeof raw === "object" && raw !== null && "instanceId" in raw && raw.instanceId === lease.instanceId) {
				await fs.rm(lease.path, { force: true });
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	});
}
