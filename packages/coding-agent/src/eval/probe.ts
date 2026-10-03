import { spawn } from "node:child_process";

/** Availability checks run before the eval runtime watchdog starts. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface BackendProbeOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Exercise the real interpreter probe inside the test runtime. */
	forceProbe?: boolean;
}

export interface BoundedProbeResult {
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export interface BoundedProbeSpawnOptions extends BackendProbeOptions {
	cwd: string;
	env: Record<string, string | undefined>;
}

/** No inherited console handles. Timeout and cancellation reap the interpreter. */
export async function runBoundedProbe(
	command: string[],
	{ cwd, env, signal, timeoutMs }: BoundedProbeSpawnOptions,
): Promise<BoundedProbeResult> {
	if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };
	const bound = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
	const proc = spawn(command[0], command.slice(1), { cwd, env, stdio: "ignore", windowsHide: true });
	const { promise, resolve, reject } = Promise.withResolvers<BoundedProbeResult>();
	let timedOut = false;
	let aborted = false;
	const onAbort = (): void => {
		aborted = true;
		proc.kill("SIGKILL");
	};
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, bound);
	proc.once("error", reject);
	proc.once("close", exitCode => resolve({ exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted }));
	signal?.addEventListener("abort", onAbort, { once: true });
	// Cancellation can land after spawn but before listener registration.
	if (signal?.aborted) onAbort();
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
