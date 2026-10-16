/**
 * The daemon broker's PID lease: the one file that selects a single broker per runtime directory when
 * several clients spawn one at once.
 *
 * A claim is written in full to a file of its own and published with a hard link. `link` fails with
 * `EEXIST` when another candidate published first, and the lease path never names an empty or
 * half-written file, so a candidate that reads it reads a whole claim. A lease created empty and
 * written afterwards was read as stale by a racing candidate, which removed it and took the lease too.
 *
 * Removing a stale lease is not atomic with the read that judged it stale. Two candidates that find
 * the same dead owner can each remove it, and the later removal can take the earlier candidate's new
 * lease with it.
 */
import * as fs from "node:fs/promises";
import { isEexist, isEnoent, isProcessAlive } from "@veyyon/utils";
import { daemonBrokerLeasePath } from "./paths";

/** A lease this process holds. */
export interface BrokerLease {
	path: string;
	instanceId: string;
}

/** The claim a lease file holds, or undefined for a file that holds none. */
function parseClaim(text: string): { pid: number; instanceId: string } | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	if (!("pid" in raw) || typeof raw.pid !== "number") return undefined;
	if (!("instanceId" in raw) || typeof raw.instanceId !== "string") return undefined;
	return { pid: raw.pid, instanceId: raw.instanceId };
}

/** True when the lease at `leasePath` names a running process. */
async function leaseHasLiveOwner(leasePath: string): Promise<boolean> {
	let text: string;
	try {
		// fs.readFile, not Bun.file().text(): a Bun.file read does not ref the event loop, so a broker
		// that reaches this await with nothing else pending can exit 0 mid-read.
		text = await fs.readFile(leasePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	const claim = parseClaim(text);
	return claim !== undefined && isProcessAlive(claim.pid);
}

/**
 * Take the broker lease in `runtimeDir`, or return null when a running broker holds it. A lease that
 * names a dead process, or holds no claim, is removed and taken.
 */
export async function acquireBrokerLease(runtimeDir: string): Promise<BrokerLease | null> {
	const leasePath = daemonBrokerLeasePath(runtimeDir);
	const instanceId = crypto.randomUUID();
	const claimPath = `${leasePath}.${instanceId}.claim`;
	await fs.writeFile(claimPath, JSON.stringify({ pid: process.pid, instanceId }), {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.link(claimPath, leasePath);
				return { path: leasePath, instanceId };
			} catch (error) {
				if (!isEexist(error)) throw error;
			}
			if (await leaseHasLiveOwner(leasePath)) return null;
			await fs.rm(leasePath, { force: true });
		}
		return null;
	} finally {
		await fs.rm(claimPath, { force: true });
	}
}

/** Remove the lease if it is still `lease`; a lease another broker has taken since is left in place. */
export async function releaseBrokerLease(lease: BrokerLease): Promise<void> {
	let text: string;
	try {
		text = await fs.readFile(lease.path, "utf8");
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (parseClaim(text)?.instanceId === lease.instanceId) await fs.rm(lease.path, { force: true });
}
