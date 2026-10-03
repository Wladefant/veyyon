import * as fs from "node:fs/promises";
import { atomicWriteFile, isEnoent } from "@veyyon/utils";
import { tryWithFileLock, withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartIdentity, isProcessInstanceAlive } from "@veyyon/utils/process-liveness";
import { daemonBrokerLeasePath } from "./paths";

export interface BrokerLease {
	path: string;
	instanceId: string;
}

/** Unknown identity is not proof of death: preserve legacy and inaccessible owners. */
export function daemonOwnerIsAlive(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null || !("pid" in raw) || typeof raw.pid !== "number") return false;
	const identity = "processIdentity" in raw && typeof raw.processIdentity === "string" ? raw.processIdentity : null;
	return isProcessInstanceAlive(raw.pid, identity);
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
			if (daemonOwnerIsAlive(raw)) return null;
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
