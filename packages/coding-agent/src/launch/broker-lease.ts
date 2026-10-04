import * as fs from "node:fs/promises";
import * as net from "node:net";
import { atomicWriteFile, isEnoent, logger } from "@veyyon/utils";
import { tryWithFileLock, withFileLock } from "@veyyon/utils/file-lock";
import { getProcessStartIdentity, getProcessStartTime, isProcessInstanceAlive } from "@veyyon/utils/process-liveness";
import { daemonBrokerEndpoint, daemonBrokerLeasePath, daemonBrokerTokenPath } from "./paths";

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

/**
 * `owner`: the endpoint answered an authenticated ping as the recorded PID.
 * `impostor`: something answered, and it is provably not that broker.
 * `unknown`: no listener, a refused or timed-out connection, or an unreadable token. A live PID with an
 * ambiguous start time is never taken over on `unknown`; only an `impostor` disproves the owner.
 */
type EndpointWitness = "owner" | "impostor" | "unknown";

async function brokerEndpointWitness(runtimeDir: string, ownerPid: number): Promise<EndpointWitness> {
	let token: string;
	try {
		token = (await fs.readFile(daemonBrokerTokenPath(runtimeDir), "utf8")).trim();
	} catch {
		return "unknown";
	}
	if (token.length === 0) return "unknown";
	const { promise, resolve } = Promise.withResolvers<EndpointWitness>();
	const socket = net.connect(daemonBrokerEndpoint(runtimeDir));
	const requestId = crypto.randomUUID();
	let buffered = "";
	const settle = (witness: EndpointWitness) => {
		socket.destroy();
		resolve(witness);
	};
	socket.setEncoding("utf8");
	socket.setTimeout(ENDPOINT_PROBE_TIMEOUT_MS, () => settle("unknown"));
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ id: requestId, token, operation: { op: "ping" } })}\n`);
	});
	socket.once("error", () => settle("unknown"));
	socket.once("close", () => settle("impostor"));
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		const newline = buffered.indexOf("\n");
		if (newline < 0) return;
		try {
			const reply: unknown = JSON.parse(buffered.slice(0, newline));
			if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== requestId) {
				return settle("impostor");
			}
			if (!("ok" in reply) || reply.ok !== true || !("result" in reply)) return settle("impostor");
			const result = reply.result;
			if (typeof result !== "object" || result === null || !("op" in result) || result.op !== "ping") {
				return settle("impostor");
			}
			// A broker built before the ping carried its PID proves only that it holds this runtime's token.
			const pid = "pid" in result && typeof result.pid === "number" ? result.pid : ownerPid;
			settle(pid === ownerPid ? "owner" : "impostor");
		} catch {
			settle("impostor");
		}
	});
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
			if (verdict === "legacy-reused") {
				const record = raw as { pid: number };
				const witness = await brokerEndpointWitness(runtimeDir, record.pid);
				if (witness !== "impostor") {
					logger.warn(
						"Legacy broker lease looks like PID reuse by start time, but its owner is alive and not disproved; keeping the owner",
						{ leasePath, witness },
					);
					return null;
				}
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
