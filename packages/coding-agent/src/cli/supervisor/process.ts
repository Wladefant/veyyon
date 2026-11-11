import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";
import { isCompiledBinary } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import type { HeartbeatResourceSample, SessionHeartbeat, SessionPhase } from "@veyyon/utils/session-heartbeat";
import { resolveCliArgv } from "../../cli-commands";
import { type StderrStatus, startStderrCapture } from "./session-stderr";

export const RECURSION_MARKER_ENV = "VEYYON_SUPERVISED";


export interface TerminatorAttribution {
	available: false;
	reason: string;
	killerPid: null;
}

export interface DeathReport {
	pid: number;
	exitCode: number;
	signal: NodeJS.Signals | null;
	sessionId: string;
	phase: SessionPhase;
	startedAt?: string;
	heartbeatAt?: string;
	activeLanes?: number;
	lanes?: number;
	supervisorPid: number;
	supervisorCommandLine: string;
	childCommand: string;
	terminatorAttribution: TerminatorAttribution;
	stderrLogPath: string;
	stderrFiles: string[];
	stderrBytes: number;
	stderrStatus: StderrStatus;
	stderrError?: string;
	rssBytes?: number;
	freeMemBytes?: number;
	heapTotal?: number;
	heapUsed?: number;
	external?: number;
	smol?: boolean;
	forceRAMSize?: string;
	commitChargeBytes?: number;
	commitLimitBytes?: number;
	processCommitBytes?: number;
	handleCount?: number;
	consoleLogPath?: string;
	consoleCtrlStatus?: string;
	consoleCtrlInstalled?: boolean;
	resourceHistory?: HeartbeatResourceSample[];
	cgroupMemoryBytes?: number;
	cgroupMemoryMaxBytes?: number;
}

export interface SuperviseProcessOptions {
	execPath?: string;
	argv?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	logger?: { errorSync: (message: string, context?: Record<string, unknown>) => void };
	heartbeatDir?: string;
	supervisorPid?: number;
	supervisorCommandLine?: string;
	sessionStderrDir?: string;
	maxStderrLogBytes?: number;
	maxStderrLogFiles?: number;
	forwardStderr?: boolean;
	renameSync?: (oldPath: string, newPath: string) => void;
}

export interface SuperviseProcessResult {
	exitCode: number;
	reported: boolean;
	report?: DeathReport;
}
export function resolveSupervisorArgv(
	processArgv: string[] = process.argv,
	compiled: boolean = isCompiledBinary(),
): string[] {
	return processArgv.slice(compiled ? 2 : 1);
}

export function shouldSuperviseLaunch(
	argv: string[],
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
	isTTY?: { stdin?: boolean; stdout?: boolean },
	currentPpid?: number,
): boolean {
	const effectiveEnv = env ?? process.env;
	const marker = effectiveEnv[RECURSION_MARKER_ENV];
	const effectivePpid = currentPpid ?? process.ppid;
	if (
		marker !== undefined &&
		typeof effectivePpid === "number" &&
		Number.isInteger(effectivePpid) &&
		marker.trim() === String(effectivePpid)
	) {
		return false;
	}

	const first = argv[0];
	if (first?.startsWith("__veyyon_worker_") || first === "--smoke-test") return false;

	const resolved = resolveCliArgv(argv);
	if ("error" in resolved || resolved.argv[0] !== "launch") return false;

	const nonInteractive = ["--print", "-p", "--mode", "-m", "--export", "--version", "-v", "--help", "-h", "help"];
	for (const arg of argv) {
		if (
			nonInteractive.includes(arg) ||
			arg.startsWith("--mode=") ||
			arg.startsWith("-m=") ||
			arg.startsWith("--export=")
		) {
			return false;
		}
	}

	const stdinIsTTY = isTTY?.stdin ?? process.stdin.isTTY === true;
	const stdoutIsTTY = isTTY?.stdout ?? process.stdout.isTTY === true;
	return stdinIsTTY && stdoutIsTTY;
}

export async function superviseProcess(options: SuperviseProcessOptions = {}): Promise<SuperviseProcessResult> {
	const execPath = options.execPath ?? process.execPath;
	const argv = options.argv ?? resolveSupervisorArgv();
	const cwd = options.cwd ?? process.cwd();
	const parentEnv = options.env ?? process.env;
	const spawnFn = options.spawn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
	const log = options.logger ?? logger;
	const heartbeatDir = options.heartbeatDir ?? path.join(getLogsDir(), "heartbeat");
	const supervisorPid = options.supervisorPid ?? process.pid;
	const supervisorCommandLine = options.supervisorCommandLine ?? [process.execPath, ...process.argv.slice(1)].join(" ");
	const childCommand = [execPath, ...argv].join(" ");
	const attributionReason = "Child exit reports do not provide killer PID";

	let child: ChildProcess;
	try {
		child = spawnFn(execPath, argv, {
			stdio: ["inherit", "inherit", "pipe"],
			cwd,
			env: { ...parentEnv, [RECURSION_MARKER_ENV]: String(supervisorPid) },
			shell: false,
		});
	} catch {
		return { exitCode: 1, reported: false };
	}

	const capture = startStderrCapture(child, child.pid, {
		sessionStderrDir: options.sessionStderrDir,
		maxBytes: options.maxStderrLogBytes,
		maxFiles: options.maxStderrLogFiles,
		forwardStderr: options.forwardStderr,
		renameSync: options.renameSync,
	});

	let exitCode: number | null;
	let signal: NodeJS.Signals | null;
	try {
		({ exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
			(resolve, reject) => {
				child.on("error", (err) => {
					capture.recordSpawnError(err);
					reject(err);
				});
				child.on("exit", (code, sig) => resolve({ exitCode: code, signal: sig }));
			},
		));
	} catch {
		return { exitCode: 1, reported: false };
	}

	const stderr = await capture.drain();
	let numericStatus: number;
	if (exitCode !== null) numericStatus = exitCode;
	else if (signal) numericStatus = 128 + (os.constants.signals[signal] ?? 9);
	else numericStatus = 1;

	const pid = child.pid;
	const jsonPath = path.join(heartbeatDir, `${pid}.json`);
	const exitedPath = path.join(heartbeatDir, `${pid}.exited`);
	const hasTombstone = fs.existsSync(exitedPath);
	const hasJson = fs.existsSync(jsonPath);

	if (!hasJson || hasTombstone) {
		try {
			if (hasJson) fs.rmSync(jsonPath, { force: true });
			if (hasTombstone) fs.rmSync(exitedPath, { force: true });
		} catch {}
		return { exitCode: numericStatus, reported: false };
	}

	let report: DeathReport | null = null;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const beat = parsed as Partial<SessionHeartbeat>;
			if (
				typeof beat.pid === "number" &&
				typeof pid === "number" &&
				beat.pid === pid &&
				typeof beat.sessionId === "string" &&
				typeof beat.phase === "string"
			) {
				report = {
					pid: beat.pid,
					exitCode: numericStatus,
					signal,
					sessionId: beat.sessionId,
					phase: beat.phase as SessionPhase,
					startedAt: beat.startedAt,
					heartbeatAt: beat.heartbeatAt,
					activeLanes: beat.activeLanes,
					lanes: beat.lanes,
					supervisorPid,
					supervisorCommandLine,
					childCommand,
					terminatorAttribution: { available: false, reason: attributionReason, killerPid: null },
					stderrLogPath: stderr.logPath,
					stderrFiles: stderr.files,
					stderrBytes: stderr.bytesWritten,
					stderrStatus: stderr.status,
					stderrError: stderr.error,
					rssBytes: beat.rssBytes,
					freeMemBytes: beat.freeMemBytes,
					heapTotal: beat.heapTotal,
					heapUsed: beat.heapUsed,
					external: beat.external,
					smol: beat.smol,
					forceRAMSize: beat.forceRAMSize,
					commitChargeBytes: beat.commitChargeBytes,
					commitLimitBytes: beat.commitLimitBytes,
					processCommitBytes: beat.processCommitBytes,
					handleCount: beat.handleCount,
					consoleLogPath: beat.consoleLogPath,
					consoleCtrlStatus: beat.consoleCtrlStatus,
					consoleCtrlInstalled: beat.consoleCtrlInstalled,
					resourceHistory: beat.resourceHistory,
					cgroupMemoryBytes: beat.cgroupMemoryBytes,
					cgroupMemoryMaxBytes: beat.cgroupMemoryMaxBytes,
				};
			}
		}
	} catch {}

	if (report) {
		log.errorSync("Supervised session died unexpectedly", { ...report });
		try {
			fs.rmSync(jsonPath, { force: true });
			fs.rmSync(exitedPath, { force: true });
		} catch {}
		return { exitCode: numericStatus, reported: true, report };
	}
	return { exitCode: numericStatus, reported: false };
}
