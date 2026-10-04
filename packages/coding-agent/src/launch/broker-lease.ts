import * as fs from "node:fs/promises";
import * as net from "node:net";
import { atomicWriteFile, isEnoent, logger } from "@veyyon/utils";
import { tryWithFileLock, withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartIdentity, getProcessStartTime, isProcessInstanceAlive } from "@veyyon/utils/process-liveness";
import { daemonBrokerEndpoint, daemonBrokerLeasePath } from "./paths";

export interface BrokerLease {
	path: string;
	instanceId: string;
}

/**
 * `legacy-reused` is a verdict from wall-clock arithmetic alone. Linux derives a
 * process start time from `btime`, which is the wall clock minus uptime, so a
 * system clock step after the legacy owner wrote its record (a WSL2 resume, an
 * NTP correction) moves it against the record's mtime and makes a live owner
 * look newer than its own record. No timestamp comparison can tell that from
 * real PID reuse, so the verdict needs an independent witness before it is
 * acted on.
 */
type DaemonOwnerVerdict = "dead" | "alive" | "legacy-reused";

function classifyDaemonOwner(raw: unknown, recordMtimeMs?: number): DaemonOwnerVerdict {
	if (typeof raw !== "object" || raw === null || !("pid" in raw) || typeof raw.pid !== "number") return "dead";
	const identity = "processIdentity" in raw && typeof raw.processIdentity === "string" ? raw.processIdentity : null;
	if (!isProcessInstanceAlive(raw.pid, identity)) return "dead";
	if (identity !== null || recordMtimeMs === undefined) return "alive";
	const startedAt = getProcessStartTime(raw.pid);
	// Linux btime is second-granular. A two-second margin also protects coarse
	// legacy filesystem timestamps; inconclusive observations keep the owner.
	return startedAt === null || startedAt <= recordMtimeMs + 2_000 ? "alive" : "legacy-reused";
}

/** Preserve unknown owners unless identity or a legacy creation-time comparison proves PID reuse. */
export function daemonOwnerIsAlive(raw: unknown, recordMtimeMs?: number): boolean {
	return classifyDaemonOwner(raw, recordMtimeMs) === "alive";
}

const ENDPOINT_PROBE_TIMEOUT_MS = 1_000;

/** Whether something is accepting connections on the broker endpoint. Sends nothing. */
function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect(endpoint);
	const settle = (accepted: boolean) => {
		socket.destroy();
		resolve(accepted);
	};
	socket.setTimeout(ENDPOINT_PROBE_TIMEOUT_MS, () => settle(false));
	socket.once("connect", () => settle(true));
	socket.once("error", () => settle(false));
	return promise;
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
			const verdict = classifyDaemonOwner(raw, (await fs.stat(leasePath)).mtimeMs);
			if (verdict === "alive") {
				logger.debug("Broker lease is held by a live owner; not starting a broker", { leasePath });
				return null;
			}
			if (verdict === "legacy-reused" && (await endpointAcceptsConnections(daemonBrokerEndpoint(runtimeDir)))) {
				logger.warn("Legacy broker lease looks like PID reuse by start time, but its endpoint accepts connections; keeping the owner", {
					leasePath,
				});
				return null;
			}
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
	if (!result.acquired) {
		logger.warn("Broker lease lock is contended; not starting a broker", { leasePath });
		return null;
	}
	return result.value;
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
