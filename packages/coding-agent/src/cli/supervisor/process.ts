import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";
import { isCompiledBinary } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import type { SessionHeartbeat, SessionPhase } from "@veyyon/utils/session-heartbeat";
import { resolveCliArgv } from "../../cli-commands";

export const RECURSION_MARKER_ENV = "VEYYON_SUPERVISED";

export interface SuperviseProcessOptions {
	execPath?: string;
	argv?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	logger?: { errorSync: (message: string, context?: Record<string, unknown>) => void };
	heartbeatDir?: string;
	supervisorPid?: number;
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

	const child = spawnFn(execPath, argv, {
		stdio: "inherit",
		cwd,
		env: { ...parentEnv, [RECURSION_MARKER_ENV]: String(supervisorPid) },
		shell: false,
	});

	const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code, sig) => resolve({ exitCode: code, signal: sig }));
		},
	);

	let numericStatus: number;
	if (exitCode !== null) {
		numericStatus = exitCode;
	} else if (signal) {
		numericStatus = 128 + (os.constants.signals[signal] ?? 9);
	} else {
		numericStatus = 1;
	}

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
		const raw = fs.readFileSync(jsonPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
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
				};
			}
		}
	} catch {}

	if (report) {
		log.errorSync("Supervised session died unexpectedly", {
			pid: report.pid,
			exitCode: report.exitCode,
			signal: report.signal,
			sessionId: report.sessionId,
			phase: report.phase,
			startedAt: report.startedAt,
			heartbeatAt: report.heartbeatAt,
			activeLanes: report.activeLanes,
			lanes: report.lanes,
		});

		try {
			fs.rmSync(jsonPath, { force: true });
			fs.rmSync(exitedPath, { force: true });
		} catch {}

		return { exitCode: numericStatus, reported: true, report };
	}

	return { exitCode: numericStatus, reported: false };
}
