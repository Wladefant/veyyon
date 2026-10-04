import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
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

/** Without an endpoint witness, ambiguous wall-clock evidence must preserve a live client. */
export function daemonOwnerIsAlive(raw: unknown, recordMtimeMs?: number): boolean {
	return classifyDaemonOwner(raw, recordMtimeMs) !== "dead";
}

/** One absolute deadline for the whole ping exchange, not an inactivity timer: a trickling peer cannot extend it. */
const ENDPOINT_PROBE_DEADLINE_MS = 1_000;
/**
 * A legacy record carries no identity, so a live PID with an ambiguous start time is kept unless something
 * positive disproves it. When the endpoint stays inconclusive the record is reclaimed once it is this old:
 * a legacy broker that has answered nothing for a day is not serving anyone.
 */
const LEGACY_LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/**
 * Wall-clock boot time is itself derived from the (steppable) clock, so a record must predate it by a wide
 * margin before that counts as proof the PID belongs to an earlier boot.
 */
const LEGACY_BOOT_MARGIN_MS = 10 * 60 * 1_000;

/**
 * `owner`: an authenticated ping answered as the recorded PID.
 * `other-pid`: an authenticated ping answered as a different PID, which disproves the owner.
 * `inconclusive`: no listener, refusal, EOF, timeout, garbage, or an unreadable token.
 */
type EndpointWitness = "owner" | "other-pid" | "inconclusive";

async function brokerEndpointWitness(runtimeDir: string, ownerPid: number): Promise<EndpointWitness> {
	let token: string;
	try {
		token = (await fs.readFile(daemonBrokerTokenPath(runtimeDir), "utf8")).trim();
	} catch {
		return "inconclusive";
	}
	if (token.length === 0) return "inconclusive";
	const { promise, resolve } = Promise.withResolvers<EndpointWitness>();
	const socket = net.connect(daemonBrokerEndpoint(runtimeDir));
	const requestId = crypto.randomUUID();
	let buffered = "";
	const deadline = setTimeout(() => settle("inconclusive"), ENDPOINT_PROBE_DEADLINE_MS);
	function settle(witness: EndpointWitness) {
		clearTimeout(deadline);
		socket.destroy();
		resolve(witness);
	}
	socket.setEncoding("utf8");
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ id: requestId, token, operation: { op: "ping" } })}\n`);
	});
	socket.once("error", () => settle("inconclusive"));
	socket.once("close", () => settle("inconclusive"));
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		const newline = buffered.indexOf("\n");
		if (newline < 0) return;
		try {
			const reply: unknown = JSON.parse(buffered.slice(0, newline));
			if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== requestId) {
				return settle("inconclusive");
			}
			if (!("ok" in reply) || reply.ok !== true || !("result" in reply)) return settle("inconclusive");
			const result = reply.result;
			if (typeof result !== "object" || result === null || !("op" in result) || result.op !== "ping") {
				return settle("inconclusive");
			}
			// A broker built before the ping carried its PID proves only that it holds this runtime's token.
			const pid = "pid" in result && typeof result.pid === "number" ? result.pid : ownerPid;
			settle(pid === ownerPid ? "owner" : "other-pid");
		} catch {
			settle("inconclusive");
		}
	});
	return promise;
}

/** Injectable time sources; both default to the real system clock. */
export interface BrokerLeaseClock {
	now?: () => number;
	bootTimeMs?: () => number;
}

/** A stale record can be removed without retiring a scope that a replacement broker serves. */
export type DaemonOwnerRetirement = "keep" | "retire-record" | "retire-scope";

/** Shared retirement evidence for lease acquisition and runtime pruning. */
export async function daemonOwnerRetirement(
	runtimeDir: string,
	raw: unknown,
	recordMtimeMs: number,
	clock: BrokerLeaseClock = {},
): Promise<DaemonOwnerRetirement> {
	const verdict = classifyDaemonOwner(raw, recordMtimeMs);
	const record = raw as { pid?: unknown; processIdentity?: unknown } | undefined;
	if (verdict === "alive" && typeof record?.processIdentity === "string") return "keep";
	const pid = typeof record?.pid === "number" ? record.pid : 0;
	// An authenticated endpoint overrides clock evidence even when the recorded
	// process is dead: another PID proves a stale record, not a dead runtime.
	const witness = await brokerEndpointWitness(runtimeDir, pid);
	// A reused PID can answer as the same number, but cannot restore the old identity.
	if (verdict === "dead" && witness !== "inconclusive") return "retire-record";
	if (witness === "owner") return "keep";
	if (witness === "other-pid") return "retire-record";
	if (verdict === "dead") return "retire-scope";
	const now = clock.now ?? Date.now;
	const bootTimeMs = clock.bootTimeMs ?? (() => Date.now() - os.uptime() * 1_000);
	return recordMtimeMs < bootTimeMs() - LEGACY_BOOT_MARGIN_MS || now() - recordMtimeMs > LEGACY_LEASE_MAX_AGE_MS
		? "retire-scope"
		: "keep";
}

export async function acquireBrokerLease(
	runtimeDir: string,
	clock: BrokerLeaseClock = {},
): Promise<BrokerLease | null> {
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
			const recordMtimeMs = (await fs.stat(leasePath)).mtimeMs;
			if ((await daemonOwnerRetirement(runtimeDir, raw, recordMtimeMs, clock)) === "keep") {
				logger.debug("Broker lease owner is alive and not disproved; not starting a broker", { leasePath });
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
